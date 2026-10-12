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

/// 字段里的日期：ISO 字符串直接归一，纯数字按纪元秒/毫秒（10 位/13 位）折算
fn date(v: &Value, key: &str) -> Option<String> {
    let raw = v.get(key)?;
    match raw {
        Value::String(s) => {
            if s.chars().all(|c| c.is_ascii_digit()) && (s.len() == 10 || s.len() == 13) {
                let n: i64 = s.parse().ok()?;
                Some(text::date_from_epoch_secs(if s.len() == 13 { n / 1000 } else { n }))
            } else {
                text::normalize_date(s)
            }
        }
        Value::Number(n) => {
            let n = n.as_i64()?;
            Some(text::date_from_epoch_secs(if n > 99_999_999_999 { n / 1000 } else { n }))
        }
        _ => None,
    }
}

/// 取第一个能解析出日期的字段（例如 openreview 的 pdate 缺失时回落到 cdate）
fn first_date(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| date(v, k))
}

/// Crossref 的 `date-parts: [[2026, 3, 5]]`
fn date_parts(v: &Value, path: &[&str]) -> Option<String> {
    let first = as_array(v, path)?.first()?.as_array()?;
    let part = |i: usize, default: i64| first.get(i).and_then(|v| v.as_i64()).unwrap_or(default);
    text::ymd(part(0, 0), part(1, 1), part(2, 1))
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
                published: first_date(it, &["pushed_at", "updated_at", "created_at"]),
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
            Some(SearchResult {
                title,
                url,
                snippet: join_parts(vec![s(it, "description"), stars], 300),
                published: first_date(it, &["last_activity_at", "created_at"]),
            })
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
                published: date(pkg, "date"),
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
                published: first_date(c, &["updated_at", "created_at"]),
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
                published: None,
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
                published: first_date(it, &["last_activity_date", "creation_date"]),
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
            let created = s(h, "created_at").chars().take(10).collect::<String>();
            Some(SearchResult {
                title: text::decode_entities(if title.is_empty() { url.clone() } else { title }.as_str()),
                url,
                snippet: join_parts(vec![points, comments, created.clone()], 300),
                published: text::normalize_date(&created),
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
                published: first_date(info, &["ctime", "mtime"]),
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
                published: None,
            })
        })
        .collect()
}

/// OpenAlex 的摘要用倒排索引（词 → 位置）存储，按位置还原成明文
fn openalex_abstract(work: &Value) -> String {
    let Some(index) = work.get("abstract_inverted_index").and_then(|v| v.as_object()) else { return String::new() };
    let mut slots: Vec<(u64, &str)> = Vec::new();
    for (word, positions) in index {
        if let Some(list) = positions.as_array() {
            slots.extend(list.iter().filter_map(|v| v.as_u64()).map(|i| (i, word.as_str())));
        }
    }
    slots.sort_by_key(|(i, _)| *i);
    slots.into_iter().map(|(_, w)| w).collect::<Vec<_>>().join(" ")
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
            let venue = w
                .get("primary_location")
                .and_then(|l| l.get("source"))
                .and_then(|s| s.get("display_name"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            Some(SearchResult {
                title: text::strip_tags(&title),
                url,
                snippet: join_parts(vec![venue, cited, year, openalex_abstract(w)], 300),
                published: date(w, "publication_date"),
            })
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
            let published = date_parts(it, &["published", "date-parts"])
                .or_else(|| date_parts(it, &["issued", "date-parts"]));
            Some(SearchResult { title: text::strip_tags(&title), url, snippet: join_parts(vec![cited, venue], 300), published })
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
            published: text::normalize_date(&grab("published")),
        });
    }
    out
}

/// OpenReview notes/search（source=forum 只取投稿，评审笔记没有标题）：
/// 字段可能是 v2 的 `{"value": ...}` 包装，也可能是 v1 的裸值。
pub fn parse_openreview(json: &Value) -> Vec<SearchResult> {
    let Some(notes) = as_array(json, &["notes"]) else { return vec![] };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for note in notes {
        let Some(content) = note.get("content") else { continue };
        let field = |key: &str| -> String {
            content
                .get(key)
                .map(|v| v.get("value").and_then(|x| x.as_str()).unwrap_or_else(|| v.as_str().unwrap_or_default()))
                .unwrap_or_default()
                .to_string()
        };
        let title = text::strip_tags(&field("title"));
        let forum = s(note, "forum");
        if title.is_empty() || forum.is_empty() || !seen.insert(title.to_lowercase()) {
            continue;
        }
        // venue 自带年份，如 "ICLR 2024 Conference" / "ACL ARR 2026 May Submission"
        out.push(SearchResult {
            title,
            url: format!("https://openreview.net/forum?id={forum}"),
            snippet: join_parts(vec![field("venue"), field("abstract")], 300),
            published: first_date(note, &["pdate", "cdate"]),
        });
    }
    out
}

/// Discourse 论坛（NVIDIA / PyTorch 等社区用同一套 API）：topics + posts.blurb
pub fn parse_discourse(json: &Value, host: &str) -> Vec<SearchResult> {
    let Some(topics) = as_array(json, &["topics"]) else { return vec![] };
    let posts = as_array(json, &["posts"]).cloned().unwrap_or_default();
    topics
        .iter()
        .filter_map(|topic| {
            let id = topic.get("id").and_then(|v| v.as_i64())?;
            let title = s(topic, "title");
            if title.is_empty() {
                return None;
            }
            let slug = s(topic, "slug");
            let blurb = posts
                .iter()
                .find(|post| post.get("topic_id").and_then(|v| v.as_i64()) == Some(id))
                .map(|post| s(post, "blurb"))
                .unwrap_or_default();
            let replies = topic.get("posts_count").and_then(|v| v.as_i64()).map(|n| format!("{n} 帖")).unwrap_or_default();
            let solved = topic.get("has_accepted_answer").and_then(|v| v.as_bool()).unwrap_or(false);
            Some(SearchResult {
                title: text::decode_entities(&title),
                url: format!("https://{host}/t/{slug}/{id}"),
                snippet: join_parts(vec![if solved { "已解决".to_string() } else { String::new() }, replies, blurb], 300),
                // 论坛看的是「最近还有没有人回」，所以用最后回复时间
                published: text::normalize_date(&s(topic, "last_posted_at")).or_else(|| text::normalize_date(&s(topic, "created_at"))),
            })
        })
        .collect()
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
