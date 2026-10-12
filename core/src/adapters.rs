//! Site-direct search adapters: turn each platform's native search API response
//! into `SearchResult`s. Pure functions, ported from the TypeScript build.

use serde_json::Value;

use crate::text::{self, SearchResult};

fn as_array<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    let mut cur = v;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_array()
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

fn join_parts(parts: Vec<String>, limit: usize) -> String {
    parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .take(limit)
        .collect()
}

pub fn parse_github(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["items"]) else { return vec![] };
    items
        .iter()
        .filter_map(|it| {
            let url = s(it, "html_url");
            if !url.starts_with("http") {
                return None;
            }
            let stars = it.get("stargazers_count").and_then(|v| v.as_i64()).map(|n| format!("⭐ {n}")).unwrap_or_default();
            Some(SearchResult {
                title: {
                    let full = s(it, "full_name");
                    if full.is_empty() { s(it, "name") } else { full }
                },
                url,
                snippet: join_parts(vec![s(it, "description"), stars, s(it, "language")], 300),
            })
        })
        .collect()
}

pub fn parse_gitlab(json: &Value) -> Vec<SearchResult> {
    let Some(items) = json.as_array() else { return vec![] };
    items
        .iter()
        .filter_map(|it| {
            let url = s(it, "web_url");
            if !url.starts_with("http") {
                return None;
            }
            let stars = it.get("star_count").and_then(|v| v.as_i64()).map(|n| format!("★ {n}")).unwrap_or_default();
            let title = {
                let p = s(it, "path_with_namespace");
                if p.is_empty() { s(it, "name") } else { p }
            };
            Some(SearchResult { title, url, snippet: join_parts(vec![s(it, "description"), stars], 300) })
        })
        .collect()
}

pub fn parse_npm(json: &Value) -> Vec<SearchResult> {
    let Some(objects) = as_array(json, &["objects"]) else { return vec![] };
    objects
        .iter()
        .filter_map(|o| {
            let pkg = o.get("package")?;
            let name = s(pkg, "name");
            if name.is_empty() {
                return None;
            }
            let url = pkg.get("links").and_then(|l| l.get("npm")).and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}"));
            let version = s(pkg, "version");
            Some(SearchResult {
                title: name,
                url,
                snippet: join_parts(vec![s(pkg, "description"), if version.is_empty() { String::new() } else { format!("v{version}") }], 300),
            })
        })
        .collect()
}

pub fn parse_crates(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["crates"]) else { return vec![] };
    items
        .iter()
        .filter_map(|c| {
            let name = s(c, "name");
            if name.is_empty() {
                return None;
            }
            let downloads = c.get("downloads").and_then(|v| v.as_i64()).map(|n| format!("⬇ {n}")).unwrap_or_default();
            let version = s(c, "max_version");
            Some(SearchResult {
                title: name.clone(),
                url: format!("https://crates.io/crates/{name}"),
                snippet: join_parts(vec![s(c, "description"), downloads, if version.is_empty() { String::new() } else { format!("v{version}") }], 300),
            })
        })
        .collect()
}

pub fn parse_mdn(json: &Value) -> Vec<SearchResult> {
    let Some(docs) = as_array(json, &["documents"]) else { return vec![] };
    docs.iter()
        .filter_map(|d| {
            let mdn_url = s(d, "mdn_url");
            if mdn_url.is_empty() {
                return None;
            }
            Some(SearchResult {
                title: {
                    let t = s(d, "title");
                    if t.is_empty() { mdn_url.clone() } else { t }
                },
                url: format!("https://developer.mozilla.org{mdn_url}"),
                snippet: s(d, "summary").chars().take(300).collect(),
            })
        })
        .collect()
}

pub fn parse_stackexchange(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["items"]) else { return vec![] };
    items
        .iter()
        .filter_map(|it| {
            let url = s(it, "link");
            if !url.starts_with("http") {
                return None;
            }
            let score = it.get("score").and_then(|v| v.as_i64()).map(|n| format!("得分 {n}")).unwrap_or_default();
            let answers = it.get("answer_count").and_then(|v| v.as_i64()).map(|n| format!("{n} 答案")).unwrap_or_default();
            let state = if it.get("is_answered").and_then(|v| v.as_bool()).unwrap_or(false) { "已解决" } else { "未解决" };
            Some(SearchResult {
                title: text::decode_entities(&s(it, "title")),
                url,
                snippet: join_parts(vec![score, answers, state.to_string()], 300),
            })
        })
        .collect()
}

pub fn parse_hn(json: &Value) -> Vec<SearchResult> {
    let Some(hits) = as_array(json, &["hits"]) else { return vec![] };
    hits.iter()
        .filter_map(|h| {
            let url = {
                let u = s(h, "url");
                if !u.is_empty() { u } else { format!("https://news.ycombinator.com/item?id={}", s(h, "objectID")) }
            };
            if !url.starts_with("http") {
                return None;
            }
            let title = {
                let t = s(h, "title");
                if t.is_empty() { s(h, "story_title") } else { t }
            };
            let points = h.get("points").and_then(|v| v.as_i64()).map(|n| format!("{n} 分")).unwrap_or_default();
            let comments = h.get("num_comments").and_then(|v| v.as_i64()).map(|n| format!("{n} 评论")).unwrap_or_default();
            let date = s(h, "created_at").chars().take(10).collect::<String>();
            Some(SearchResult {
                title: text::decode_entities(if title.is_empty() { url.clone() } else { title }.as_str()),
                url,
                snippet: join_parts(vec![points, comments, date], 300),
            })
        })
        .collect()
}

pub fn parse_juejin(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["data"]) else { return vec![] };
    items
        .iter()
        .filter_map(|raw| {
            let info = raw.get("result_model")?.get("article_info")?;
            let id = s(info, "article_id");
            if id.is_empty() {
                return None;
            }
            let likes = info.get("digg_count").and_then(|v| v.as_i64()).map(|n| format!("👍 {n}")).unwrap_or_default();
            let views = info.get("view_count").and_then(|v| v.as_i64()).map(|n| format!("{n} 阅读")).unwrap_or_default();
            Some(SearchResult {
                title: text::decode_entities(&s(info, "title")),
                url: format!("https://juejin.cn/post/{id}"),
                snippet: join_parts(vec![s(info, "brief_content"), likes, views], 300),
            })
        })
        .collect()
}

pub fn parse_csdn(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["result_vos"]) else { return vec![] };
    items
        .iter()
        .filter_map(|h| {
            let raw = text::decode_entities(&s(h, "url"));
            let parsed = url::Url::parse(&raw).ok()?;
            let mut clean = format!("{}://{}", parsed.scheme(), parsed.host_str()?);
            clean.push_str(parsed.path());
            let description = {
                let d = s(h, "description");
                if d.is_empty() { s(h, "digest") } else { d }
            };
            Some(SearchResult {
                title: text::strip_tags(&s(h, "title")),
                url: clean,
                snippet: text::strip_tags(&description).chars().take(300).collect(),
            })
        })
        .collect()
}

pub fn parse_openalex(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["results"]) else { return vec![] };
    items
        .iter()
        .filter_map(|w| {
            let title = s(w, "display_name");
            if title.is_empty() {
                return None;
            }
            let url = {
                let landing = w.get("primary_location").and_then(|l| l.get("landing_page_url")).and_then(|v| v.as_str()).unwrap_or_default();
                if !landing.is_empty() { landing.to_string() } else { s(w, "doi") }
            };
            if !url.starts_with("http") {
                return None;
            }
            let cited = w.get("cited_by_count").and_then(|v| v.as_i64()).map(|n| format!("引用 {n}")).unwrap_or_default();
            let year = w.get("publication_year").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default();
            Some(SearchResult { title: text::strip_tags(&title), url, snippet: join_parts(vec![cited, year], 300) })
        })
        .collect()
}

pub fn parse_crossref(json: &Value) -> Vec<SearchResult> {
    let Some(items) = as_array(json, &["message", "items"]) else { return vec![] };
    items
        .iter()
        .filter_map(|it| {
            let url = s(it, "URL");
            if !url.starts_with("http") {
                return None;
            }
            let title = it
                .get("title")
                .and_then(|t| t.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or(&url)
                .to_string();
            let cited = it.get("is-referenced-by-count").and_then(|v| v.as_i64()).map(|n| format!("引用 {n}")).unwrap_or_default();
            let venue = it.get("container-title").and_then(|t| t.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            Some(SearchResult { title: text::strip_tags(&title), url, snippet: join_parts(vec![cited, venue], 300) })
        })
        .collect()
}

/// arXiv 返回 Atom XML：按 <entry> 切块取 title/id/summary（与 TS 版一致）
pub fn parse_arxiv(xml: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();
    for entry in xml.split("<entry>").skip(1) {
        let grab = |tag: &str| -> String {
            entry
                .find(&format!("<{tag}>"))
                .and_then(|start| {
                    let s = start + tag.len() + 2;
                    entry[s..].find(&format!("</{tag}>")).map(|end| entry[s..s + end].to_string())
                })
                .unwrap_or_default()
        };
        let url = grab("id").trim().to_string();
        if !url.starts_with("http") {
            continue;
        }
        let title = grab("title").split_whitespace().collect::<Vec<_>>().join(" ");
        out.push(SearchResult {
            title: text::strip_tags(&title),
            url,
            snippet: text::strip_tags(&grab("summary")).chars().take(300).collect(),
        });
    }
    out
}

/// 站内兜底：结果必须属于目标域名（Bing 有时会放宽 site:）
pub fn filter_to_domain(results: Vec<SearchResult>, domain: &str) -> Vec<SearchResult> {
    let d = domain.to_ascii_lowercase();
    results
        .into_iter()
        .filter(|r| {
            url::Url::parse(&r.url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
                .map(|h| h == d || h.ends_with(&format!(".{d}")))
                .unwrap_or(false)
        })
        .collect()
}
