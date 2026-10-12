//! Search pipeline: Bing SERP + site APIs, blocklist/weight filtering, windowed
//! parallel page fetching, confidence scoring and package assembly.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::Value;

use crate::adapters;
use crate::embed::{Embedder, Kind};
use crate::protocol::*;
use crate::store::{CachedPage, Store};
use crate::text::{self, PageKind, SearchResult};
use crate::weights;

const BING_HOME: &str = "https://cn.bing.com/";
const BING_SEARCH: &str = "https://cn.bing.com/search";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MIN_BING_GAP: Duration = Duration::from_millis(1200);
const MIN_HOST_GAP: Duration = Duration::from_millis(120);
const MAX_JITTER_MS: u64 = 400;
const SESSION_REFRESH: Duration = Duration::from_secs(30 * 60);
const PAGE_CACHE_TTL_MS: i64 = 6 * 60 * 60 * 1000;
const MAX_STORED_CONTENT: usize = 10_000;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

const DEFAULT_COUNT: usize = 8;
const MAX_QUERIES: usize = 4;
const MAX_COUNT: usize = 20;
const DEFAULT_CONTENT_TOP: usize = 8;
const DEFAULT_CONTENT_CHARS: usize = 1000;
const SITE_CONCURRENCY: usize = 6;

fn content_concurrency() -> usize {
    env_usize("PI_WS_CONTENT_CONCURRENCY", 16)
}

/// 内容阶段等待窗口：窗口内并行完成多少页就带多少页
fn content_wait_ms() -> u64 {
    env_usize("PI_WS_CONTENT_WAIT_MS", 1500) as u64
}

/// 去重与合并用的 URL 归一：忽略 host 大小写、fragment 与末尾斜杠
fn normalize_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            let _ = parsed.set_fragment(None);
            let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
            format!("{host}{}?{}", parsed.path().trim_end_matches('/'), parsed.query().unwrap_or_default())
        }
        Err(_) => url.to_string(),
    }
}

fn is_bing_host(host: &str) -> bool {
    host == "bing.com" || host.ends_with(".bing.com")
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase())).unwrap_or_default()
}

// ---------------------------------------------------------------- HTTP layer

/// 伪装 + 限速 + 抓取。可克隆共享（reqwest::Client 内部是 Arc）。
pub struct Fetcher {
    client: reqwest::Client,
    db_path: PathBuf,
    host_last_at: Arc<Mutex<HashMap<String, Instant>>>,
    warmed_at: Arc<Mutex<Option<Instant>>>,
    warmup: Arc<tokio::sync::Mutex<()>>,
}

impl Clone for Fetcher {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            db_path: self.db_path.clone(),
            host_last_at: self.host_last_at.clone(),
            warmed_at: self.warmed_at.clone(),
            warmup: self.warmup.clone(),
        }
    }
}

impl Fetcher {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(UA)
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(12))
            .build()
            .context("构建 HTTP 客户端失败")?;
        Ok(Self {
            client,
            db_path,
            host_last_at: Arc::new(Mutex::new(HashMap::new())),
            warmed_at: Arc::new(Mutex::new(None)),
            warmup: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// 同主机保持间隔 + 抖动（Bing 更保守）
    async fn pace(&self, host: &str) {
        let (gap, jitter) = if is_bing_host(host) {
            (MIN_BING_GAP, MAX_JITTER_MS)
        } else {
            (MIN_HOST_GAP, MAX_JITTER_MS / 3)
        };
        let jitter = Duration::from_millis(if jitter == 0 { 0 } else { fastrand(jitter) });
        let wait = {
            let map = self.host_last_at.lock().unwrap();
            map.get(host).map(|last| gap.saturating_sub(last.elapsed())).unwrap_or_default()
        };
        let total = wait + jitter;
        if !total.is_zero() {
            tokio::time::sleep(total).await;
        }
        self.host_last_at.lock().unwrap().insert(host.to_string(), Instant::now());
    }

    /// Bing 会话预热（收 cookie）；并发调用只跑一次
    pub async fn ensure_bing_session(&self) {
        {
            let warmed = self.warmed_at.lock().unwrap();
            if warmed.map(|t| t.elapsed() < SESSION_REFRESH).unwrap_or(false) {
                return;
            }
        }
        let _guard = self.warmup.lock().await;
        {
            let warmed = self.warmed_at.lock().unwrap();
            if warmed.map(|t| t.elapsed() < SESSION_REFRESH).unwrap_or(false) {
                return;
            }
        }
        if self.get(BING_HOME, None, "none").await.is_ok() {
            *self.warmed_at.lock().unwrap() = Some(Instant::now());
        }
    }

    async fn get(&self, url: &str, referer: Option<&str>, sec_fetch_site: &str) -> Result<(u16, String, String)> {
        self.request(reqwest::Method::GET, url, referer, sec_fetch_site, None).await
    }

    async fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        referer: Option<&str>,
        sec_fetch_site: &str,
        body: Option<Value>,
    ) -> Result<(u16, String, String)> {
        let host = host_of(url);
        self.pace(&host).await;
        let mut req = self
            .client
            .request(method, url)
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Upgrade-Insecure-Requests", "1")
            .header("Sec-Fetch-Site", sec_fetch_site)
            .header("Sec-Fetch-Mode", if body.is_some() { "cors" } else { "navigate" })
            .header("Sec-Fetch-Dest", if body.is_some() { "empty" } else { "document" })
            .header("sec-ch-ua", "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"")
            .header("sec-ch-ua-mobile", "?0")
            .header("sec-ch-ua-platform", "\"Linux\"");
        if body.is_some() {
            req = req.header("Accept", "application/json, text/plain, */*").header("Sec-Fetch-User", "?1");
        } else {
            req = req.header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
            req = req.header("Sec-Fetch-User", "?1");
        }
        if let Some(r) = referer {
            req = req.header("Referer", r);
        }
        if let Some(origin) = referer.and_then(|r| url::Url::parse(r).ok()).and_then(|u| u.origin().ascii_serialization().into()) {
            if body.is_some() {
                req = req.header("Origin", origin);
            }
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.context("请求失败")?;
        let status = res.status().as_u16();
        let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let text = res.text().await.unwrap_or_default();
        Ok((status, text, content_type))
    }

    fn db(&self) -> Result<Store> {
        Store::open(&self.db_path, None)
    }

    /// 抓一页正文：命中缓存直接用；否则抓取 + 抽取 + 写缓存（向量稍后统一补）
    pub async fn fetch_page_core(&self, url: &str, referer: Option<&str>) -> PageContent {
        if let Ok(store) = self.db() {
            if let Ok(Some(cached)) = store.cached_page(url, PAGE_CACHE_TTL_MS) {
                return PageContent {
                    ok: true,
                    title: cached.title,
                    core_text: cached.core_text.clone(),
                    published: None,
                    error: if cached.core_text.is_empty() { Some("缓存正文为空".into()) } else { None },
                    chars: cached.core_text.chars().count(),
                };
            }
        }
        match self.get(url, referer, "cross-site").await {
            Ok((status, body, content_type)) if (200..300).contains(&status) => {
                if is_unsupported_type(&content_type) {
                    return failed(format!("不支持的内容类型 {}", content_type.split(';').next().unwrap_or("")));
                }
                let is_html = content_type.contains("text/html") || body.trim_start().starts_with("<!doctype") || body.trim_start().starts_with("<html");
                if is_html && text::looks_like_challenge(&body) {
                    return failed("反爬验证页（Cloudflare / Anubis 拦截）".into());
                }
                let published = if is_html { text::date_from_html(&body) } else { None };
                let (title, core) = if is_html {
                    (text::extract_title(&body), text::html_to_text(&body))
                } else {
                    (String::new(), body)
                };
                let stored: String = core.chars().take(MAX_STORED_CONTENT).collect();
                if !stored.is_empty() {
                    if let Ok(store) = self.db() {
                        let _ = store.put_cached_page(
                            &CachedPage { url: url.to_string(), title: title.clone(), core_text: stored.clone(), content_type: Some(content_type.clone()), fetched_at: 0 },
                            None,
                            None,
                        );
                    }
                }
                let mut error = if stored.is_empty() { Some("正文为空（可能是脚本渲染页或反爬拦截）".into()) } else { None };
                if error.is_none() && stored.chars().count() < 200 {
                    error = Some("正文过短（疑似栏目页/空页）".into());
                }
                PageContent { ok: true, title, chars: stored.chars().count(), core_text: stored, published, error }
            }
            Ok((status, _, _)) => failed(format!("HTTP {status}")),
            Err(err) => failed(format!("{err}")),
        }
    }
}

fn failed(msg: String) -> PageContent {
    PageContent { ok: false, title: String::new(), core_text: String::new(), published: None, error: Some(msg), chars: 0 }
}

fn is_unsupported_type(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim();
    ct.starts_with("image/") || ct.starts_with("audio/") || ct.starts_with("video/")
        || matches!(ct, "application/pdf" | "application/zip" | "application/octet-stream")
}

fn fastrand(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    nanos % max
}

/// 默认排序：发布时间倒序（越近越前）；引擎没给日期的排在有日期的之后，组内保持引擎原序
fn sort_by_recency(kept: &mut [PackagedResult]) {
    kept.sort_by(|a, b| match (a.published.as_deref(), b.published.as_deref()) {
        (Some(x), Some(y)) => y.cmp(x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

// ---------------------------------------------------------------- site adapters

/// 各平台原生 API 的请求构造（URL 模板 + 可选 POST body）
fn site_request(kind: &str, site: Option<&str>, query: &str) -> Option<(String, Option<Value>, String, String)> {
    let q = urlencode(query);
    let (url, body, referer, origin) = match kind {
        "github" => (
            format!("https://api.github.com/search/repositories?q={q}&per_page=8"),
            None,
            "https://github.com/".to_string(),
            "https://github.com".to_string(),
        ),
        "gitlab" => (format!("https://gitlab.com/api/v4/projects?search={q}&per_page=8"), None, "https://gitlab.com/".into(), "https://gitlab.com".into()),
        "npm" => (format!("https://registry.npmjs.org/-/v1/search?text={q}&size=8"), None, "https://www.npmjs.com/".into(), "https://www.npmjs.com".into()),
        "crates" => (format!("https://crates.io/api/v1/crates?q={q}&per_page=8"), None, "https://crates.io/".into(), "https://crates.io".into()),
        "mdn" => (format!("https://developer.mozilla.org/api/v1/search?q={q}&locale=zh-CN"), None, "https://developer.mozilla.org/".into(), "https://developer.mozilla.org".into()),
        "stackexchange" => {
            let site = site.unwrap_or("stackoverflow");
            (
                format!("https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={q}&site={site}"),
                None,
                format!("https://{site}.com/"),
                format!("https://{site}.com"),
            )
        }
        "hn" => (format!("https://hn.algolia.com/api/v1/search?query={q}&hitsPerPage=8"), None, "https://news.ycombinator.com/".into(), "https://news.ycombinator.com".into()),
        "juejin" => (
            "https://api.juejin.cn/search_api/v1/search".to_string(),
            Some(serde_json::json!({ "key_word": query, "id_type": 0, "cursor": "0", "limit": 8, "search_type": 0 })),
            "https://juejin.cn/".into(),
            "https://juejin.cn".into(),
        ),
        "csdn" => (format!("https://so.csdn.net/api/v3/search?q={q}&t=all&p=1"), None, format!("https://so.csdn.net/so/search?q={q}"), "https://so.csdn.net".into()),
        "openalex" => (format!("https://api.openalex.org/works?search={q}&per_page=8"), None, "https://openalex.org/".into(), "https://openalex.org".into()),
        "crossref" => (format!("https://api.crossref.org/works?query={q}&rows=8"), None, "https://www.crossref.org/".into(), "https://www.crossref.org".into()),
        "arxiv" => (format!("https://export.arxiv.org/api/query?search_query=all:{q}&max_results=8"), None, "https://arxiv.org/".into(), "https://arxiv.org".into()),
        "openreview" => (
            format!("https://api2.openreview.net/notes/search?term={q}&source=forum&limit=8"),
            None,
            "https://openreview.net/".into(),
            "https://openreview.net".into(),
        ),
        // 期刊级检索：site = ISSN
        "openalex-venue" => (
            format!(
                "https://api.openalex.org/works?filter=primary_location.source.issn:{}&search={q}&per-page=8",
                site.unwrap_or_default()
            ),
            None,
            "https://openalex.org/".into(),
            "https://openalex.org".into(),
        ),
        _ => return None,
    };
    Some((url, body, referer, origin))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn parse_site_response(kind: &str, body: &str) -> Vec<SearchResult> {
    match kind {
        "arxiv" => adapters::parse_arxiv(body),
        _ => {
            let Ok(json) = serde_json::from_str::<Value>(body) else { return vec![] };
            match kind {
                "github" => adapters::parse_github(&json),
                "gitlab" => adapters::parse_gitlab(&json),
                "npm" => adapters::parse_npm(&json),
                "crates" => adapters::parse_crates(&json),
                "mdn" => adapters::parse_mdn(&json),
                "stackexchange" => adapters::parse_stackexchange(&json),
                "hn" => adapters::parse_hn(&json),
                "juejin" => adapters::parse_juejin(&json),
                "csdn" => adapters::parse_csdn(&json),
                "openalex" => adapters::parse_openalex(&json),
                "openalex-venue" => adapters::parse_openalex(&json),
                "crossref" => adapters::parse_crossref(&json),
                "openreview" => adapters::parse_openreview(&json),
                _ => vec![],
            }
        }
    }
}

// ---------------------------------------------------------------- engine

pub struct Engine {
    pub fetcher: Fetcher,
    pub store: Store,
    pub embedder: Embedder,
}

impl Engine {
    pub fn new(db_path: PathBuf, legacy_json: Option<PathBuf>, model: Option<&str>) -> Result<Self> {
        let store = Store::open(&db_path, legacy_json.as_deref())?;
        let embedder = crate::embed::build(model);
        let fetcher = Fetcher::new(db_path)?;
        Ok(Self { fetcher, store, embedder })
    }

    pub async fn search(&mut self, params: SearchParams) -> Result<SearchPackage> {
        let started = Instant::now();
        let query = params.query.trim().to_string();
        if query.is_empty() {
            anyhow::bail!("query 不能为空");
        }
        // 多查询：query + queries（去重、最多 4 条）并发检索后轮询合并
        let mut queries: Vec<String> = vec![query.clone()];
        for extra in params.queries.clone().unwrap_or_default() {
            let extra = extra.trim().to_string();
            if !extra.is_empty() && !queries.contains(&extra) {
                queries.push(extra);
            }
        }
        queries.truncate(MAX_QUERIES);

        let count = params.count.unwrap_or(DEFAULT_COUNT).min(MAX_COUNT).max(1);
        let offset = params.offset.unwrap_or(0);
        // 默认不抓正文：要正文让模型明确要，或改用 web_fetch（这是延迟的大头）
        let include_content = params.include_content.unwrap_or(false);
        let content_top = params.content_top.unwrap_or(DEFAULT_CONTENT_TOP);
        let content_chars = params.content_chars.unwrap_or(DEFAULT_CONTENT_CHARS).min(5000);
        let min_weight = params.min_weight;
        let sort_by_time = params.sort_by.as_deref().unwrap_or("time") != "relevance";
        let recency_days = params.recency_days;
        let domains = params.domains.clone().unwrap_or_default();
        let exclude_domains = params.exclude_domains.clone().unwrap_or_default();
        let weights = self.store.load_weights()?;

        // 站内直达 or Bing 全网
        let site_tokens = params.sites.clone().unwrap_or_default();
        let resolved: Vec<(String, weights::SiteEntry)> = if site_tokens.is_empty() {
            Vec::new()
        } else {
            weights::resolve_sites(&weights, &site_tokens).into_iter().map(|(alias, entry)| (alias, entry.clone())).collect()
        };
        if !site_tokens.is_empty() && resolved.is_empty() {
            let available: Vec<String> = weights
                .sites
                .iter()
                .map(|(alias, e)| format!("{alias}({})", if e.tags.is_empty() { e.domain.clone() } else { e.tags.iter().take(3).cloned().collect::<Vec<_>>().join("/") }))
                .collect();
            anyhow::bail!("sites 未匹配到任何站点（{}）。可用：{}", site_tokens.join(", "), available.join("、"));
        }

        let serp_started = Instant::now();
        let mut tasks = Vec::new();
        for one in &queries {
            let fetcher = self.fetcher.clone();
            let resolved = resolved.clone();
            let one = one.clone();
            tasks.push(tokio::spawn(async move { gather_one(&fetcher, &resolved, &one, offset).await }));
        }
        let mut per_query: Vec<Vec<(SearchResult, String)>> = Vec::new();
        let mut engines: Vec<String> = Vec::new();
        let mut sites_used: Option<Vec<String>> = None;
        let mut failures: Vec<String> = Vec::new();
        for (index, task) in tasks.into_iter().enumerate() {
            match task.await {
                Ok(Ok(gathered)) => {
                    if !engines.contains(&gathered.engine) {
                        engines.push(gathered.engine);
                    }
                    if sites_used.is_none() {
                        sites_used = gathered.sites;
                    }
                    per_query.push(gathered.candidates);
                }
                Ok(Err(err)) => failures.push(format!("{}: {err}", queries[index])),
                Err(err) => failures.push(format!("{}: 任务失败 {err}", queries[index])),
            }
        }
        if per_query.is_empty() {
            anyhow::bail!("检索失败：{}", failures.join("; "));
        }
        for failure in &failures {
            eprintln!("[pi-web-search] 查询失败（已跳过）：{failure}");
        }
        let engine_name = engines.join("+");

        // 轮询合并 + URL 去重：每个查询的第一条并排，避免单查询霸榜
        let mut seen: HashSet<String> = HashSet::new();
        let mut candidates: Vec<(SearchResult, String)> = Vec::new();
        let longest = per_query.iter().map(|list| list.len()).max().unwrap_or(0);
        for rank in 0..longest {
            for list in &per_query {
                if let Some((item, via)) = list.get(rank) {
                    if seen.insert(normalize_url(&item.url)) {
                        candidates.push((item.clone(), via.clone()));
                    }
                }
            }
        }
        let serp_ms = serp_started.elapsed().as_millis() as u64;

        // 只留内容页 → 黑名单 → 权重 → 按时间排序 → 截断
        let mut dropped: Vec<DroppedResult> = Vec::new();
        let mut kept: Vec<PackagedResult> = Vec::new();
        for (r, via) in candidates {
            let host = host_of(&r.url);
            let (weight, key) = weights::match_weight(&weights, &host);
            let kind = text::classify_page_url(&r.url);
            if kind != PageKind::Content {
                let reason = if kind == PageKind::Homepage { "首页（非内容页）" } else { "列表页（非内容页）" };
                dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason: reason.to_string() });
                continue;
            }
            if let Some(reason) = weights::check_blocked(&weights, &r) {
                dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason });
                continue;
            }
            if !domains.is_empty() && !domains.iter().any(|pattern| weights::domain_matches(&host, pattern)) {
                dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason: "不在 domains 白名单".into() });
                continue;
            }
            if exclude_domains.iter().any(|pattern| weights::domain_matches(&host, pattern)) {
                dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason: "命中 excludeDomains".into() });
                continue;
            }
            if let Some(days) = recency_days {
                if let Some(published) = &r.published {
                    if text::older_than(published, days) {
                        let reason = format!("早于 recencyDays={days}（{published}）");
                        dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason });
                        continue;
                    }
                }
            }
            if let Some(mw) = min_weight {
                if weight < mw {
                    dropped.push(DroppedResult { title: r.title, url: r.url, weight, reason: format!("信源权重低于 minWeight={mw}") });
                    continue;
                }
            }
            kept.push(PackagedResult {
                rank: kept.len() + 1,
                title: r.title,
                url: r.url,
                weight: weights::round_to(weight, 3),
                weight_source: key,
                via,
                snippet: r.snippet,
                published: r.published,
                content: None,
                confidence: None,
                relevance: None,
                support: None,
                recency: None,
            });
        }
        if sort_by_time {
            sort_by_recency(&mut kept);
        }
        kept.truncate(count);
        for (i, r) in kept.iter_mut().enumerate() {
            r.rank = i + 1;
        }
        if kept.is_empty() {
            anyhow::bail!(
                "全部结果被过滤（{}）",
                dropped.iter().map(|d| format!("{}: {}", host_of(&d.url), d.reason)).collect::<Vec<_>>().join("; ")
            );
        }

        // 窗口内并行抓取
        let content_started = Instant::now();
        let mut fetch_list: Vec<usize> = Vec::new();
        if include_content && content_top > 0 {
            fetch_list = (0..kept.len().min(content_top)).collect();
            let slots: Arc<Mutex<Vec<Option<PageContent>>>> = Arc::new(Mutex::new(vec![None; fetch_list.len()]));
            let done = Arc::new(AtomicUsize::new(0));
            let sem = Arc::new(tokio::sync::Semaphore::new(content_concurrency()));
            let total = fetch_list.len();
            let mut handles = Vec::new();
            for (slot_idx, result_idx) in fetch_list.iter().enumerate() {
                let url = kept[*result_idx].url.clone();
                let fetcher = self.fetcher.clone();
                let slots = slots.clone();
                let done = done.clone();
                let sem = sem.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = sem.acquire().await;
                    let page = fetcher.fetch_page_core(&url, Some(BING_HOME)).await;
                    slots.lock().unwrap()[slot_idx] = Some(page);
                    done.fetch_add(1, Ordering::SeqCst);
                }));
            }
            // 等到窗口结束（后台任务继续跑，完成的内容会写进缓存）；budgetMs 收紧窗口
            let wait_ms = content_wait_ms().min(params.budget_ms.unwrap_or(u64::MAX));
            let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
            while done.load(Ordering::SeqCst) < total {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            let slots = slots.lock().unwrap();
            for (slot_idx, result_idx) in fetch_list.iter().enumerate() {
                let content = match slots[slot_idx].clone() {
                    Some(c) => c,
                    None => failed(format!("未在 {wait_ms}ms 等待窗口内返回（后台仍在抓，已写入缓存）")),
                };
                kept[*result_idx].content = Some(content);
            }
        }
        let content_ms = content_started.elapsed().as_millis() as u64;

        // 引擎没给日期的，用页面自带时间补上，再按时间重排一次（内容跟着结果走）
        for r in kept.iter_mut() {
            if r.published.is_none() {
                r.published = r.content.as_ref().and_then(|c| c.published.clone());
            }
            r.recency = Some(weights::round_to(text::recency_score(r.published.as_deref()), 3));
        }
        if sort_by_time {
            sort_by_recency(&mut kept);
        }
        for (i, r) in kept.iter_mut().enumerate() {
            r.rank = i + 1;
        }

        // 置信度：相关性 + 信源权重 + 多源印证（同批内、跨域名）+ 新鲜度
        let embed_started = Instant::now();
        let mut vectors: Vec<Option<Vec<f32>>> = vec![None; kept.len()];
        let texts: Vec<String> = kept
            .iter()
            .map(|r| match &r.content {
                Some(c) if c.ok && !c.core_text.is_empty() => {
                    let head: String = c.core_text.chars().take(1500).collect();
                    format!("{}\n{}", c.title, head)
                }
                _ => String::new(),
            })
            .collect();
        let idx_with_text: Vec<usize> = texts.iter().enumerate().filter(|(_, t)| !t.is_empty()).map(|(i, _)| i).collect();
        if !idx_with_text.is_empty() {
            let payload: Vec<String> = idx_with_text.iter().map(|i| texts[*i].clone()).collect();
            let query_vec = self.embedder.embed(&[query.clone()], Kind::Query)?.into_iter().next().unwrap_or_default();
            let page_vecs = self.embedder.embed(&payload, Kind::Passage)?;
            let threshold = self.embedder.support_threshold();
            for (n, idx) in idx_with_text.iter().enumerate() {
                let page_vec = page_vecs.get(n).cloned().unwrap_or_default();
                let relevance = weights::relevance_score(&query_vec, &page_vec, self.embedder.is_semantic());
                let host = host_of(&kept[*idx].url);
                let mut domains: HashSet<String> = HashSet::new();
                for (m, other_idx) in idx_with_text.iter().enumerate() {
                    if other_idx == idx {
                        continue;
                    }
                    let other_host = host_of(&kept[*other_idx].url);
                    if other_host == host {
                        continue;
                    }
                    if weights::cosine_sim(&page_vec, &page_vecs[m]) >= threshold {
                        domains.insert(other_host);
                    }
                }
                kept[*idx].relevance = Some(weights::round_to(relevance, 3));
                kept[*idx].support = Some(domains.len());
                let recency = kept[*idx].recency.unwrap_or(0.5);
                kept[*idx].confidence = Some(weights::score_confidence(relevance, kept[*idx].weight, domains.len(), recency));
                // 顺带把向量补进缓存（抓取期没算）
                if let Some(content) = &kept[*idx].content {
                    if content.ok && !content.core_text.is_empty() {
                        let embedder_id = self.embedder.id();
                        let _ = self.store.ensure_vec_table(embedder_id, page_vec.len());
                        let _ = self.store.put_cached_page(
                            &CachedPage {
                                url: kept[*idx].url.clone(),
                                title: content.title.clone(),
                                core_text: content.core_text.clone(),
                                content_type: None,
                                fetched_at: 0,
                            },
                            Some(&page_vec),
                            Some(embedder_id),
                        );
                    }
                }
                vectors[*idx] = Some(page_vec);
            }
        }
        let embed_ms = embed_started.elapsed().as_millis() as u64;

        let fetched_pages = kept.iter().filter(|r| r.content.as_ref().map(|c| c.ok).unwrap_or(false)).count();
        let failed_pages = kept.iter().filter(|r| r.content.is_some() && !r.content.as_ref().unwrap().ok).count();

        let pkg = SearchPackage {
            query: query.clone(),
            engine: engine_name,
            fetched_at: now_rfc3339(),
            results: kept,
            dropped,
            meta: PackageMeta {
                count,
                offset,
                include_content,
                content_top: fetch_list.len(),
                content_chars,
                min_weight,
                fetched_pages,
                failed_pages,
                sites: sites_used,
                queries: queries.clone(),
                sort_by: if sort_by_time { "time".to_string() } else { "relevance".to_string() },
                recency_days,
                domains: if domains.is_empty() { None } else { Some(domains.clone()) },
                exclude_domains: if exclude_domains.is_empty() { None } else { Some(exclude_domains.clone()) },
                timings: Timings {
                    serp_ms,
                    content_ms,
                    embed_ms,
                    total_ms: started.elapsed().as_millis() as u64,
                },
            },
        };
        let params_json = serde_json::to_string(&params).unwrap_or_default();
        let _ = self.store.record_search(&pkg, &params_json);
        Ok(pkg)
    }

    /// 单页抓取（web_fetch 工具）
    pub async fn fetch_one(&mut self, params: FetchParams) -> Result<FetchPackage> {
        let max_chars = params.max_chars.unwrap_or(20_000).min(100_000);
        let parsed = url::Url::parse(params.url.trim()).context("无效 URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("仅支持 http/https，收到 {}", parsed.scheme());
        }
        let weights = self.store.load_weights()?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let (weight, key) = weights::match_weight(&weights, &host);

        let page = match self.store.cached_page(parsed.as_str(), PAGE_CACHE_TTL_MS)? {
            Some(cached) => PageContent {
                ok: true,
                title: cached.title,
                core_text: cached.core_text.clone(),
                published: None,
                error: None,
                chars: cached.core_text.chars().count(),
            },
            None => self.fetcher.fetch_page_core(parsed.as_str(), None).await,
        };
        if !page.ok {
            anyhow::bail!("web_fetch: {}", page.error.unwrap_or_else(|| "抓取失败".into()));
        }
        // 页内定位：先按 find / fromLine 切行，再套 maxChars
        let lines: Vec<&str> = page.core_text.lines().collect();
        let total_lines = lines.len();
        let start = params.from_line.unwrap_or(1).max(1) - 1;
        let pattern = params.find.as_deref().map(str::trim).filter(|p| !p.is_empty());
        let (body, matched_lines) = match pattern {
            Some(pattern) => select_matching_lines(&lines, pattern, start),
            None => (lines[start.min(lines.len())..].join("\n"), None),
        };
        let truncated = body.chars().count() > max_chars;
        let shown: String = body.chars().take(max_chars).collect();
        Ok(FetchPackage {
            url: parsed.to_string(),
            final_url: parsed.to_string(),
            title: page.title,
            weight: weights::round_to(weight, 3),
            weight_source: key,
            content_type: "text/html".to_string(),
            core_text: shown,
            chars: page.chars,
            truncated,
            total_lines,
            matched_lines,
        })
    }
}

/// 取命中 `pattern` 的行（行号 + 前后各一行上下文），行号按原页从 1 数
fn select_matching_lines(lines: &[&str], pattern: &str, start: usize) -> (String, Option<usize>) {
    const MAX_HITS: usize = 60;
    let needle = pattern.to_lowercase();
    let mut hits: Vec<usize> = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(start) {
        if line.to_lowercase().contains(&needle) {
            if hits.len() == MAX_HITS {
                break;
            }
            hits.push(index);
        }
    }
    if hits.is_empty() {
        return (String::new(), Some(0));
    }
    let mut wanted: Vec<usize> = Vec::new();
    for hit in &hits {
        for offset in [-1i64, 0, 1] {
            let index = *hit as i64 + offset;
            if index >= 0 && (index as usize) < lines.len() && !wanted.contains(&(index as usize)) {
                wanted.push(index as usize);
            }
        }
    }
    wanted.sort_unstable();
    let body = wanted.iter().map(|index| format!("{}: {}", index + 1, lines[*index].trim())).collect::<Vec<_>>().join("\n");
    (body, Some(hits.len()))
}

/// 一条查询的候选集（站内直达 or Bing 全网），不同查询之间可以并发跑
struct Gathered {
    candidates: Vec<(SearchResult, String)>,
    engine: String,
    sites: Option<Vec<String>>,
}

async fn gather_one(
    fetcher: &Fetcher,
    resolved: &[(String, weights::SiteEntry)],
    query: &str,
    offset: usize,
) -> Result<Gathered> {
    if resolved.is_empty() {
        fetcher.ensure_bing_session().await;
        let results = fetch_bing_serp(fetcher, query, offset).await?;
        return Ok(Gathered {
            candidates: results.into_iter().map(|r| (r, "bing".to_string())).collect(),
            engine: "bing".to_string(),
            sites: None,
        });
    }

    let engine = resolved.iter().map(|(alias, _)| alias.clone()).collect::<Vec<_>>().join("+");
    let sites = Some(resolved.iter().map(|(alias, _)| alias.clone()).collect());
    let api_sites: Vec<(String, weights::SiteEntry)> = resolved.iter().filter(|(_, entry)| entry.search.kind != "bing-site").cloned().collect();
    let bing_sites: Vec<(String, weights::SiteEntry)> = resolved.iter().filter(|(_, entry)| entry.search.kind == "bing-site").cloned().collect();

    let mut per_site: Vec<Vec<(SearchResult, String)>> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for (alias, outcome) in search_api_sites(fetcher, &api_sites, query).await {
        match outcome {
            Ok(results) => per_site.push(results.into_iter().map(|r| (r, alias.clone())).collect()),
            Err(err) => failures.push(format!("{alias}: {err}")),
        }
    }
    if !bing_sites.is_empty() {
        let domains: Vec<String> = bing_sites.iter().map(|(_, entry)| entry.domain.clone()).collect();
        match fetch_bing_scoped(fetcher, &domains, query).await {
            Ok(results) => {
                for (alias, entry) in &bing_sites {
                    let filtered = adapters::filter_to_domain(results.clone(), &entry.domain);
                    per_site.push(filtered.into_iter().take(8).map(|r| (r, alias.clone())).collect());
                }
            }
            Err(err) => failures.push(format!("bing: {err}")),
        }
    }

    // 各站轮询交错，避免单站占满配额
    let mut candidates: Vec<(SearchResult, String)> = Vec::new();
    let longest = per_site.iter().map(|list| list.len()).max().unwrap_or(0);
    for rank in 0..longest {
        for list in &per_site {
            if let Some(item) = list.get(rank) {
                candidates.push(item.clone());
            }
        }
    }
    if candidates.is_empty() {
        anyhow::bail!("站内搜索无结果{}", if failures.is_empty() { String::new() } else { format!("；失败：{}", failures.join("; ")) });
    }
    Ok(Gathered { candidates, engine, sites })
}

/// 原生 API 站：并发查询，返回（别名，结果）
async fn search_api_sites(
fetcher: &Fetcher,
sites: &[(String, weights::SiteEntry)],
query: &str,
) -> Vec<(String, Result<Vec<SearchResult>>)> {
let mut out = Vec::new();
let mut tasks = Vec::new();
let sem = Arc::new(tokio::sync::Semaphore::new(SITE_CONCURRENCY));
for (alias, entry) in sites {
        let Some((url, body, referer, origin)) = site_request(&entry.search.kind, entry.search.site.as_deref(), query) else {
            out.push((alias.clone(), Err(anyhow::anyhow!("未知适配器 {}", entry.search.kind))));
            continue;
        };
        let fetcher = fetcher.clone();
        let sem = sem.clone();
        let alias = alias.clone();
        let kind = entry.search.kind.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let method = if body.is_some() { reqwest::Method::POST } else { reqwest::Method::GET };
            let _ = origin;
            match fetcher.request(method, &url, Some(&referer), "same-origin", body).await {
                Ok((status, text, _)) if (200..300).contains(&status) => (alias, Ok(parse_site_response(&kind, &text).into_iter().take(8).collect())),
                Ok((status, _, _)) => (alias, Err(anyhow::anyhow!("HTTP {status}"))),
                Err(e) => (alias, Err(e)),
            }
        }));
    }
    for task in tasks {
        match task.await {
            Ok(v) => out.push(v),
            Err(e) => out.push((String::from("?"), Err(anyhow::anyhow!("任务失败: {e}")))),
        }
    }
    out
}

async fn fetch_bing_scoped(fetcher: &Fetcher, domains: &[String], query: &str) -> Result<Vec<SearchResult>> {
fetcher.ensure_bing_session().await;
    let scope = if domains.len() == 1 {
        format!("site:{}", domains[0])
    } else {
        format!("({})", domains.iter().map(|d| format!("site:{d}")).collect::<Vec<_>>().join(" OR "))
    };
    let url = format!(
        "{BING_SEARCH}?q={}&first=1&form=QBRE&setmkt=zh-CN&setlang=zh-hans",
        urlencode(&format!("{scope} {query}"))
    );
let (status, body, _) = fetcher.get(&url, Some(BING_HOME), "same-origin").await?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Bing HTTP {status}");
    }
    if text::looks_like_captcha(&body) {
        anyhow::bail!("Bing 返回风控页");
    }
    Ok(text::parse_bing_results(&body))
}

async fn fetch_bing_serp(fetcher: &Fetcher, query: &str, offset: usize) -> Result<Vec<SearchResult>> {
    let url = format!(
        "{BING_SEARCH}?q={}&first={}&form=QBRE&setmkt=zh-CN&setlang=zh-hans",
        urlencode(query),
        offset + 1
    );
let (status, body, _) = fetcher.get(&url, Some(BING_HOME), "same-origin").await?;
if !(200..300).contains(&status) {
    anyhow::bail!("Bing 返回 HTTP {status}");
    }
    if text::looks_like_captcha(&body) {
        anyhow::bail!("Bing 返回了验证码/风控页，稍后重试或换查询词");
    }
    let results = text::parse_bing_results(&body);
    if results.is_empty() {
        anyhow::bail!("未解析到结果（query={query:?}）。可能无结果、页面结构变化、或被风控");
    }
    Ok(results)
}

pub fn now_rfc3339() -> String {
    // 只用于日志/落库的可读时间戳，避免引入 chrono
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("@{secs}")
}
