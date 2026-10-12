# kop-pi-web-search

Local-first web search & page fetching for the [pi coding agent](https://pi.dev) —
a **Rust core** with a **thin TypeScript shell**. No API keys, no quotas, no MCP servers.

```
pi ──► index.ts (thin TS shell: tool registration + JSON schemas)
         │  JSON lines over stdin/stdout, one long-lived child process
         ▼
       core/ (Rust: pi-web-search)
         │
         ├─ Bing SERP scraping (browser fingerprint, cookie warm-up, per-host pacing)
         ├─ 12 platform search APIs (github, gitlab, npm, crates, mdn, stackexchange,
         │  hn, juejin, csdn, openalex, crossref, arxiv)
         ├─ windowed parallel page fetching (16-way, one wait window)
         ├─ core-text extraction (boilerplate/nav/ads stripped)
         ├─ SQLite + sqlite-vec (compiled in) for storage, cache and vectors
         └─ fastembed local ONNX embeddings → confidence scoring
```

Why this split: pi's extension API only loads TypeScript/JavaScript modules (`jiti`),
so the tools must be registered from TS. Everything else — HTTP, parsing, storage,
embeddings — lives in Rust, where `sqlite-vec` compiles in (no `.so` to ship),
`fastembed` handles tokenizer/pooling/model management, and a persistent process
keeps the embedding model loaded across calls.

## Features

| | |
|---|---|
| **Two tools** | `web_search` (search + fetch + filter + score) and `web_fetch` |
| **Search engine** | Bing SERP scraping with a coherent browser fingerprint and pacing |
| **Site-direct search** | `sites=["github","csdn"]` skips the engine; 12 native APIs, `site:`-scoped Bing for the rest |
| **Content pages only** | homepages, section roots and list/index pages are dropped before fetching |
| **Core-text extraction** | nav/ads/sidebars/comment blocks/menu lines removed; headings and prose kept |
| **Parallel scheduling** | one wait window bounds the content stage; pages are fetched 16-way, so more pages = more content, not more latency |
| **Trust data** | per-domain weights and two-layer blocklists (domains + keyword patterns) in SQLite |
| **Confidence** | relevance + source weight + cross-source corroboration, from local embeddings |
| **Storage** | SQLite (rusqlite) with sqlite-vec vectors and an FTS5 index over fetched text |
| **Embeddings** | local ONNX (`MultilingualE5Small`, 384-dim) via fastembed; falls back to a built-in hash embedder |

## Install

```bash
git clone https://github.com/MrKop-git/kop-pi-web-search.git \
  ~/.pi/agent/extensions/web-search
cd ~/.pi/agent/extensions/web-search/core
cargo build --release
mkdir -p bin && cp target/release/pi-web-search bin/     # 壳会优先找 core/bin/
```

For the local embedding model the core needs `libonnxruntime.so` (the `ort` crate is
built with `load-dynamic`). It looks, in order, at:

1. `ORT_DYLIB_PATH` (env)
2. `~/.local/share/pi-web-search/lib/libonnxruntime.so`
3. `~/.local/share/issue-vector-mcp/lib/libonnxruntime.so` (reused if present)

Any copy works, e.g. from the PyPI wheel:

```bash
pip download onnxruntime --no-deps -d /tmp/ort
unzip -j /tmp/ort/onnxruntime-*.whl 'onnxruntime/capi/libonnxruntime.so*' -d ~/.local/share/pi-web-search/lib/
mv ~/.local/share/pi-web-search/lib/libonnxruntime.so.* ~/.local/share/pi-web-search/lib/libonnxruntime.so
```

Without it the core still runs — it degrades to the hash embedder. The model itself is
downloaded by the core on first use (`HF_ENDPOINT=https://hf-mirror.com` behind the GFW).

Restart pi (or `/reload`) and both tools are available.

## Usage

```
web_search(query="sqlite-vec", count=8, contentTop=8)
web_search(query="向量检索", sites=["掘金","中文博客"])     # aliases, tags or domains
web_fetch(url="https://docs.rs/sqlite-vec")
```

`web_search` parameters: `query`, `count` (8), `offset`, `sites`, `includeContent` (true),
`contentTop` (8), `contentChars` (1000), `minWeight`.

Output is a JSON package — `{ query, engine, fetchedAt, results[], dropped[], meta{} }` —
where every result carries `weight`, `via`, `confidence`, `relevance`, `support` and the
fetched `content`. `meta.timings` breaks the run down per stage.

Inspect a query without involving a model:

```bash
node tests/probe.mjs "sqlite-vec 向量检索" 5 3 github,csdn
```

## Wire protocol

The shell talks to the core one JSON object per line: send a request, read a response.
Because the process is long-lived, the embedding model, SQLite handle and HTTP connection
pool are reused — a warm second call costs ~0.3 s instead of ~5 s.

```jsonl
{"cmd":"search","query":"sqlite-vec","count":5}
{"cmd":"fetch","url":"https://docs.rs/sqlite-vec","maxChars":8000}
{"cmd":"stats"}
```

Errors come back as `{"error":"..."}`. `pi-web-search selftest` runs the built-in offline
checks; `pi-web-search search "查询词"` does a one-shot search and prints the package.

## Layout

```
index.ts            thin TS shell: registerTool + schemas + core client
core/src/main.rs    JSONL protocol loop, one-shot subcommands, selftest
core/src/search.rs  pipeline: search → filter → windowed fetch → confidence → package
core/src/text.rs    SERP parsing, core-text extraction, page classification
core/src/weights.rs source weights, blocklists, site registry, hash embedder, confidence
core/src/adapters.rs  the 12 platform API response parsers
core/src/store.rs   SQLite schema, seeding, search history, fetch cache, vec tables
core/src/embed/     fastembed wrapper + model cache (download with mirror fallback)
tests/              pi-env.mjs (loader helper), shell-test.mjs (shell↔core), probe.mjs
legacy-ts/          the previous pure-TypeScript implementation (reference)
```

## Storage

`~/.pi/agent/web-search.db` (override with `PI_WS_DB_PATH`): `sources` (weights),
`blocked_domains` / `blocked_patterns`, `sites`, `searches` / `results` (history with core
text, weights and confidence), `pages` / `pages_fts` (cache + FTS5), `pages_vec_*`
(sqlite-vec tables, one per embedder). The schema is identical to the legacy TypeScript
build, so an existing database keeps working.

```bash
sqlite3 ~/.pi/agent/web-search.db "SELECT query, fetched_at FROM searches ORDER BY id DESC LIMIT 5"
```

## Design notes

- **One wait window** (`CONTENT_WAIT_MS`, default 3 s, env `PI_WS_CONTENT_WAIT_MS`) bounds the
  content stage; whatever finishes in it is attached, the rest are marked *"not returned
  within the window"* and keep fetching in the background — their text lands in the cache,
  so a repeat search gets them for free.
- **Confidence is a heuristic**, not fact-checking: similarity to the query, domain trust,
  and how many *independent* domains in the same search batch agree.
- **Ranking is Bing's; filtering is ours.** Homepage/list detection, the blocklists and the
  source weights are the levers that shape the result list.
- **Etiquette**: Bing requests are paced ≥1.2 s apart, page fetches are capped per host, and
  pagination requests are skipped entirely (cn.bing.com ignores `first=` for session-less
  clients — verified).

## License

MIT © Kop
