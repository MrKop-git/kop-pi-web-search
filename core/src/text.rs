//! Pure text/HTML helpers: entity decoding, core-text extraction, Bing SERP
//! parsing and page-kind classification. Ported from the TypeScript
//! implementation (core.ts) so both produce the same results.


/// 结果条目（与 TS 侧 `SearchResult` 同构）
#[derive(Debug, Clone, Default)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// 发布时间（YYYY-MM-DD）；取不到就是 None
    pub published: Option<String>,
}

// ---------------------------------------------------------------- dates

fn take_num(s: &str) -> Option<(i64, usize)> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    Some((digits.parse().ok()?, digits.len()))
}

/// 年/月/日 → YYYY-MM-DD；越界（月份/日期/年份不合理）返回 None
pub fn ymd(y: i64, m: i64, d: i64) -> Option<String> {
    if (1900..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
        Some(format!("{y:04}-{m:02}-{d:02}"))
    } else {
        None
    }
}

/// 从一段文本里挑出第一个日期，归一成 YYYY-MM-DD。
/// 认 `2026-03-05`、`2026/3/5`、`2026年3月5日`、`Mar 5, 2026`、`5 March 2026`。
pub fn normalize_date(raw: &str) -> Option<String> {
    const MONTHS: [(&str, &str); 12] = [
        ("jan", "january"),
        ("feb", "february"),
        ("mar", "march"),
        ("apr", "april"),
        ("may", "may"),
        ("jun", "june"),
        ("jul", "july"),
        ("aug", "august"),
        ("sep", "september"),
        ("oct", "october"),
        ("nov", "november"),
        ("dec", "december"),
    ];
    for (i, _) in raw.char_indices() {
        let rest = &raw[i..];
        let Some((first, len)) = take_num(rest) else { continue };
        let after = &rest[len..];
        let parsed = if let Some(r2) = after.strip_prefix('-').or_else(|| after.strip_prefix('/')) {
            take_num(r2).and_then(|(m, lm)| {
                let r3 = &r2[lm..];
                r3.strip_prefix('-')
                    .or_else(|| r3.strip_prefix('/'))
                    .and_then(take_num)
                    .and_then(|(d, _)| ymd(first, m, d))
            })
        } else if let Some(r2) = after.strip_prefix('年') {
            take_num(r2).and_then(|(m, lm)| {
                r2[lm..].strip_prefix('月').and_then(take_num).and_then(|(d, _)| ymd(first, m, d))
            })
        } else {
            None
        };
        if parsed.is_some() {
            return parsed;
        }
    }
    // 英文月份：Mar 5, 2026 / 5 March 2026（数字要紧挨着月份，免得 "may be 5 of 2026" 误判）
    let lower = raw.to_ascii_lowercase();
    let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_ascii_alphabetic());
    let mut mentions: Vec<(usize, usize, i64)> = Vec::new();
    for (mi, (abbr, full)) in MONTHS.iter().enumerate() {
        for needle in [*full, *abbr] {
            let Some(pos) = lower.find(needle) else { continue };
            let end = pos + needle.len();
            // 全称一定带边界；缩写要求后面不是字母（"march" 里的 "mar" 不算）
            let ok_after = needle == *full || boundary(lower[end..].chars().next());
            if boundary(lower[..pos].chars().next_back()) && ok_after {
                mentions.push((pos, end, mi as i64 + 1));
            }
        }
    }
    mentions.sort();
    for (pos, end, m) in mentions {
        let head = lower[..pos].trim_end();
        let head = &head[head.len().saturating_sub(6)..];
        let tail = &lower[end..lower.len().min(end + 16)];
        let day_before: Option<i64> = {
            let digits: String = head.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
            digits.chars().rev().collect::<String>().parse().ok()
        };
        let parsed = match day_before {
            // 5 March 2026：月份前是日，紧跟的数字是年
            Some(day) => number_after(tail).and_then(|(year, start, _)| {
                if start <= 3 { ymd(year, m, day) } else { None }
            }),
            // Mar 5, 2026：月份后紧跟日、日之后紧跟年
            None => number_after(tail).and_then(|(day, start, end)| {
                if start > 2 {
                    return None;
                }
                number_after(&tail[end..]).and_then(|(year, ystart, _)| {
                    if ystart <= 3 { ymd(year, m, day) } else { None }
                })
            }),
        };
        if parsed.is_some() {
            return parsed;
        }
    }
    None
}

/// 跳过非数字后取一个整数，返回（值，起始字节下标，结束字节下标）
fn number_after(s: &str) -> Option<(i64, usize, usize)> {
    let start = s.find(|c: char| c.is_ascii_digit())?;
    let (value, len) = take_num(&s[start..])?;
    Some((value, start, start + len))
}

/// 纪元秒 → YYYY-MM-DD（civil_from_days，省掉 chrono 依赖）
pub fn date_from_epoch_secs(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    (era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy) - 719_468
}

fn today() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

fn parse_ymd(date: &str) -> Option<(i64, i64, i64)> {
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    Some((y, m, d))
}

/// 发布是否早于 `days` 天前（解析不出日期时返回 false：没日期的结果不按时间窗丢弃）
pub fn older_than(published: &str, days: u32) -> bool {
    match parse_ymd(published) {
        Some((y, m, d)) => today() - days_from_civil(y, m, d) > days as i64,
        None => false,
    }
}

/// 新鲜度：半衰期 365 天（今天 = 1，一年前 = 0.5，两年前 = 0.25）；无日期给中性 0.5
pub fn recency_score(published: Option<&str>) -> f32 {
    let age = published.and_then(parse_ymd).map(|(y, m, d)| today() - days_from_civil(y, m, d));
    match age {
        Some(days) => 0.5f32.powf(days.max(0) as f32 / 365.0),
        None => 0.5,
    }
}

/// 页面自带时间：`<meta property="article:published_time">`、JSON-LD `datePublished`、`<time datetime>`
pub fn date_from_html(html: &str) -> Option<String> {
    const NEEDLES: [&str; 5] = [
        "article:published_time",
        "datePublished",
        "article:modified_time",
        "dateModified",
        "<time",
    ];
    for needle in NEEDLES {
        let Some(pos) = html.find(needle) else { continue };
        let window = &html[pos..html.len().min(pos + 300)];
        if let Some(date) = normalize_date(window) {
            return Some(date);
        }
    }
    None
}

/// SERP 单条结果里的时间：绝对日期优先，`3 天前` / `5 days ago` 这类相对时间按今天折算
pub fn date_from_serp_chunk(chunk: &str) -> Option<String> {
    let text = strip_tags(chunk);
    if let Some(date) = normalize_date(&text) {
        return Some(date);
    }
    for (needle, unit) in [("天前", 1i64), ("小时前", 0), ("分钟前", 0), ("days ago", 1), ("hours ago", 0), ("minutes ago", 0)] {
        let Some(pos) = text.find(needle) else { continue };
        let head: String = text[..pos].chars().rev().take_while(|c| c.is_ascii_digit()).collect();
        let n: i64 = head.chars().rev().collect::<String>().parse().unwrap_or(0);
        return Some(date_from_epoch_secs((today() - n * unit) * 86_400));
    }
    None
}

// ---------------------------------------------------------------- entities

pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = s[i..].find(';').filter(|p| *p <= 12) {
                let ent = &s[i + 1..i + semi];
                if let Some(ch) = entity_to_char(ent) {
                    out.push(ch);
                    i += semi + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn entity_to_char(ent: &str) -> Option<char> {
    if let Some(hex) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
        return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
    }
    if let Some(dec) = ent.strip_prefix('#') {
        return dec.parse::<u32>().ok().and_then(char::from_u32);
    }
    Some(match ent.to_ascii_lowercase().as_str() {
        "nbsp" | "ensp" | "emsp" | "thinsp" => ' ',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" | "#39" => '\'',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "middot" => '·',
        "bull" => '•',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "amp" => '&',
        _ => return None,
    })
}

pub fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    collapse_ws(&decode_entities(&out))
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------- Bing SERP

/// 解析 Bing SERP：按 `class="b_algo"` 切块，取 h2>a 的标题/URL 与 b_caption 摘要。
pub fn parse_bing_results(html: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for chunk in html.split("class=\"b_algo\"").skip(1) {
        let Some((url, raw_title)) = title_from_chunk(chunk) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        out.push(SearchResult {
            title: strip_tags(&raw_title),
            url,
            snippet: snippet_from_chunk(chunk),
            published: date_from_serp_chunk(chunk),
        });
    }
    out
}

fn title_from_chunk(chunk: &str) -> Option<(String, String)> {
    let h2 = chunk.find("<h2")?;
    let after_h2 = &chunk[h2..];
    let a_pos = after_h2.find("<a")?;
    let anchor = &after_h2[a_pos..];
    let href_start = anchor.find("href=\"")? + 6;
    let href_end = anchor[href_start..].find('"')? + href_start;
    let url = decode_entities(&anchor[href_start..href_end]).trim().to_string();
    if url.is_empty() || url.starts_with('#') || url.starts_with("javascript:") || url.starts_with("mailto:") {
        return None;
    }
    let close = anchor.find('>')?;
    let title_end = anchor[close..].find("</a>")? + close;
    Some((url, anchor[close + 1..title_end].to_string()))
}

fn snippet_from_chunk(chunk: &str) -> String {
    if let Some(pos) = chunk.find("class=\"b_caption\"") {
        if let Some(p) = chunk[pos..].find("<p") {
            let rest = &chunk[pos + p..];
            if let Some(open) = rest.find('>') {
                if let Some(close) = rest.find("</p>") {
                    return strip_tags(&rest[open + 1..close]);
                }
            }
        }
    }
    if let Some(pos) = chunk.find("<p") {
        let rest = &chunk[pos..];
        if let Some(open) = rest.find('>') {
            if let Some(close) = rest.find("</p>") {
                return strip_tags(&rest[open + 1..close]);
            }
        }
    }
    String::new()
}

/// Bing 风控页识别（fail loud 用）
pub fn looks_like_captcha(html: &str) -> bool {
    const NEEDLES: [&str; 4] = [
        "b_captcha",
        "sb_form_captcha",
        "请解决以下难题",
        "Enter the characters you see",
    ];
    NEEDLES.iter().any(|n| html.contains(n))
}

/// 反爬中间页（Cloudflare / Anubis）：抓到的是验证提示，不是正文
pub fn looks_like_challenge(html: &str) -> bool {
    const NEEDLES: [&str; 8] = [
        "Just a moment...",
        "Verifying your browser",
        "cf-chl-",
        "_cf_chl_opt",
        "challenge-platform",
        "Making sure you&#39;re not a bot",
        "Making sure you're not a bot",
        "Attention Required! | Cloudflare",
    ];
    NEEDLES.iter().any(|n| html.contains(n))
}

// ---------------------------------------------------------------- core text

const TAG_BOILERPLATE: [&str; 13] = [
    "script", "style", "noscript", "svg", "iframe", "template", "form", "nav", "aside", "footer", "button",
    "dialog", "menu",
];

const ATTR_BOILERPLATE: [&str; 26] = [
    "sidebar", "widget", "comment", "comments", "footer", "nav", "navbar", "menu", "banner", "promo", "advert",
    "ad", "ads", "related", "recommend", "share", "sharing", "social", "breadcrumb", "pagination", "cookie",
    "popup", "modal", "subscribe", "newsletter", "toolbar",
];

const VOID_TAGS: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
];

/// 去掉脚本/样式与「样板子树」（按标签名或 class/id 关键词整块删除）。
pub fn strip_boilerplate(html: &str) -> String {
    // 1) 注释 + script/style 等（简单成对删除）
    let s = strip_simple_blocks(html);

    // 2) 栈扫描：命中样板标签/属性时整棵子树丢弃（正确处理嵌套）
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    let mut skip_depth = 0i32;
    while i < s.len() {
        let Some(rel) = s[i..].find('<') else {
            if skip_depth == 0 {
                out.push_str(&s[i..]);
            }
            break;
        };
        let lt = i + rel;
        if skip_depth == 0 {
            out.push_str(&s[i..lt]);
        }
        let Some(gt_rel) = s[lt..].find('>') else {
            if skip_depth == 0 {
                out.push_str(&s[lt..]);
            }
            break;
        };
        let gt = lt + gt_rel;
        let tag = &s[lt..=gt];
        i = gt + 1;
        let (closing, name) = match parse_tag_name(tag) {
            Some(v) => v,
            None => {
                if skip_depth == 0 {
                    out.push_str(tag);
                }
                continue;
            }
        };
        let is_void = VOID_TAGS.contains(&name.as_str()) || tag.trim_end().ends_with("/>");
        if skip_depth > 0 {
            if !is_void {
                skip_depth += if closing { -1 } else { 1 };
                if skip_depth < 0 {
                    skip_depth = 0;
                }
            }
            continue;
        }
        if !closing && !is_void && is_boilerplate_tag(tag, &name) {
            skip_depth = 1;
            continue;
        }
        out.push_str(tag);
    }
    let _ = bytes;
    out
}

fn strip_simple_blocks(html: &str) -> String {
    let mut s = remove_comments(html);
    for tag in ["script", "style", "noscript", "svg", "iframe", "template"] {
        s = remove_element(&s, tag);
    }
    s
}

fn remove_comments(html: &str) -> String {
    let (mut out, mut i) = (String::with_capacity(html.len()), 0usize);
    while let Some(start) = html[i..].find("<!--") {
        out.push_str(&html[i..i + start]);
        match html[i + start..].find("-->") {
            Some(end) => i = i + start + end + 3,
            None => return out,
        }
    }
    out.push_str(&html[i..]);
    out
}

fn remove_element(html: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let (mut out, mut i) = (String::with_capacity(html.len()), 0usize);
    while let Some(start) = find_ci(&html[i..], &open) {
        let abs = i + start;
        // 跳过 <scriptx ...> 这类前缀相同的标签
        let after = html[abs + open.len()..].chars().next().unwrap_or(' ');
        if !(after.is_whitespace() || after == '>' || after == '/') {
            out.push_str(&html[i..abs + open.len()]);
            i = abs + open.len();
            continue;
        }
        out.push_str(&html[i..abs]);
        match find_ci(&html[abs..], &close) {
            Some(rel) => {
                let end = match html[abs + rel..].find('>') {
                    Some(g) => abs + rel + g + 1,
                    None => html.len(),
                };
                i = end;
            }
            None => i = abs + open.len(),
        }
    }
    out.push_str(&html[i..]);
    out
}

fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

fn parse_tag_name(tag: &str) -> Option<(bool, String)> {
    let body = tag.strip_prefix('<')?;
    let closing = body.starts_with('/');
    let body = body.strip_prefix('/').unwrap_or(body);
    let mut name = String::new();
    for ch in body.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            name.push(ch.to_ascii_lowercase());
        } else {
            break;
        }
    }
    if name.is_empty() { None } else { Some((closing, name)) }
}

fn is_boilerplate_tag(tag: &str, name: &str) -> bool {
    if TAG_BOILERPLATE.contains(&name) {
        return true;
    }
    let lower = tag.to_ascii_lowercase();
    for attr in ["class=\"", "id=\"", "class='", "id='"] {
        let mut idx = 0;
        while let Some(pos) = lower[idx..].find(attr) {
            let start = idx + pos + attr.len();
            let quote = attr.chars().last().unwrap();
            let Some(end) = lower[start..].find(quote) else { break };
            let value = &lower[start..start + end];
            let tokens: Vec<&str> = value
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|t| !t.is_empty())
                .collect();
            if tokens.iter().any(|t| ATTR_BOILERPLATE.contains(t)) {
                return true;
            }
            idx = start + end + 1;
        }
    }
    false
}

const HEAD_OPEN: char = '\u{1}';

fn menu_line(line: &str) -> bool {
    // 形如「首页 | 关于 | 联系」：短片段用分隔符串起来
    let seps = ['|', '｜', '·', '・', '/', '／', '、'];
    let parts: Vec<&str> = line.split(|c| seps.contains(&c)).map(str::trim).collect();
    parts.len() >= 3
        && parts.iter().all(|p| p.chars().count() <= 24)
        && !line.contains(['。', '！', '？', '.', '!', '?'])
}

const UI_PREFIXES: [&str; 22] = [
    "首页", "登录", "注册", "下载", "菜单", "导航", "返回", "上一页", "下一页", "上一篇", "下一篇", "阅读全文",
    "点击", "查看更多", "展开", "关于我们", "联系方式", "友情链接", "版权", "关注我们", "扫码", "分享到",
];

fn ui_line(line: &str) -> bool {
    UI_PREFIXES.iter().any(|p| line.starts_with(p))
}

/// 行级过滤：保留标题与列表项，去掉菜单/UI 噪声与过短行。
pub fn filter_core_lines(text: &str) -> String {
    let mut kept = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.contains(HEAD_OPEN) || line.starts_with("• ") {
            kept.push(line.replace(HEAD_OPEN, ""));
            continue;
        }
        if menu_line(line) || ui_line(line) {
            continue;
        }
        if line.chars().count() < 4 {
            continue;
        }
        kept.push(line.to_string());
    }
    kept.join("\n")
}

/// 正文抽取：去样板 → 优选 main/article → 标记标题 → 逐行过滤。
pub fn html_to_text(html: &str) -> String {
    let stripped = strip_boilerplate(html);
    let region = extract_region(&stripped).unwrap_or(stripped);

    let mut s = String::with_capacity(region.len());
    let mut i = 0usize;
    while i < region.len() {
        let rest = &region[i..];
        if let Some(rel) = rest.find('<') {
            s.push_str(&rest[..rel]);
            let abs = i + rel;
            let Some(gt) = region[abs..].find('>') else { break };
            let tag = &region[abs..abs + gt + 1];
            if let Some((closing, name)) = parse_tag_name(tag) {
                if name.len() == 2 && name.starts_with('h') && name[1..].chars().all(|c| ('1'..='6').contains(&c)) {
                    s.push('\n');
                    s.push(HEAD_OPEN);
                    if closing {
                        s.push(HEAD_OPEN);
                        s.push('\n');
                    }
                } else if name == "br" {
                    s.push('\n');
                } else if name == "li" && !closing {
                    s.push('\n');
                    s.push_str("• ");
                } else if closing && matches!(name.as_str(), "p" | "div" | "section" | "article" | "li" | "tr" | "blockquote" | "pre" | "table" | "ul" | "ol" | "dl" | "dd" | "dt") {
                    s.push_str("\n\n");
                }
            }
            i = abs + gt + 1;
        } else {
            s.push_str(rest);
            break;
        }
    }

    let decoded = decode_entities(&s);
    let normalized: String = decoded
        .split('\n')
        .map(|l| {
            let squeezed: String = l.split_whitespace().collect::<Vec<_>>().join(" ");
            squeezed
        })
        .collect::<Vec<_>>()
        .join("\n");
    let filtered = filter_core_lines(&normalized);
    squeeze_blank_lines(&filtered)
}

fn extract_region(html: &str) -> Option<String> {
    if let Some(v) = between_ci(html, "<main", "</main>") {
        return Some(v);
    }
    if let Some(v) = between_ci(html, "<article", "</article>") {
        if v.len() > 500 {
            return Some(v);
        }
    }
    None
}

fn between_ci(html: &str, open: &str, close: &str) -> Option<String> {
    let start = find_ci(html, open)?;
    let open_end = html[start..].find('>')? + start + 1;
    let end = find_ci(&html[open_end..], close)? + open_end;
    Some(html[open_end..end].to_string())
}

fn squeeze_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blanks = 0;
    for line in s.split('\n') {
        if line.is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

pub fn extract_title(html: &str) -> String {
    match between_ci(html, "<title", "</title>") {
        Some(t) => strip_tags(&t),
        None => String::new(),
    }
}

// ---------------------------------------------------------------- page kind

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PageKind {
    Content,
    Homepage,
    List,
}

const LIST_SEGMENTS: [&str; 28] = [
    "blog", "blogs", "news", "article", "articles", "post", "posts", "archive", "archives", "category",
    "categories", "tag", "tags", "topic", "topics", "question", "questions", "list", "lists", "index", "search",
    "collection", "collections", "channel", "channels", "column", "columns", "nav",
];

fn is_index_file(last: &str) -> bool {
    let lower = last.to_ascii_lowercase();
    let Some((stem, _ext)) = lower.split_once('.') else { return false };
    matches!(stem, "index" | "home" | "default" | "main")
}

/// 只返回内容页：站点根/栏目根/列表词结尾/分页参数 → 非内容页。
pub fn classify_page_url(url: &str) -> PageKind {
    let Ok(parsed) = url::Url::parse(url) else {
        return PageKind::Content;
    };
    let segments: Vec<&str> = parsed.path().split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return PageKind::Homepage;
    }
    let last = *segments.last().unwrap();
    let trailing_slash = parsed.path().ends_with('/');
    if is_index_file(last) {
        return PageKind::Homepage;
    }
    if is_pagination_segment(last) {
        return PageKind::List;
    }
    if segments.len() >= 2 && last.chars().all(|c| c.is_ascii_digit()) && last.len() <= 3 {
        let prev = segments[segments.len() - 2];
        if prev.eq_ignore_ascii_case("page") {
            return PageKind::List;
        }
    }
    if LIST_SEGMENTS.contains(&last.to_ascii_lowercase().as_str()) {
        return PageKind::List;
    }
    // 单段 + 结尾斜杠通常是站点/栏目根；段里带数字的多是论文号（ACL Anthology 的 /2024.acl-long.1/）
    if trailing_slash && segments.len() == 1 && !segments[0].chars().any(|c| c.is_ascii_digit()) {
        return PageKind::Homepage;
    }
    if trailing_slash && segments.len() == 2 && is_locale(segments[0]) {
        return PageKind::Homepage;
    }
    for key in ["page", "paged", "start", "offset", "pageno"] {
        if let Some(v) = parsed.query_pairs().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v) {
            if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) {
                return PageKind::List;
            }
        }
    }
    if trailing_slash && segments.len() >= 2 {
        let prev = segments[segments.len() - 2].to_ascii_lowercase();
        if LIST_SEGMENTS.contains(&prev.as_str()) {
            return PageKind::List;
        }
    }
    PageKind::Content
}

fn is_pagination_segment(seg: &str) -> bool {
    let lower = seg.to_ascii_lowercase();
    for prefix in ["page-", "page_", "p-", "p_"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

fn is_locale(seg: &str) -> bool {
    let lower = seg.to_ascii_lowercase();
    let parts: Vec<&str> = lower.split('-').collect();
    parts.len() <= 2 && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic()))
}
