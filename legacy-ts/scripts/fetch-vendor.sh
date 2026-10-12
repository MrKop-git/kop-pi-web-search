#!/usr/bin/env bash
# Fetch the third-party artifacts this extension loads at runtime.
# Nothing here is committed to git (~38 MB total):
#
#   vendor/vec0.sqlite                    sqlite-vec loadable extension (vectors)
#   vendor/ort/ort.wasm.min.mjs           onnxruntime-web (pure wasm build)
#   vendor/ort/ort-wasm-simd-threaded.*
#   vendor/model-bge-small-zh/*           bge-small-zh-v1.5 int8 ONNX + tokenizer
#
# Behind the Great Firewall, set HF_ENDPOINT=https://hf-mirror.com
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-0.1.9}"
ONNXRT_WEB_VERSION="${ONNXRT_WEB_VERSION:-1.30.0}"
HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
MODEL_REPO="${MODEL_REPO:-Xenova/bge-small-zh-v1.5}"

mkdir -p "$VENDOR/ort" "$VENDOR/model-bge-small-zh"

echo "==> sqlite-vec $SQLITE_VEC_VERSION"
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) VEC_PKG="sqlite-vec-linux-x64" ;;
	Linux-aarch64 | Linux-arm64) VEC_PKG="sqlite-vec-linux-arm64" ;;
	Darwin-x86_64) VEC_PKG="sqlite-vec-darwin-x64" ;;
	Darwin-arm64) VEC_PKG="sqlite-vec-darwin-arm64" ;;
	MINGW* | MSYS* | CYGWIN*) VEC_PKG="sqlite-vec-windows-x64" ;;
	*)
		echo "!! 不支持的平台：$(uname -s)-$(uname -m)，请手动放置 sqlite-vec 动态库为 vendor/vec0.sqlite" >&2
		exit 1
		;;
esac
curl -fsSL "https://registry.npmjs.org/$VEC_PKG/-/$VEC_PKG-$SQLITE_VEC_VERSION.tgz" -o "$TMP/vec.tgz"
tar xzf "$TMP/vec.tgz" -C "$TMP"
VEC_LIB="$(find "$TMP/package" -maxdepth 1 -name 'vec0.*' | head -1)"
# 统一命名成 vec0.sqlite：pi 会扫描扩展目录，避免 .so/.dylib 被当成别的资源
cp "$VEC_LIB" "$VENDOR/vec0.sqlite"

echo "==> onnxruntime-web $ONNXRT_WEB_VERSION (wasm only)"
curl -fsSL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$ONNXRT_WEB_VERSION.tgz" -o "$TMP/ort.tgz"
tar xzf "$TMP/ort.tgz" -C "$TMP" \
	package/dist/ort.wasm.min.mjs \
	package/dist/ort-wasm-simd-threaded.mjs \
	package/dist/ort-wasm-simd-threaded.wasm
cp "$TMP/package/dist/ort.wasm.min.mjs" \
	"$TMP/package/dist/ort-wasm-simd-threaded.mjs" \
	"$TMP/package/dist/ort-wasm-simd-threaded.wasm" \
	"$VENDOR/ort/"

echo "==> embedding model: $MODEL_REPO (int8, from $HF_ENDPOINT)"
for f in onnx/model_quantized.onnx tokenizer.json config.json; do
	curl -fsSL "$HF_ENDPOINT/$MODEL_REPO/resolve/main/$f" -o "$VENDOR/model-bge-small-zh/$(basename "$f")"
done

echo
echo "完成："
du -sh "$VENDOR"/* 2>/dev/null
echo
echo "别忘了这一步需要 sqlite-vec + ONNX 才能用上向量/置信度；缺件时扩展会自动降级到内置哈希嵌入。"
