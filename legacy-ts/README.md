# legacy-ts — the previous pure-TypeScript implementation

This is the original implementation: the whole pipeline (Bing SERP parsing,
core-text extraction, SQLite storage, ONNX embeddings via onnxruntime-web) in
TypeScript, with no Rust involved. It works and is kept for reference.

It is superseded by the Rust core (`../core/`) plus the thin TypeScript shell
(`../index.ts`). Reasons for the rewrite: reuse of the author's existing Rust
stack (sqlite-vec compiled in, fastembed for embeddings, reqwest for HTTP),
no 38 MB of vendored wasm/model files, and a persistent core process so the
embedding model loads once per session.

Notes:
- The tests here assume the old layout (implementation files at the repository
  root) and the old `vendor/` artifacts; they are archive material, not a
  maintained suite. The current suite is `../tests/`.
- `scripts/fetch-vendor.sh` fetched the artifacts this implementation needed
  (sqlite-vec loadable extension, onnxruntime-web wasm build, bge-small-zh ONNX
  model). The Rust core needs none of that: sqlite-vec is compiled in and the
  embedding model is fetched by the core itself (`fastembed`), with
  `libonnxruntime.so` discovered from the data directory (see the top README).
