//! Embedding layer: local ONNX model through fastembed (ort load-dynamic), with
//! the built-in hash embedder as an automatic fallback.

pub mod model_cache;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use anyhow::{Context, Result};
use fastembed::{
    EmbeddingModel, InitOptionsUserDefined, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};

use crate::weights::{self, EMBED_DIM, HASH_SUPPORT_THRESHOLD};

/// 默认本地模型（fastembed 的模型名，E5 多语言小模型）
pub const DEFAULT_MODEL: &str = "MultilingualE5Small";
/// ONNX 语义嵌入的「多源印证」阈值（按 bge/e5 类模型的余弦分布标定）
pub const ONNX_SUPPORT_THRESHOLD: f32 = 0.62;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Passage,
}

/// `ort` 以 load-dynamic 构建，运行时需要 libonnxruntime.so。
/// 依次尝试：显式环境变量 → 本项目数据目录 → 复用 issue-vector-mcp 的副本。
pub fn bootstrap_ort_dylib() {
    if env::var("ORT_DYLIB_PATH").is_ok_and(|v| !v.is_empty()) {
        return;
    }
    let candidates = [
        data_dir().join("lib").join("libonnxruntime.so"),
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("issue-vector-mcp")
            .join("lib")
            .join("libonnxruntime.so"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            // SAFETY: 在启动早期、线程创建之前调用
            unsafe { env::set_var("ORT_DYLIB_PATH", &candidate) };
            return;
        }
    }
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = env::var("PI_WS_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("pi-web-search")
}

/// 模型目录候选（父目录，model_cache 会拼上模型名）：
/// 显式设置 → 本项目数据目录 → 复用 issue-vector-mcp 已下载的那份
fn model_dir_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = env::var("PI_WS_MODEL_DIR") {
        out.push(PathBuf::from(dir));
    }
    out.push(data_dir().join("models"));
    if let Some(shared) = dirs::data_dir() {
        out.push(shared.join("issue-vector-mcp").join("models"));
    }
    out
}

pub enum Embedder {
    Local(LocalEmbedder),
    Hash,
}

impl Embedder {
    pub fn id(&self) -> &'static str {
        match self {
            Embedder::Local(e) => e.id(),
            Embedder::Hash => "hash-256",
        }
    }

    pub fn dim(&self) -> usize {
        match self {
            Embedder::Local(e) => e.dim,
            Embedder::Hash => EMBED_DIM,
        }
    }

    pub fn is_semantic(&self) -> bool {
        matches!(self, Embedder::Local(_))
    }

    pub fn support_threshold(&self) -> f32 {
        match self {
            Embedder::Local(_) => ONNX_SUPPORT_THRESHOLD,
            Embedder::Hash => HASH_SUPPORT_THRESHOLD,
        }
    }

    pub fn model_name(&self) -> &str {
        match self {
            Embedder::Local(e) => &e.model_name,
            Embedder::Hash => "builtin-hash",
        }
    }

    /// 嵌入一批文本；kind 决定是否加检索指令前缀（E5 的 query/passage）
    pub fn embed(&mut self, texts: &[String], kind: Kind) -> Result<Vec<Vec<f32>>> {
        match self {
            Embedder::Local(e) => e.embed(texts, kind),
            Embedder::Hash => Ok(texts
                .iter()
                .map(|t| {
                    let mut v = weights::embed_text(t);
                    weights::l2_normalize(&mut v);
                    v
                })
                .collect()),
        }
    }
}

/// 优先本地 ONNX 模型；任何一步失败（缺模型/缺动态库）都退回哈希嵌入。
pub fn build(model_name: Option<&str>) -> Embedder {
    let name = model_name.unwrap_or(DEFAULT_MODEL).to_string();
    bootstrap_ort_dylib();
    match LocalEmbedder::new(&name) {
        Ok(e) => Embedder::Local(e),
        Err(err) => {
            eprintln!("[pi-web-search] 本地嵌入模型不可用（{err}），改用内置哈希嵌入");
            Embedder::Hash
        }
    }
}

pub struct LocalEmbedder {
    model: TextEmbedding,
    model_name: String,
    dim: usize,
    doc_prefix: &'static str,
    query_prefix: &'static str,
}

impl LocalEmbedder {
    fn id(&self) -> &'static str {
        match self.dim {
            384 => "onnx-e5-small-384",
            512 => "onnx-bge-small-zh-512",
            _ => "onnx-local",
        }
    }

    fn new(model_name: &str) -> Result<Self> {
        let parsed = EmbeddingModel::from_str(model_name).map_err(|e| anyhow::anyhow!("未知模型名 {model_name}: {e}"))?;
        let info = TextEmbedding::get_model_info(&parsed)?;

        let roots = model_dir_candidates();
        let paths = model_cache::ensure(&info.model_code, &info.model_file, &info.additional_files, &roots)?;

        let tokenizer_files = TokenizerFiles {
            tokenizer_file: fs::read(&paths.tokenizer_file).context("读取 tokenizer.json 失败")?,
            config_file: fs::read(&paths.config_file).context("读取 config.json 失败")?,
            special_tokens_map_file: fs::read(&paths.special_tokens_map_file).context("读取 special_tokens_map.json 失败")?,
            tokenizer_config_file: fs::read(&paths.tokenizer_config_file).context("读取 tokenizer_config.json 失败")?,
        };

        let mut user = UserDefinedEmbeddingModel::new(fs::read(&paths.onnx_file)?, tokenizer_files)
            .with_quantization(TextEmbedding::get_quantization_mode(&parsed));
        if let Some(pooling) = TextEmbedding::get_default_pooling_method(&parsed) {
            user = user.with_pooling(pooling);
        }
        user.output_key = info.output_key.clone();
        for (name, path) in &paths.external_initializers {
            user = user.with_external_initializer(name.clone(), fs::read(path)?);
        }

        let model = TextEmbedding::try_new_from_user_defined(user, InitOptionsUserDefined::new().with_intra_threads(4))?;

        // intfloat 的 e5 系列训练时区分 query/passage，缺前缀会明显掉召回
        let is_e5 = model_name.to_ascii_lowercase().contains("e5");
        let (doc_prefix, query_prefix) = if is_e5 { ("passage: ", "query: ") } else { ("", "") };

        Ok(Self {
            model,
            model_name: model_name.to_string(),
            dim: info.dim,
            doc_prefix,
            query_prefix,
        })
    }

    fn embed(&mut self, texts: &[String], kind: Kind) -> Result<Vec<Vec<f32>>> {
        let prefix = match kind {
            Kind::Query => self.query_prefix,
            Kind::Passage => self.doc_prefix,
        };
        let prepared: Vec<String> = texts.iter().map(|t| format!("{prefix}{t}")).collect();
        let mut out = self.model.embed(prepared, None)?;
        for v in out.iter_mut() {
            weights::l2_normalize(v);
        }
        Ok(out)
    }
}

