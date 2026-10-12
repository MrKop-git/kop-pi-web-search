# kop-pi-web-search

Local-first web search & page-fetching extension for the [pi coding agent](https://pi.dev).
No API keys, no quotas, no MCP servers — it scrapes one search engine (Bing), talks to a
dozen platform search APIs, stores everything in SQLite, and scores how much you should
trust what it found.

```
Bing SERP ─┐
           ├─► filter (content pages only, blacklist, source weights)
12 site    │        │
  APIs ────┘        ▼
              parallel page fetch (16-way) ──► core-text extraction
                        │
                        ▼
              SQLite (+ sqlite-vec)  ──►  ONNX embeddings  ──►  confidence score
                        │
                        ▼
              JSON package (content + structuredContent)
```

## Features

| | |
|---|---|
| **Two tools** | `web_search` (search + fetch + dedupe + score) and `web_fetch` (one URL → core text) |
| **Search engine** | Bing SERP scraping with a coherent browser fingerprint, cookie warm-up, per-host pacing |
| **Site-direct search** | `sites=["github","csdn"]` skips the engine; 12 native APIs: GitHub, GitLab, npm, crates.io, MDN, StackExchange, Hacker News, Juejin, CSDN, OpenAlex, CrossRef, arXiv (docs.rs / Zhihu fall back to `site:` scoping) |
| **Content pages only** | Homepages, section roots and list/index pages are dropped before fetching |
| **Core-text extraction** | Boilerplate (nav/ads/sidebars/comment blocks/menu lines) removed; headings and prose kept |
| **Parallel scheduling** | Pages are fetched concurrently (16-way) inside a fixed wait window — fetching more pages costs no extra wall-clock time |
| **Source weights + blacklist** | Per-domain trust weights and two-layer blocklists (domains + keyword patterns) in SQLite |
| **Confidence scoring** | relevance (40%) + source weight (25%) + cross-source corroboration (35%), using local embeddings |
| **Storage** | SQLite via Node's built-in `node:sqlite` (SQLite 3.53) + `sqlite-vec` 0.1.9; FTS5 index over fetched text |
| **Embeddings** | Local ONNX (bge-small-zh-v1.5 int8, 512-dim) through onnxruntime-web (wasm); falls back to a built-in hash embedder if the vendor files are missing |
| **JSON output** | Results, dropped items and stage timings as one JSON package, mirrored into `structuredContent` |

## Install

```bash
git clone https://github.com/MrKop-git/kop-pi-web-search.git \
  ~/.pi/agent/extensions/web-search
cd ~/.pi/agent/extensions/web-search
./scripts/fetch-vendor.sh          # ~38 MB: sqlite-vec + onnxruntime-web + embedding model
```

Behind the Great Firewall:

```bash
HF_ENDPOINT=https://hf-mirror.com ./scripts/fetch-vendor.sh
```

The vendor step is optional — without it the extension still runs, just without vectors/FTS
caching and with the built-in hash embedder instead of the ONNX model.

Restart pi (or `/reload`) and the two tools are available.

## Usage

```
web_search(query="sqlite-vec", count=8, contentTop=8)
web_search(query="向量检索", sites=["掘金","知识库"])      # aliases, tags or domains
web_search(query="RAG", sites=["学术"])                    # tag → openalex/crossref/arxiv
web_fetch(url="https://docs.rs/sqlite-vec")
```

Run a query without a model to inspect what the pipeline does:

```bash
node tests/probe.mjs "sqlite-vec 向量检索" 5 3 github,csdn
```

### `web_search` parameters

| param | default | meaning |
|---|---|---|
| `query` | — | search terms (Bing operators supported: `site:`, `filetype:`, `"…"`, `-word`) |
| `count` | 8 | results to return |
| `offset` | 0 | result offset |
| `sites` | — | site aliases/tags/domains → skip the engine, search those sites |
| `includeContent` | true | fetch result pages and attach core text |
| `contentTop` | 8 | how many results to fetch in parallel |
| `contentChars` | 1000 | core-text excerpt length per result |
| `minWeight` | — | drop results below this source weight |

Output is a JSON package: `{ query, engine, fetchedAt, results[], dropped[], meta{} }`, where
each result carries `weight`, `via` (which backend found it), `confidence`, `relevance`,
`support` and the fetched `content`. `meta.timings` reports per-stage milliseconds.

## How the scheduling works

The content stage has **one knob**: a wait window (`CONTENT_WAIT_MS`, default 3 s,
override with `PI_WS_CONTENT_WAIT_MS`). Pages are fetched with 16-way concurrency; whatever
finishes inside the window is attached, the rest are marked *"not returned within the window"*
and keep fetching in the background — their text lands in the cache, so a repeat search gets
them for free. Because the wait is bounded by the window (not by the page count), raising
`contentTop` buys more content without buying more latency.

Measured on the author's machine (cold process, three queries):

| | before | after |
|---|---|---|
| latency | 6.4 s / 6.5 s / 15.4 s | 3.6 – 5.2 s (worst case gone) |
| pages with content | 2–3 | 3–6 |

## Storage

Everything lives in `~/.pi/agent/web-search.db` (override with `PI_WS_DB_PATH`):

| table | contents |
|---|---|
| `sources` | domain → trust weight |
| `blocked_domains` / `blocked_patterns` | blacklists |
| `sites` | site registry (alias → domain, tags, adapter) |
| `searches` / `results` | search history with core text, weights and confidence |
| `pages` / `pages_fts` | fetch cache + FTS5 index |
| `pages_vec_*` | sqlite-vec vector tables, one per embedder |

```bash
sqlite3 ~/.pi/agent/web-search.db "SELECT query, fetched_at FROM searches ORDER BY id DESC LIMIT 5"
sqlite3 ~/.pi/agent/web-search.db "UPDATE sources SET weight = 0.1 WHERE host = 'example.com'"
```

## Tests

```bash
node tests/web-search-core.test.mjs   # pure functions: parsing, extraction, weights, embeddings
node tests/db.test.mjs                # SQLite layer: seeding, history, cache TTL, FTS, vectors
node tests/integration-test.mjs       # full pipeline over real HTTP, mock pi, no model needed
node tests/probe.mjs "查询词" 5 3 csdn  # inspect one query: kept/dropped + timings
```

They use throwaway databases and auto-discover pi's install directory (override with
`PI_AGENT_DIR`).

## Design notes

- **Degradation chain** — ONNX embedder → hash embedder; sqlite-vec → FTS-only. Missing
  vendor files never break a search.
- **Confidence is a heuristic**, not fact-checking: lexical/semantic similarity to the query,
  domain trust, and how many *independent* sources (different domains, same search batch)
  say something similar.
- **Corroboration is computed within one search batch** — page-level similarity across
  unrelated queries proved unreliable (same/different-topic distributions overlap).
- **Bing pagination is ignored on purpose**: cn.bing.com returns page 1 for session-less
  clients regardless of `first=` / next-page links, so no extra pagination requests are made.
- **Etiquette**: Bing requests are paced (≥1.2 s apart) and page fetches are capped per host,
  so a search never hammers a single origin.

## Requirements

- Node with `node:sqlite` (Node ≥ 22.5) — tests are run on Node 26
- pi ≥ 1.1 (extension API: `registerTool`, `outputSchema` / `structuredContent`)

## License

MIT © Kop
