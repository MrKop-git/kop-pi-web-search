//! 自己下载 HuggingFace 上的模型文件。
//!
//! 为什么不直接用 fastembed 的 hf-hub 下载：hf-hub 0.5 要求服务端在
//! `Range: bytes=0-0` 请求上返回 `Content-Range` 头，而 hf-mirror.com 的
//! resolve-cache 端点不返回它，于是直接报 `Header Content-Range is missing`。
//! 自己下载还能顺带支持任意镜像、断点续传式的「文件已存在就跳过」。

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

const DEFAULT_ENDPOINT: &str = "https://huggingface.co";
const FALLBACK_ENDPOINT: &str = "https://hf-mirror.com";

/// fastembed 加载分词器时固定要用到的四个文件。
const TOKENIZER_FILES: [&str; 4] = [
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
];

pub struct ModelPaths {
    pub onnx_file: PathBuf,
    pub tokenizer_file: PathBuf,
    pub config_file: PathBuf,
    pub special_tokens_map_file: PathBuf,
    pub tokenizer_config_file: PathBuf,
    /// ONNX 权重外置的文件（部分大模型会有），(ONNX 内部引用的文件名, 本地路径)。
    pub external_initializers: Vec<(String, PathBuf)>,
}

/// 确保模型文件都在本地缓存里，缺失的下载。
/// `cache_roots` 按优先级排列（父目录，函数会拼上模型名）：
/// 第一个已含完整模型的目录会被直接用掉，否则下载进第一个目录。
pub fn ensure(
    model_code: &str,
    model_file: &str,
    additional_files: &[String],
    cache_roots: &[PathBuf],
) -> Result<ModelPaths> {
    let cache_root = cache_roots
        .iter()
        .find(|root| root.join(sanitize(model_code)).join(flatten(model_file)).is_file())
        .cloned()
        .or_else(|| cache_roots.first().cloned())
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = cache_root.join(sanitize(model_code));
    fs::create_dir_all(&dir)
        .with_context(|| format!("创建模型缓存目录失败: {}", dir.display()))?;

    let explicit = env::var("PI_WS_HF_ENDPOINT")
        .ok()
        .or_else(|| env::var("HF_ENDPOINT").ok())
        .filter(|s| !s.trim().is_empty());
    let mut endpoint = explicit
        .clone()
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build()?;

    let mut wanted: Vec<String> = Vec::with_capacity(TOKENIZER_FILES.len() + 1 + additional_files.len());
    wanted.push(model_file.to_string());
    wanted.extend(TOKENIZER_FILES.iter().map(|s| s.to_string()));
    wanted.extend(additional_files.iter().cloned());

    for rel in &wanted {
        let dest = dir.join(flatten(rel));
        if is_cached(&dest) {
            continue;
        }

        match download(&client, &endpoint, model_code, rel, &dest) {
            Ok(()) => {}
            // 没显式配置镜像时，官方源不通就自动换国内镜像，并说明发生了什么。
            Err(e) if explicit.is_none() && endpoint == DEFAULT_ENDPOINT => {
                tracing::warn!(
                    "从 {DEFAULT_ENDPOINT} 下载 {rel} 失败（{e}），改用 {FALLBACK_ENDPOINT}；\
                     可用 HF_ENDPOINT 指定其他镜像"
                );
                endpoint = FALLBACK_ENDPOINT.to_string();
                download(&client, &endpoint, model_code, rel, &dest)?;
            }
            Err(e) => return Err(e),
        }
    }

    Ok(ModelPaths {
        onnx_file: dir.join(flatten(model_file)),
        tokenizer_file: dir.join(flatten(TOKENIZER_FILES[0])),
        config_file: dir.join(flatten(TOKENIZER_FILES[1])),
        special_tokens_map_file: dir.join(flatten(TOKENIZER_FILES[2])),
        tokenizer_config_file: dir.join(flatten(TOKENIZER_FILES[3])),
        external_initializers: additional_files
            .iter()
            .map(|rel| (rel.clone(), dir.join(flatten(rel))))
            .collect(),
    })
}

fn download(
    client: &reqwest::blocking::Client,
    endpoint: &str,
    repo: &str,
    rel: &str,
    dest: &Path,
) -> Result<()> {
    let url = format!("{}/{repo}/resolve/main/{rel}", endpoint.trim_end_matches('/'));
    tracing::info!("下载模型文件 {url}");

    let mut resp = client
        .get(&url)
        .send()
        .with_context(|| format!("请求 {url} 失败"))?;

    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{url} 返回 {status}");
    }
    let total = resp.content_length();

    // 先写临时文件再改名，避免中途失败留下半个文件被当成缓存命中。
    let tmp = dest.with_extension("part");
    let mut file = fs::File::create(&tmp)
        .with_context(|| format!("创建 {} 失败", tmp.display()))?;

    let written = std::io::copy(&mut resp, &mut file)
        .with_context(|| format!("下载 {url} 中断"))?;
    file.flush()?;
    drop(file);
    fs::rename(&tmp, dest)?;

    if written == 0 {
        fs::remove_file(dest).ok();
        anyhow::bail!("{url} 返回了空文件");
    }

    match total {
        Some(t) if t != written => {
            fs::remove_file(dest).ok();
            anyhow::bail!("{url} 只下到 {written}/{t} 字节，已丢弃");
        }
        Some(t) => tracing::info!("已下载 {}（{:.1} MB）", dest.display(), t as f64 / 1e6),
        None => tracing::info!("已下载 {}（{:.1} MB）", dest.display(), written as f64 / 1e6),
    }
    Ok(())
}

fn is_cached(path: &Path) -> bool {
    path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// "intfloat/multilingual-e5-small" -> "intfloat--multilingual-e5-small"
fn sanitize(model_code: &str) -> String {
    model_code.replace('/', "--")
}

/// "onnx/model.onnx" -> "onnx__model.onnx"，避免在缓存目录里再造一层子目录。
fn flatten(rel: &str) -> String {
    rel.replace('/', "__")
}
