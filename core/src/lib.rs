//! pi-web-search core —— 本地优先的网页搜索与抓取内核。
//!
//! 这个 crate 同时提供 **lib** 与 **bin**：
//!
//! - lib（`pi_web_search_core`）：可被其他 Rust 项目复用——正文抽取、页面分类、
//!   并行抓取、身份池、条目存储与向量打分都在这里；
//! - bin（`pi-web-search`）：pi 扩展的常驻子进程，stdin/stdout 上的行式 JSON。
//!
//! 拆分动机：同一套抓取与正文抽取能力，除了给 pi 用，也要能被别的项目（例如
//! 知识库入库管线）直接引用，而不是复制一份源码过去。
//!
//! ## 模块职责
//!
//! | 模块 | 内容 |
//! |---|---|
//! | [`text`] | HTML → 正文、样板/广告/不可见内容剔除、日期归一、页面分类 |
//! | [`search`] | 搜索引擎与站内 API 编排、并行抓取、身份池、公网目标校验 |
//! | [`adapters`] | 各平台站内 API 的解析（Discourse / GitHub / arXiv …） |
//! | [`store`] | SQLite（rusqlite）+ sqlite-vec + FTS5 的条目与向量存储 |
//! | [`weights`] | 域名权重、两层黑名单、置信度打分、哈希嵌入兜底 |
//! | [`embed`] | 本地 ONNX（fastembed）嵌入，可回落到哈希嵌入 |
//! | [`protocol`] | 行式 JSON 协议（请求/响应结构） |

pub mod adapters;
pub mod embed;
pub mod protocol;
pub mod search;
pub mod store;
pub mod text;
pub mod weights;
