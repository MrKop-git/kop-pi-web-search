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
         ├─ 14 platform search APIs (github, gitlab, npm, crates, mdn, stackexchange,
         │  hn, juejin, csdn, openalex, openalex-venue, crossref, arxiv, openreview)
         ├─ 头部期刊（TSE/TOSEM/TOPLAS/EMSE、JMLR/TPAMI/AIJ/TACL、软件学报/计算机学报 …）
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
| **Two tools** | `web_search` (discover: results + dates, page bodies only on request) and `web_fetch` (read one page, with `find=` for keyword jumps) |
| **Multi-query** | `queries=[...]` runs up to 4 phrasings in parallel and merges them round-robin, deduplicated by URL — one call instead of four |
| **Filters** | `recencyDays`, `domains` (allow-list), `excludeDomains`, `minWeight`, `sites` — plus `budgetMs` to cap the content stage |
| **Search engine** | Bing SERP scraping with a coherent browser fingerprint and pacing |
| **Site-direct search** | `sites=["github","csdn"]` skips the engine; 14 native APIs, `site:`-scoped Bing for the rest |
| **Journals & venues** | 顶会/期刊信源：`sites=["期刊"]` 只收头部刊——SE/PL 的 TSE/TOSEM/TOPLAS/EMSE，AI/NLP 的 JMLR/TPAMI/AIJ/TACL/CL/Nature MI，以及软件学报/计算机学报，全部走 OpenAlex 按 ISSN 检索（`sites=["tse"]` 单刊直达）；`sites=["顶会"]` 覆盖 OpenReview/NeurIPS/ICML/ACL/USENIX/SIGPLAN/ICSE；另有 `大模型` / `软件工程` 领域标签 |
| **Hot reload** | `cargo build` or an edit to `index.ts` takes effect on the next call — no copy step, no pi restart |
| **Time labels** | every result carries its publish date — from the SERP block, the platform API or the page's own meta/JSON-LD — plus a freshness score |
| **Newest first** | results are sorted by publish date (newest first, undated last) unless `sortBy="relevance"`; freshness also feeds confidence (15%) |
| **Content pages only** | homepages, section roots and list/index pages are dropped before fetching |
| **Core-text extraction** | nav/ads/sidebars/comment blocks/menu lines removed; headings and prose kept |
| **Parallel scheduling** | one wait window bounds the content stage (1.5 s, and only when `includeContent=true`); pages are fetched 16-way, so more pages = more content, not more latency |
| **Trust data** | per-domain weights and two-layer blocklists (domains + keyword patterns) in SQLite |
| **Confidence** | relevance + source weight + cross-source corroboration, from local embeddings |
| **Storage** | SQLite (rusqlite) with sqlite-vec vectors and an FTS5 index over fetched text |
| **Embeddings** | local ONNX (`MultilingualE5Small`, 384-dim) via fastembed; falls back to a built-in hash embedder |

## Install

```bash
git clone https://github.com/MrKop-git/kop-pi-web-search.git \
  ~/.pi/agent/extensions/web-search
cd ~/.pi/agent/extensions/web-search/core && cargo build --release
```

开发时也可以把仓库软链过去，避免每次改完还要拷文件：

```bash
ln -sfn ~/github/kop-pi-web-search ~/.pi/agent/extensions/web-search
```

### Hot reload

改完不用重启 pi，也不用拷文件——两种改动都会在下一步自动生效：

- **Rust 核心**：每次工具调用前解析一次二进制（`core/bin` 与 `core/target/release` 里取较新的，
  `PI_WS_BIN` 优先），并比对指纹（路径 + mtime + 大小）；发现被重建过就把常驻子进程换成新的，
  下一条请求由新核心处理。所以 `cargo build --release` 即生效。
- **TypeScript 壳**：`index.ts` 被监听（`fs.watch` + 300 ms 防抖）；改动后用 pi 自带的 jiti
  按 `moduleCache: false` 重新 import 本模块并重跑工厂，工具与 schema 同名覆盖注册
  （pi 的 `registerTool` 会刷新工具表），旧实例的文件监听、事件订阅与核心子进程同时回收。
  新代码有语法错误时保留当前版本并打日志，不会把扩展搞崩。
  找不到 pi 的 jiti（例如 pi 以打包二进制运行）时只提示，原有功能照常。

`node tests/hot-reload.mjs` 验证两条链路：换掉二进制后下一条请求落到新进程；改 `index.ts` 后工具被重新注册。

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
web_search(query="sqlite-vec 向量检索")
web_search(query="Strata 吞吐优化", queries=["Strata parallel slots", "Strata batch 显存"])   # 多说法一次跑完
web_search(query="code generation", recencyDays=90, domains=["arxiv.org"])                    # 时间窗 + 域名白名单
web_search(query="向量检索", sites=["掘金","中文博客"])                                        # aliases, tags or domains
web_search(query="code generation", sites=["顶会","大模型"])                                   # 会议/领域标签
web_search(query="code generation", sites=["期刊","tse"])                                      # 头部期刊（全量 or 单刊）
web_search(query="rust 所有权", includeContent=true, contentTop=3, budgetMs=4000)              # 显式抓正文
web_fetch(url="https://docs.rs/sqlite-vec")                        # 整页
web_fetch(url="https://doc.rust-lang.org/book/", find="borrow")    # 只回命中行（带行号）
web_fetch(url="https://doc.rust-lang.org/book/", fromLine=120)     # 从第 120 行读下去
```

`web_search` parameters: `query`, `queries` (≤3 extra phrasings), `count` (8), `offset`, `sites`,
`includeContent` (**false**), `contentTop` (8, used only when content is on), `contentChars` (1000),
`minWeight`, `sortBy` (`time` | `relevance`), `recencyDays`, `domains`, `excludeDomains`, `budgetMs`.
`web_fetch` parameters: `url`, `maxChars` (20000), `find`, `fromLine`.

Output is a JSON package — `{ query, engine, fetchedAt, results[], dropped[], meta{} }` —
where every result carries `weight`, `via`, `published` (YYYY-MM-DD or null), `recency`
(0–1, half-life 365 days, 0.5 when undated), `confidence`, `relevance`, `support` and the
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
tests/              pi-env.mjs (loader), shell-test.mjs (shell↔core), hot-reload.mjs, probe.mjs
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

- **Search first, read later**: fetching bodies inside `web_search` is the slow part, so it is off by
  default (`includeContent=false`) — the model gets titles, snippets and dates, then `web_fetch`es the
  page it actually needs. `web_fetch` can jump to a keyword (`find`) or a line (`fromLine`), so reading a
  100 KB page costs a few hundred tokens instead of twenty thousand.
- **One wait window** (`CONTENT_WAIT_MS`, default 1.5 s, env `PI_WS_CONTENT_WAIT_MS`, capped by
  `budgetMs`) bounds the content stage; whatever finishes in it is attached, the rest are marked *"not returned
  within the window"* and keep fetching in the background — their text lands in the cache,
  so a repeat search gets them for free.
- **Freshness**: the date comes from the result block (Bing prints one for most Chinese results),
  the platform API, or the page's own `article:published_time` / `datePublished` when the first two
  are empty. Recency is `0.5^(age/365)`; undated results get a neutral 0.5 rather than a penalty.
- **Confidence is a heuristic**, not fact-checking: 35% similarity to the query, 20% domain trust,
  30% how many *independent* domains in the same batch agree, 15% freshness.
- **Multi-query merging** mirrors what codex/deepseek-harness do: several phrasings, merged round-robin
  and deduplicated by URL. Pipe work runs in parallel, but Bing pacing still costs ≥1.2 s per query, so
  four queries take ~5 s — the saving is round-trips, not wall-clock.
- **External content is labelled**: both tools prefix their output with an untrusted-data notice and a
  cite-your-sources instruction, so page text never reads like a system instruction.
- **Ranking is Bing's; filtering and ordering are ours.** Homepage/list detection, the blocklists,
  the source weights and the `sortBy` date ordering are the levers that shape the result list.
- **Etiquette**: Bing requests are paced ≥1.2 s apart, page fetches are capped per host, and
  pagination requests are skipped entirely (cn.bing.com ignores `first=` for session-less
  clients — verified).
- **Journal sources**: every journal is searched through OpenAlex's ISSN filter — JMLR registers no DOIs,
  so Crossref can't reach it, and one channel keeps the list uniform. Publisher pages (IEEE Xplore, ACM DL)
  block scrapers and OpenReview's forum pages sit behind Cloudflare, so those return titles and abstracts
  but no core text; ACL Anthology and 软件学报 fetch fine. DBLP is behind Anubis, which leaves it a
  weighted source rather than a searchable one.

## License

MIT © Kop
