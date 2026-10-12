//! Source weights, blacklists, the site registry, the built-in hash embedder and
//! the confidence formula. Ported from the TypeScript core (core.ts).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::text::SearchResult;

pub const EMBED_DIM: usize = 256;
pub const HASH_SUPPORT_THRESHOLD: f32 = 0.25;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteSearchSpec {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteEntry {
    pub domain: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub search: SiteSearchSpec,
}

#[derive(Debug, Clone)]
pub struct SourceWeights {
    pub default_weight: f32,
    pub domains: HashMap<String, f32>,
    pub blocked_domains: Vec<String>,
    pub blocked_patterns: Vec<String>,
    pub sites: HashMap<String, SiteEntry>,
}

impl Default for SourceWeights {
    fn default() -> Self {
        let mut domains = HashMap::new();
        for (host, w) in DEFAULT_DOMAINS {
            domains.insert((*host).to_string(), *w);
        }
        let mut sites = HashMap::new();
        for (alias, entry) in default_sites() {
            sites.insert(alias, entry);
        }
        Self {
            default_weight: 0.5,
            domains,
            blocked_domains: DEFAULT_BLOCKED_DOMAINS.iter().map(|s| s.to_string()).collect(),
            blocked_patterns: DEFAULT_BLOCKED_PATTERNS.iter().map(|s| s.to_string()).collect(),
            sites,
        }
    }
}

/// 域名权重种子（与 TS 侧一致）
const DEFAULT_DOMAINS: &[(&str, f32)] = &[
    ("github.com", 0.95),
    ("gitlab.com", 0.95),
    ("docs.rs", 0.95),
    ("crates.io", 0.9),
    ("npmjs.com", 0.85),
    ("doi.org", 0.85),
    ("openalex.org", 0.8),
    ("doc.rust-lang.org", 0.95),
    ("docs.python.org", 0.95),
    ("developer.mozilla.org", 0.95),
    ("w3.org", 0.95),
    ("ietf.org", 0.95),
    ("rfc-editor.org", 0.95),
    ("arxiv.org", 0.95),
    ("acm.org", 0.95),
    ("ieee.org", 0.95),
    ("nature.com", 0.95),
    ("science.org", 0.95),
    ("ncbi.nlm.nih.gov", 0.95),
    // 顶会与期刊（大模型 / 机器学习）
    ("openreview.net", 0.95),
    ("proceedings.neurips.cc", 0.95),
    ("papers.nips.cc", 0.95),
    ("mlr.press", 0.95),
    ("aclanthology.org", 0.95),
    ("jmlr.org", 0.95),
    ("direct.mit.edu", 0.9),
    // 顶会与期刊（软件工程 / 系统 / 编程语言）
    ("usenix.org", 0.9),
    ("sigplan.org", 0.9),
    ("conf.researchr.org", 0.85),
    ("springer.com", 0.85),
    ("sciencedirect.com", 0.85),
    // 文献索引
    ("dblp.org", 0.9),
    ("semanticscholar.org", 0.8),
    // 中文期刊
    ("jos.org.cn", 0.9),
    ("cjc.ict.ac.cn", 0.85),
    ("ccf.org.cn", 0.8),
    ("stackoverflow.com", 0.9),
    ("wikipedia.org", 0.9),
    ("kubernetes.io", 0.9),
    ("docs.docker.com", 0.9),
    ("learn.microsoft.com", 0.9),
    ("docs.aws.amazon.com", 0.9),
    ("kernel.org", 0.9),
    ("lwn.net", 0.9),
    ("man7.org", 0.85),
    ("gnu.org", 0.85),
    ("rust-lang.org", 0.85),
    ("python.org", 0.85),
    ("golang.org", 0.85),
    ("cloud.google.com", 0.8),
    ("developer.android.com", 0.8),
    ("developer.apple.com", 0.8),
    ("martinfowler.com", 0.8),
    ("blog.cloudflare.com", 0.75),
    ("medium.com", 0.7),
    ("dev.to", 0.7),
    ("infoq.com", 0.7),
    ("infoq.cn", 0.7),
    ("news.ycombinator.com", 0.7),
    ("cloud.tencent.com", 0.7),
    ("cloud.aliyun.com", 0.7),
    ("developer.huawei.com", 0.7),
    ("sspai.com", 0.65),
    ("linux.cn", 0.65),
    ("juejin.cn", 0.6),
    ("segmentfault.com", 0.55),
    ("oschina.net", 0.55),
    ("runoob.com", 0.55),
    ("cnblogs.com", 0.5),
    ("reddit.com", 0.5),
    ("zhihu.com", 0.45),
    ("baike.baidu.com", 0.45),
    ("w3cschool.cn", 0.4),
    ("jianshu.com", 0.35),
    ("csdn.net", 0.25),
    ("51cto.com", 0.25),
    ("jishuzhan.net", 0.2),
    ("doc88.com", 0.15),
    ("docin.com", 0.15),
];

const DEFAULT_BLOCKED_DOMAINS: &[&str] = &[
    "qcc.com",
    "tianyancha.com",
    "aiqicha.baidu.com",
    "qixin.com",
    "shuidi.cn",
    "xizhi.com",
    "11467.com",
    "atobo.com.cn",
    "wenku.baidu.com",
];

const DEFAULT_BLOCKED_PATTERNS: &[&str] = &[
    "企查查",
    "爱企查",
    "天眼查",
    "启信宝",
    "水滴信用",
    "APEC会议",
];

fn site(domain: &str, tags: &[&str], kind: &str, ex_site: Option<&str>) -> SiteEntry {
    SiteEntry {
        domain: domain.to_string(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        search: SiteSearchSpec { kind: kind.to_string(), site: ex_site.map(str::to_string) },
    }
}

fn default_sites() -> Vec<(String, SiteEntry)> {
    vec![
        ("github".into(), site("github.com", &["代码", "仓库", "开源", "code", "repo", "源码"], "github", None)),
        ("gitlab".into(), site("gitlab.com", &["gitlab"], "gitlab", None)),
        ("npm".into(), site("npmjs.com", &["js 包", "node", "前端包"], "npm", None)),
        ("crates".into(), site("crates.io", &["rust 包", "rust crate"], "crates", None)),
        ("mdn".into(), site("developer.mozilla.org", &["web", "前端", "浏览器", "api 文档"], "mdn", None)),
        ("stackoverflow".into(), site("stackoverflow.com", &["问答", "q&a", "报错", "踩坑"], "stackexchange", Some("stackoverflow"))),
        ("hn".into(), site("news.ycombinator.com", &["hacker news", "技术新闻"], "hn", None)),
        ("juejin".into(), site("juejin.cn", &["掘金", "稀土"], "juejin", None)),
        ("csdn".into(), site("csdn.net", &["中文博客", "博客"], "csdn", None)),
        ("openalex".into(), site("openalex.org", &["学术", "论文", "paper"], "openalex", None)),
        ("crossref".into(), site("doi.org", &["文献", "doi"], "crossref", None)),
        ("arxiv".into(), site("arxiv.org", &["论文", "预印本"], "arxiv", None)),
        // 顶会与期刊：大模型 / 机器学习
        ("openreview".into(), site("openreview.net", &["顶会", "大模型", "机器学习", "iclr", "neurips", "tmlr", "评审"], "openreview", None)),
        ("neurips".into(), site("proceedings.neurips.cc", &["顶会", "大模型", "机器学习", "neurips"], "bing-site", None)),
        ("icml".into(), site("mlr.press", &["顶会", "大模型", "机器学习", "icml"], "bing-site", None)),
        ("aclanthology".into(), site("aclanthology.org", &["顶会", "大模型", "自然语言处理", "acl"], "bing-site", None)),
        // 头部期刊：OpenAlex 按 ISSN 检索（site 字段放 ISSN）
        ("jmlr".into(), site("jmlr.org", &["期刊", "机器学习", "jmlr"], "openalex-venue", Some("1532-4435"))),
        ("tpami".into(), site("ieeexplore.ieee.org", &["期刊", "机器学习", "tpami"], "openalex-venue", Some("0162-8828"))),
        ("aij".into(), site("sciencedirect.com", &["期刊", "人工智能", "aij"], "openalex-venue", Some("0004-3702"))),
        ("tacl".into(), site("direct.mit.edu", &["期刊", "大模型", "自然语言处理", "tacl"], "openalex-venue", Some("2307-387X"))),
        ("cl".into(), site("direct.mit.edu", &["期刊", "自然语言处理", "computational linguistics"], "openalex-venue", Some("0891-2017"))),
        ("nature-mi".into(), site("nature.com", &["期刊", "机器学习", "nature machine intelligence"], "openalex-venue", Some("2522-5839"))),
        // 顶会与期刊：软件工程 / 系统 / 编程语言
        ("tse".into(), site("ieeexplore.ieee.org", &["期刊", "软件工程", "tse"], "openalex-venue", Some("0098-5589"))),
        ("tosem".into(), site("dl.acm.org", &["期刊", "软件工程", "tosem"], "openalex-venue", Some("1049-331X"))),
        ("toplas".into(), site("dl.acm.org", &["期刊", "编程语言", "toplas"], "openalex-venue", Some("0164-0925"))),
        ("emse".into(), site("link.springer.com", &["期刊", "软件工程", "emse"], "openalex-venue", Some("1382-3256"))),
        ("researchr".into(), site("conf.researchr.org", &["顶会", "软件工程", "icse", "fse", "ase"], "bing-site", None)),
        ("sigplan".into(), site("sigplan.org", &["顶会", "编程语言", "pldi", "popl", "oopsla"], "bing-site", None)),
        ("usenix".into(), site("usenix.org", &["顶会", "系统", "osdi", "atc"], "bing-site", None)),
        // 中文头部期刊与文献索引
        ("jos".into(), site("jos.org.cn", &["期刊", "中文期刊", "软件学报"], "openalex-venue", Some("1000-9825"))),
        ("cjc".into(), site("cjc.ict.ac.cn", &["期刊", "中文期刊", "计算机学报"], "openalex-venue", Some("0254-4164"))),
        ("dblp".into(), site("dblp.org", &["文献索引", "ccf", "论文"], "bing-site", None)),
        ("docs.rs".into(), site("docs.rs", &["rust 文档", "api 文档"], "bing-site", None)),
        ("zhihu".into(), site("zhihu.com", &["知乎"], "bing-site", None)),
    ]
}

/// 最长后缀域名匹配；未命中返回 default_weight。
pub fn match_weight(weights: &SourceWeights, host: &str) -> (f32, Option<String>) {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let mut best: Option<(&String, f32)> = None;
    for (key, w) in &weights.domains {
        let is_match = h == *key || h.ends_with(&format!(".{key}"));
        if is_match && best.map(|(k, _)| key.len() > k.len()).unwrap_or(true) {
            best = Some((key, *w));
        }
    }
    match best {
        Some((k, w)) => (w, Some(k.clone())),
        None => (weights.default_weight, None),
    }
}

/// 域名后缀匹配：`a.b.com` 命中 `b.com`，`notb.com` 与 `github.com.evil.cn` 不命中
pub fn domain_matches(host: &str, pattern: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    !pattern.is_empty() && (host == pattern || host.ends_with(&format!(".{pattern}")))
}

pub fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase())).unwrap_or_default()
}

fn normalize_for_match(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// 黑名单检查：域名后缀命中优先，其次标题/URL/摘要包含屏蔽词。
pub fn check_blocked(weights: &SourceWeights, r: &SearchResult) -> Option<String> {
    let host = host_of(&r.url);
    if !host.is_empty() {
        for d in &weights.blocked_domains {
            if host == *d || host.ends_with(&format!(".{d}")) {
                return Some(format!("黑名单域名: {d}"));
            }
        }
    }
    let hay = normalize_for_match(&format!("{} {} {}", r.title, r.url, r.snippet));
    for p in &weights.blocked_patterns {
        let needle = normalize_for_match(p);
        if !needle.is_empty() && hay.contains(&needle) {
            return Some(format!("命中屏蔽词: {p}"));
        }
    }
    None
}

/// token（别名/标签/域名）→ 站点条目，保持注册顺序。
pub fn resolve_sites<'a>(
    weights: &'a SourceWeights,
    tokens: &[String],
) -> Vec<(String, &'a SiteEntry)> {
    let wanted: HashSet<String> = tokens.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut aliases: Vec<&String> = weights.sites.keys().collect();
    aliases.sort();
    let mut out = Vec::new();
    for alias in aliases {
        let entry = &weights.sites[alias];
        let hit = wanted.contains(&alias.to_lowercase())
            || entry.tags.iter().any(|t| wanted.contains(&t.to_lowercase()))
            || wanted.iter().any(|t| {
                entry.domain == *t || entry.domain.ends_with(&format!(".{t}")) || entry.domain.starts_with(&format!("{t}."))
            });
        if hit {
            out.push((alias.clone(), entry));
        }
    }
    out
}

// ---------------------------------------------------------------- hash embedder

fn hash32(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn add_feature(v: &mut [f32], key: &str, weight: f32) {
    let h = hash32(key);
    let sign = if h & 0x8000_0000 != 0 { -1.0 } else { 1.0 };
    v[(h as usize) % EMBED_DIM] += sign * weight;
}

/// 轻量本地嵌入（零模型特征哈希）：拉丁词 + 中文 2/3-gram，L2 归一化。
pub fn embed_text(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; EMBED_DIM];
    let lowered: String = text.to_lowercase();
    let s: String = lowered.chars().take(20000).collect();

    // 拉丁词
    let mut word = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '#' | '.' | '/' | '-') {
            word.push(ch);
        } else {
            if word.chars().count() >= 2 {
                add_feature(&mut v, &format!("w:{word}"), 1.0);
            }
            word.clear();
        }
    }
    if word.chars().count() >= 2 {
        add_feature(&mut v, &format!("w:{word}"), 1.0);
    }

    // 汉字连续段 → 2/3-gram
    let mut cjk: Vec<char> = Vec::new();
    let flush = |cjk: &mut Vec<char>, v: &mut Vec<f32>| {
        for i in 0..cjk.len().saturating_sub(1) {
            let gram: String = cjk[i..i + 2].iter().collect();
            add_feature(v, &format!("c2:{gram}"), 1.0);
        }
        for i in 0..cjk.len().saturating_sub(2) {
            let gram: String = cjk[i..i + 3].iter().collect();
            add_feature(v, &format!("c3:{gram}"), 0.6);
        }
        cjk.clear();
    };
    for ch in s.chars() {
        if is_cjk(ch) {
            cjk.push(ch);
        } else if !cjk.is_empty() {
            flush(&mut cjk, &mut v);
        }
    }
    if !cjk.is_empty() {
        flush(&mut cjk, &mut v);
    }

    l2_normalize(&mut v);
    v
}

pub fn is_cjk(ch: char) -> bool {
    matches!(ch, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
}

/// f32 → 保留 n 位小数（避免 JSON 里出现 0.550000011920929 这类噪声）
pub fn round_to(x: f32, digits: i32) -> f32 {
    let factor = 10f32.powi(digits);
    (x * factor).round() / factor
}

pub fn l2_normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

pub fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// 查询词面覆盖度：查询特征在页面向量中出现（同号）的比例。
pub fn query_coverage(query: &[f32], page: &[f32]) -> f32 {
    let mut total = 0usize;
    let mut hit = 0usize;
    for (q, p) in query.iter().zip(page) {
        if q.abs() < 1e-6 {
            continue;
        }
        total += 1;
        if p.abs() > 1e-6 && p.signum() == q.signum() {
            hit += 1;
        }
    }
    if total == 0 { 0.0 } else { hit as f32 / total as f32 }
}

/// 相关性：哈希嵌入用「覆盖度 60% + 余弦 40%」（覆盖度抗长度稀释）；
/// 语义嵌入（ONNX）下特征桶没有词面含义，覆盖率是噪声，直接用余弦。
pub fn relevance_score(query: &[f32], page: &[f32], semantic: bool) -> f32 {
    let cosine = cosine_sim(query, page).max(0.0);
    if semantic {
        return cosine.min(1.0);
    }
    let coverage = query_coverage(query, page);
    (0.6 * coverage + 0.4 * cosine).min(1.0)
}

/// 置信度 = 相关性 35% + 信源权重 20% + 多源印证 30% + 新鲜度 15%（3 源封顶）
pub fn score_confidence(relevance: f32, source_weight: f32, support: usize, recency: f32) -> f32 {
    let support_score = (support.min(3) as f32) / 3.0;
    let raw = 0.35 * clamp01(relevance)
        + 0.20 * clamp01(source_weight)
        + 0.30 * support_score
        + 0.15 * clamp01(recency);
    (clamp01(raw) * 100.0).round() / 100.0
}

