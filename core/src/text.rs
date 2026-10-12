//! Pure text/HTML helpers: entity decoding, core-text extraction, Bing SERP
//! parsing and page-kind classification. Ported from the TypeScript
//! implementation (core.ts) so both produce the same results.


/// 结果条目（与 TS 侧 `SearchResult` 同构）
#[derive(Debug, Clone, Default)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
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
    if trailing_slash && segments.len() == 1 {
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
