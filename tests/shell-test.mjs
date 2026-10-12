// Verifies the thin TS shell talks to the Rust core over the JSONL protocol:
// multi-query merge, default (no) page fetching, filters, and find-in-page.
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
const assert = (condition, message) => {
	if (!condition) throw new Error("FAIL: " + message);
};
const noop = () => {};
const signal = () => new AbortController().signal;

// 1) 多查询：一次调用里并发跑 3 个说法，合并去重；默认不抓正文
const t0 = Date.now();
const res = await search.execute(
	"t1",
	{ query: "rust 所有权", queries: ["rust borrow checker 报错", "rust 借用检查 生命周期"], count: 6 },
	signal(),
	noop,
	{},
);
const pkg = res.structuredContent;
console.log(
	`multi-query  ${((Date.now() - t0) / 1000).toFixed(1)}s | queries=${pkg.meta.queries.length} results=${pkg.results.length} fetched=${pkg.meta.fetchedPages}`,
);
assert(pkg.meta.queries.length === 3, "3 queries merged");
assert(pkg.results.length === 6, "6 results");
assert(pkg.meta.includeContent === false, "content off by default");
assert(pkg.results.every((r) => r.content === null), "no page bodies by default");
assert(pkg.results.some((r) => r.published), "some results carry a date");
assert(typeof pkg.meta.timings.totalMs === "number", "timings present");
assert(pkg.results[0].weight > 0, "weight present");
assert(res.content[0].text.includes("untrusted"), "untrusted notice in the text output");
assert(res.content[0].text.includes("markdown links"), "cite instruction in the text output");
assert(JSON.stringify(res.structuredContent) === JSON.stringify(res.details), "structuredContent mirrors details");

// 2) 过滤器：域名白名单（站内直达 + 只留 github.com）
const filtered = (
	await search.execute("t2", { query: "sqlite-vec", count: 5, sites: ["github"], domains: ["github.com"] }, signal(), noop, {})
).structuredContent;
const hosts = filtered.results.map((r) => new URL(r.url).hostname);
console.log(`filters      results=${filtered.results.length} hosts=${[...new Set(hosts)].join(",")}`);
assert(filtered.results.length > 0, "allow-listed results present");
assert(hosts.every((h) => h === "github.com" || h.endsWith(".github.com")), "allow-list respected");

// 2b) 时间窗：要么结果都在窗口内，要么因超期被丢（两种都能证明过滤器在跑）
const daysAgo = (date) => Math.round((Date.now() - Date.parse(date)) / 86_400_000);
try {
	const recent = (await search.execute("t2b", { query: "rust 所有权", count: 5, recencyDays: 30 }, signal(), noop, {})).structuredContent;
	const older = recent.results.filter((r) => r.published && daysAgo(r.published) > 30);
	console.log(`recency      results=${recent.results.length} 超窗=${older.length}`);
	assert(older.length === 0, "no result older than the window");
} catch (error) {
	assert(String(error.message).includes("recencyDays"), `expected recency drops, got: ${error.message}`);
	console.log("recency      全部结果超期被丢弃（过滤器生效）");
}

// 3) 抓正文：显式 includeContent 才抓
const withContent = (
	await search.execute("t3", { query: "sqlite-vec", count: 3, includeContent: true, contentTop: 2, contentChars: 300, budgetMs: 3000 }, signal(), noop, {})
).structuredContent;
console.log(`with content  fetched=${withContent.meta.fetchedPages}/${withContent.meta.contentTop} budget=${withContent.meta.contentChars}`);
assert(withContent.meta.includeContent === true, "content on when asked");

// 4) web_fetch：整页 / find 定位
const page = (
	await fetchTool.execute("t4", { url: "https://rust-lang.org/zh-CN/", maxChars: 800 }, signal(), noop, {})
).structuredContent;
console.log(`fetch        ${page.chars} chars, ${page.totalLines} lines, weight=${page.weight}`);
assert(page.chars > 0, "fetched some text");
assert(page.totalLines > 0, "line count reported");
assert(page.matchedLines === null, "no find → matchedLines null");

const found = (
	await fetchTool.execute("t5", { url: "https://rust-lang.org/zh-CN/", maxChars: 4000, find: "Rust" }, signal(), noop, {})
).details;
console.log(`find         matched=${found.matchedLines} lines, ${found.coreText.length} chars`);
assert(found.matchedLines > 0, "find matched lines");
assert(/^\d+: /m.test(found.coreText), "matched lines carry numbers");

console.log("\nSHELL TEST PASSED");
process.exit(0); // 常驻子进程会吊住事件循环，测试显式退出
