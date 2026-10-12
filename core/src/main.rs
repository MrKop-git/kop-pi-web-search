//! pi-web-search core: line-delimited JSON on stdin/stdout.
//!
//!   echo '{"cmd":"search","query":"sqlite-vec","count":5}' | pi-web-search
//!
//! Responses mirror the TypeScript build: the search package, a fetch package, or
//! `{"error": "..."}`. Diagnostics go to stderr so stdout stays machine-readable.

mod adapters;
mod embed;
mod protocol;
mod search;
mod store;
mod text;
mod weights;

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::Result;
use serde_json::json;

use protocol::Request;
use search::Engine;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn default_db_path() -> PathBuf {
    std::env::var("PI_WS_DB_PATH").map(PathBuf::from).unwrap_or_else(|_| home().join(".pi/agent/web-search.db"))
}

fn default_legacy_json() -> Option<PathBuf> {
    match std::env::var("PI_WS_LEGACY_JSON") {
        Ok(v) if v.is_empty() => None,
        Ok(v) => Some(PathBuf::from(v)),
        Err(_) => Some(home().join(".pi/agent/web-sources.json")),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let model = std::env::var("PI_WS_MODEL").ok();
    let mut engine = Engine::new(default_db_path(), default_legacy_json(), model.as_deref())?;

    match args.first().map(String::as_str) {
        // 一次性查询（不经过 pi，便于人工验证）：pi-web-search search "查询词" [count]
        Some("search") => {
            let query = args.get(1).cloned().unwrap_or_default();
            let count = args.get(2).and_then(|c| c.parse().ok());
            let params = protocol::SearchParams {
                query,
                queries: None,
                count,
                offset: None,
                sites: None,
                include_content: None,
                content_top: None,
                content_chars: None,
                min_weight: None,
                sort_by: None,
                recency_days: None,
                domains: None,
                exclude_domains: None,
                budget_ms: None,
                dedupe_window_minutes: None,
            };
            match engine.search(params).await {
                Ok(pkg) => println!("{}", serde_json::to_string_pretty(&pkg)?),
                Err(e) => {
                    eprintln!("错误: {e}");
                    std::process::exit(1);
                }
            }
            return Ok(());
        }
        Some("stats") => {
            println!("{}", serde_json::to_string_pretty(&engine.store.stats()?)?);
            return Ok(());
        }
        Some("selftest") => {
            run_selftest(&mut engine).await?;
            return Ok(());
        }
        _ => {}
    }

    // 常驻模式：逐行读请求、逐行写响应（TS 壳保持一个长驻子进程，模型只加载一次）
    eprintln!(
        "[pi-web-search] ready db={} embedder={} dim={} vec={}",
        default_db_path().display(),
        engine.embedder.model_name(),
        engine.embedder.dim(),
        engine.store.vec_enabled()
    );
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.lock().read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 直接序列化结构体：走 serde_json 的 f32 最短表示。
        // （先转成 Value 会把 f32 提升成 f64，0.55 就变成 0.550000011920929）
        let response = match serde_json::from_str::<Request>(trimmed) {
            Ok(Request::Search(params)) => match engine.search(params).await {
                Ok(pkg) => serde_json::to_string(&pkg)?,
                Err(err) => json!({ "error": err.to_string() }).to_string(),
            },
            Ok(Request::Fetch(params)) => match engine.fetch_one(params).await {
                Ok(pkg) => serde_json::to_string(&pkg)?,
                Err(err) => json!({ "error": err.to_string() }).to_string(),
            },
            Ok(Request::Stats) => serde_json::to_string(&engine.store.stats()?)?,
            Err(err) => json!({ "error": format!("bad request: {err}") }).to_string(),
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}

/// 离线自检：文本处理、权重匹配、黑名单、嵌入、SQLite + vec 是否就绪。
async fn run_selftest(engine: &mut Engine) -> Result<()> {
    let mut failures = 0usize;
    let mut check = |name: &str, ok: bool, detail: String| {
        println!("{} {name}{}", if ok { "✓" } else { "✗" }, if detail.is_empty() { String::new() } else { format!(" — {detail}") });
        if !ok {
            failures += 1;
        }
    };

    let page = "<html><head><title>测试页 &amp; 标题</title><style>.x{color:red}</style><script>alert(1)</script></head>\
                <body><nav>菜单 首页 关于</nav><main><h1>正文标题</h1><p>第一段，包含&nbsp;空格。</p>\
                <div class=\"sidebar\"><p>侧栏推荐</p></div><ul><li>项目一</li></ul></main><footer>版权信息</footer></body></html>";
    let core = text::html_to_text(page);
    check("core-text: 去掉 script/nav/footer/侧栏", !core.contains("alert") && !core.contains("菜单") && !core.contains("版权") && !core.contains("侧栏推荐"), format!("{core:?}"));
    check("core-text: 保留标题与正文", core.contains("正文标题") && core.contains("第一段"), String::new());
    check("entities: &amp;/&nbsp; 解码", text::decode_entities("a&amp;b&nbsp;c") == "a&b c", String::new());

    let weights = engine.store.load_weights()?;
    check("权重: github.com → 0.95", weights::match_weight(&weights, "github.com").0 == 0.95, format!("{}", weights::match_weight(&weights, "github.com").0));
    check("权重: 未知名 → default", weights::match_weight(&weights, "unknown.example").0 == weights.default_weight, String::new());
    let blocked = SearchResultStub { title: "小米科技有限责任公司 - 企查查".into(), url: "https://www.qcc.com/firm/x.html".into() };
    check("黑名单: 企查查命中", weights::check_blocked(&weights, &blocked.into()).is_some(), String::new());
    check("站点表: github 可解析", !weights::resolve_sites(&weights, &["github".to_string()]).is_empty(), String::new());

    check("页面分类: 首页/列表/内容", {
        use text::PageKind::*;
        text::classify_page_url("https://example.com/") == Homepage
            && text::classify_page_url("https://example.com/blog/") == List
            && text::classify_page_url("https://zhuanlan.zhihu.com/p/671404492") == Content
    }, String::new());

    let v1 = weights::embed_text("sqlite-vec 是 SQLite 的向量扩展");
    let v2 = weights::embed_text("SQLite 向量扩展 sqlite-vec");
    let v3 = weights::embed_text("今天天气不错，适合钓鱼");
    check("哈希嵌入: 相关 > 无关", weights::cosine_sim(&v1, &v2) > weights::cosine_sim(&v1, &v3), format!("{:.3} vs {:.3}", weights::cosine_sim(&v1, &v2), weights::cosine_sim(&v1, &v3)));
    check(
        "置信度: 满分 1 / 无印证且无日期封顶 0.63",
        weights::score_confidence(1.0, 1.0, 3, 1.0) == 1.0 && weights::score_confidence(1.0, 1.0, 0, 0.5) == 0.63,
        format!("{} / {}", weights::score_confidence(1.0, 1.0, 3, 1.0), weights::score_confidence(1.0, 1.0, 0, 0.5)),
    );

    check(
        "日期: 各种写法归一",
        text::normalize_date("2026年3月5日") == Some("2026-03-05".into())
            && text::normalize_date("发布于 2024/11/5") == Some("2024-11-05".into())
            && text::normalize_date("Mar 5, 2026 — 更新") == Some("2026-03-05".into())
            && text::normalize_date("published 5 March 2026") == Some("2026-03-05".into())
            && text::normalize_date("没有日期的一段话") == None
            && text::normalize_date("this may be 5 of 2026 items") == None,
        format!("{:?}", text::normalize_date("2026年3月5日")),
    );
    check(
        "日期: 页面 meta / JSON-LD",
        text::date_from_html("<meta property=\"article:published_time\" content=\"2025-04-01T10:00:00Z\">") == Some("2025-04-01".into())
            && text::date_from_html("<script>{\"datePublished\":\"2025-04-02\"}</script>") == Some("2025-04-02".into()),
        String::new(),
    );
    check(
        "新鲜度: 越近越高、无日期中性",
        text::recency_score(Some(&text::date_from_epoch_secs(
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - 400 * 86_400,
        ))) > text::recency_score(Some("2000-01-01"))
            && text::recency_score(None) == 0.5,
        String::new(),
    );

    check("SQLite + sqlite-vec 可用", engine.store.vec_enabled(), String::new());

    let texts = vec!["sqlite-vec 向量扩展".to_string(), "今天天气不错".to_string()];
    match engine.embedder.embed(&texts, embed::Kind::Query) {
        Ok(vecs) => {
            let dim = vecs.first().map(|v| v.len()).unwrap_or(0);
            let sim = weights::cosine_sim(&vecs[0], &vecs[1]);
            check(
                &format!("嵌入器 {} (dim {dim})", engine.embedder.model_name()),
                dim > 0 && vecs.len() == 2,
                format!("两条相似度 {sim:.3}"),
            );
        }
        Err(e) => check("嵌入器", false, e.to_string()),
    }

    check(
        "时间窗: 只丢确定过期的（无日期不丢）",
        text::older_than("2000-01-01", 30)
            && !text::older_than(
                &text::date_from_epoch_secs(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)),
                30,
            )
            && !text::older_than("不是日期", 1),
        String::new(),
    );
    // 回归：根元素带 sidebar-visible、侧栏里 <li> 省略闭合时，正文不能被一起丢光
    let messy = "<html class=\"light sidebar-visible\"><body><nav class=\"sidebar\"><ul><li>目录一<li>目录二</ul></nav>\
                 <main><p>这是正文，必须留下。</p><p>第二段也要在。</p></main></body></html>";
    let messy_text = text::html_to_text(messy);
    check(
        "core-text: 非良构 HTML 不丢正文",
        messy_text.contains("必须留下") && messy_text.contains("第二段") && !messy_text.contains("目录一"),
        format!("{messy_text:?}"),
    );

    // 身份池：同站粘性、被风控后换身份（PI_WS_IDENTITY 固定身份时不测轮换）
    let fetcher = search::Fetcher::new(std::env::temp_dir().join("pi-ws-selftest-identity.db"))?;
    check(
        "身份池: 至少 4 个身份且同站粘性",
        fetcher.identity_count() >= 4 && fetcher.identity_for("example.com") == fetcher.identity_for("example.com"),
        format!("{} 个身份", fetcher.identity_count()),
    );
    if std::env::var("PI_WS_IDENTITY").is_err() {
        let first = fetcher.identity_for("example.com");
        fetcher.block_identity("example.com", first);
        check("身份池: 被风控后换身份", fetcher.identity_for("example.com") != first, format!("#{first} → #{}", fetcher.identity_for("example.com")));
    }

    // 公网目标校验（照 dsh：内网/环回/元数据地址一律不抓）
    let discourse = serde_json::json!({
        "topics": [{"id": 42, "title": "Fan control &amp; PWM", "slug": "fan-control", "posts_count": 3, "has_accepted_answer": true, "last_posted_at": "2026-09-01T10:00:00.000Z"}],
        "posts": [{"topic_id": 42, "blurb": "set it with pwm"}],
    });
    let forum = adapters::parse_discourse(&discourse, "forums.developer.nvidia.com");
    check(
        "站内适配器: discourse 解析（标题/URL/时间/摘要）",
        forum.len() == 1
            && forum[0].url == "https://forums.developer.nvidia.com/t/fan-control/42"
            && forum[0].published.as_deref() == Some("2026-09-01")
            && forum[0].title.contains("Fan control & PWM")
            && forum[0].snippet.contains("pwm"),
        format!("{:?}", forum.first().map(|r| (&r.url, &r.published))),
    );

    check(
        "公网校验: 内网地址被拒",
        !search::is_public_ip("127.0.0.1".parse().unwrap())
            && !search::is_public_ip("169.254.169.254".parse().unwrap())
            && !search::is_public_ip("10.1.2.3".parse().unwrap())
            && !search::is_public_ip("::1".parse().unwrap())
            && search::is_public_ip("1.1.1.1".parse().unwrap()),
        String::new(),
    );
    check(
        "公网校验: localhost/元数据 URL 被拒",
        search::ensure_public_target("http://localhost:8080/x").await.is_err()
            && search::ensure_public_target("http://169.254.169.254/latest/meta-data/").await.is_err()
            && search::ensure_public_target("https://example.com/ok").await.is_ok(),
        String::new(),
    );

    check(
        "域名匹配: 后缀命中、伪后缀不命中",
        weights::domain_matches("a.github.com", "github.com")
            && !weights::domain_matches("notgithub.com", "github.com")
            && !weights::domain_matches("github.com.evil.cn", "github.com"),
        String::new(),
    );
    check(
        "域名通配: * 一段 / ** 零到多段 / 段内通配",
        weights::domain_matches("a.github.com", "*.github.com")
            && !weights::domain_matches("github.com", "*.github.com")
            && !weights::domain_matches("a.b.github.com", "*.github.com")
            && weights::domain_matches("github.com", "**.github.com")
            && weights::domain_matches("a.b.github.com", "**.github.com")
            && weights::domain_matches("region1.v2.foo.com", "region*.v2.foo.com")
            && !weights::domain_matches("region1.v3.foo.com", "region*.v2.foo.com"),
        String::new(),
    );

    let stats = engine.store.stats()?;
    println!("\n库状态: {stats}");
    if failures == 0 {
        println!("\nSELFTEST PASSED");
        Ok(())
    } else {
        anyhow::bail!("{failures} 项自检失败")
    }
}

struct SearchResultStub {
    title: String,
    url: String,
}

impl From<SearchResultStub> for text::SearchResult {
    fn from(s: SearchResultStub) -> Self {
        text::SearchResult { title: s.title, url: s.url, snippet: String::new(), published: None }
    }
}
