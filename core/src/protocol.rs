//! Wire protocol: one JSON request per line on stdin, one JSON response per line
//! on stdout. The response shapes mirror the TypeScript build exactly so the thin
//! TS shell can pass them through to pi unchanged.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Search(SearchParams),
    Fetch(FetchParams),
    Stats,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchParams {
    pub query: String,
    /// 追加查询：与 query 一起并发检索后轮询合并（最多 4 条）
    #[serde(default)]
    pub queries: Option<Vec<String>>,
    #[serde(default)]
    pub count: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub sites: Option<Vec<String>>,
    #[serde(default, rename = "includeContent")]
    pub include_content: Option<bool>,
    #[serde(default, rename = "contentTop")]
    pub content_top: Option<usize>,
    #[serde(default, rename = "contentChars")]
    pub content_chars: Option<usize>,
    #[serde(default, rename = "minWeight")]
    pub min_weight: Option<f32>,
    /// `time`（默认，按发布时间倒序）或 `relevance`（保持引擎原序）
    #[serde(default, rename = "sortBy")]
    pub sort_by: Option<String>,
    /// 只保留最近 N 天发布的结果（没有日期的结果保留）
    #[serde(default, rename = "recencyDays")]
    pub recency_days: Option<u32>,
    /// 域名白名单（后缀匹配）
    #[serde(default)]
    pub domains: Option<Vec<String>>,
    /// 本次调用临时屏蔽的域名
    #[serde(default, rename = "excludeDomains")]
    pub exclude_domains: Option<Vec<String>>,
    /// 本次调用的总预算（毫秒）：超出就缩短内容等待窗口
    #[serde(default, rename = "budgetMs")]
    pub budget_ms: Option<u64>,
    /// 跨调用防重叠窗口（分钟，默认 10；0 关闭）：窗口内已经返回过的结果不再重复给出
    #[serde(default, rename = "dedupeWindowMinutes")]
    pub dedupe_window_minutes: Option<u32>,
    /// 置信度下限：低于它的结果不返回（全低时保留最高的一条）
    #[serde(default, rename = "minConfidence")]
    pub min_confidence: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FetchParams {
    pub url: String,
    #[serde(default, rename = "maxChars")]
    pub max_chars: Option<usize>,
    /// 只回包含该串的行（带行号，附一行上下文）
    #[serde(default)]
    pub find: Option<String>,
    /// 从第几行开始返回（1 起）
    #[serde(default, rename = "fromLine")]
    pub from_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageContent {
    pub ok: bool,
    pub title: String,
    #[serde(rename = "coreText")]
    pub core_text: String,
    /// 页面自带时间（meta/JSON-LD），用于给没有日期的搜索结果补标签
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackagedResult {
    pub rank: usize,
    pub title: String,
    pub url: String,
    pub weight: f32,
    #[serde(rename = "weightSource")]
    pub weight_source: Option<String>,
    pub via: String,
    pub snippet: String,
    /// 发布时间（YYYY-MM-DD）；来源没有就是 null
    pub published: Option<String>,
    pub content: Option<PageContent>,
    pub confidence: Option<f32>,
    pub relevance: Option<f32>,
    pub support: Option<usize>,
    /// 新鲜度 0~1（半衰期 365 天，无日期为中性 0.5）
    pub recency: Option<f32>,
    /// 是不是本次会话/窗口内已经给过的同一 URL
    pub seen: bool,
    /// 置信度是基于正文（page）还是仅标题+摘要（snippet）算的
    #[serde(rename = "confidenceBasis")]
    pub confidence_basis: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DroppedResult {
    pub title: String,
    pub url: String,
    pub weight: f32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Timings {
    #[serde(rename = "serpMs")]
    pub serp_ms: u64,
    #[serde(rename = "contentMs")]
    pub content_ms: u64,
    #[serde(rename = "embedMs")]
    pub embed_ms: u64,
    #[serde(rename = "totalMs")]
    pub total_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageMeta {
    pub count: usize,
    pub offset: usize,
    #[serde(rename = "includeContent")]
    pub include_content: bool,
    #[serde(rename = "contentTop")]
    pub content_top: usize,
    #[serde(rename = "contentChars")]
    pub content_chars: usize,
    #[serde(rename = "minWeight")]
    pub min_weight: Option<f32>,
    #[serde(rename = "fetchedPages")]
    pub fetched_pages: usize,
    #[serde(rename = "failedPages")]
    pub failed_pages: usize,
    pub sites: Option<Vec<String>>,
    /// 本次实际检索的查询词（多查询时按顺序列出）
    pub queries: Vec<String>,
    #[serde(rename = "sortBy")]
    pub sort_by: String,
    #[serde(rename = "recencyDays")]
    pub recency_days: Option<u32>,
    pub domains: Option<Vec<String>>,
    #[serde(rename = "excludeDomains")]
    pub exclude_domains: Option<Vec<String>>,
    #[serde(rename = "dedupeWindowMinutes")]
    pub dedupe_window_minutes: Option<u32>,
    /// 因「窗口内已返回过」而被丢弃的条数
    pub repeated: usize,
    /// 高置信（≥0.55）结果条数
    #[serde(rename = "highConfidence")]
    pub high_confidence: usize,
    /// 置信度偏低（<0.55）的条数
    #[serde(rename = "lowConfidence")]
    pub low_confidence: usize,
    /// 给模型的下一轮建议（高置信不足/大量重复时给出），没有就是 null
    pub hint: Option<String>,
    pub timings: Timings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPackage {
    pub query: String,
    pub engine: String,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: String,
    pub results: Vec<PackagedResult>,
    pub dropped: Vec<DroppedResult>,
    pub meta: PackageMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchPackage {
    pub url: String,
    #[serde(rename = "finalUrl")]
    pub final_url: String,
    pub title: String,
    pub weight: f32,
    #[serde(rename = "weightSource")]
    pub weight_source: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "coreText")]
    pub core_text: String,
    pub chars: usize,
    pub truncated: bool,
    #[serde(rename = "totalLines")]
    pub total_lines: usize,
    /// `find` 命中的行数（没传 find 时为 null）
    #[serde(rename = "matchedLines")]
    pub matched_lines: Option<usize>,
}

