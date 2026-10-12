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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FetchParams {
    pub url: String,
    #[serde(default, rename = "maxChars")]
    pub max_chars: Option<usize>,
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
    #[serde(rename = "sortBy")]
    pub sort_by: String,
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
}

