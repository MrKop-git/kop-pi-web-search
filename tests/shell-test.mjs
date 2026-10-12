// Verifies the thin TS shell talks to the Rust core over the JSONL protocol.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, loadTools } from "./pi-env.mjs";

process.env.PI_WS_BIN = join(REPO_ROOT, "core", "target", "release", "pi-web-search");
process.env.PI_WS_DB_PATH = join(mkdtempSync(join(tmpdir(), "pi-ws-shell-")), "test.db");

const tools = await loadTools();
console.log("tools:", tools.map((t) => t.name));
if (tools.length !== 2) throw new Error(`expected 2 tools, got ${tools.length}`);

const search = tools.find((t) => t.name === "web_search");
const fetchTool = tools.find((t) => t.name === "web_fetch");

const t0 = Date.now();
const res = await search.execute(
	"t1",
	{ query: "rust 所有权 borrow checker", count: 4, contentTop: 3, contentChars: 400 },
	new AbortController().signal,
	() => {},
	{},
);
const pkg = JSON.parse(res.content[0].text);
console.log(`search ${((Date.now() - t0) / 1000).toFixed(1)}s | engine=${pkg.engine} results=${pkg.results.length} fetched=${pkg.meta.fetchedPages}/${pkg.meta.contentTop}`);
console.log("timings:", JSON.stringify(pkg.meta.timings));
for (const r of pkg.results.slice(0, 3)) {
	console.log(`  [${r.rank}] w=${r.weight} conf=${r.confidence} rel=${r.relevance} 印证=${r.support} ${r.title.slice(0, 40)}`);
}
const assert = (c, m) => {
	if (!c) throw new Error("FAIL: " + m);
};
assert(pkg.results.length === 4, "4 results");
assert(typeof pkg.meta.timings.totalMs === "number", "timings present");
assert(pkg.results[0].weight > 0, "weight present");
assert(res.structuredContent.results.length === 4, "structuredContent mirrors content");
assert(JSON.stringify(res.structuredContent) === JSON.stringify(pkg), "structuredContent equals parsed JSON");

// 复用同一个常驻子进程做第二次调用（模型不重复加载）
const t1 = Date.now();
const pkg2 = JSON.parse((await search.execute("t2", { query: "sqlite-vec", count: 3, contentTop: 0 }, new AbortController().signal, () => {}, {})).content[0].text);
console.log(`second call ${((Date.now() - t1) / 1000).toFixed(1)}s | results=${pkg2.results.length} (no page fetch)`);

// web_fetch
const f = await fetchTool.execute("t3", { url: "https://rust-lang.org/zh-CN/", maxChars: 800 }, new AbortController().signal, () => {}, {});
const fp = JSON.parse(JSON.stringify(f.details));
console.log(`fetch: ${fp.chars} chars, weight=${fp.weight}, title=${String(fp.title).slice(0, 40)}`);
assert(fp.chars > 0, "fetched some text");

console.log("\nSHELL TEST PASSED");
process.exit(0); // 常驻子进程会吊住事件循环，测试显式退出
