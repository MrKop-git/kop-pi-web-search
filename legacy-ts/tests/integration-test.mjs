// Integration test: load the extension through pi's jiti, register the tools on a
// mock ExtensionAPI, and run web_search's execute() end-to-end over real HTTP —
// no model required. Uses a throwaway DB so it never touches real data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "./pi-env.mjs";

process.env.PI_WS_DB_PATH = join(mkdtempSync(join(tmpdir(), "pi-ws-it-")), "test.db");
process.env.PI_WS_LEGACY_JSON = "/nonexistent/web-sources.json"; // 用内置种子，结果确定

const tools = await loadTools();
console.log("registered tools:", tools.map((t) => t.name));
if (tools.length !== 2) throw new Error(`expected 2 tools, got ${tools.length}`);
for (const t of tools) {
	if (!t.outputSchema) throw new Error(`${t.name}: missing outputSchema`);
	if (!t.parameters) throw new Error(`${t.name}: missing parameters`);
}

const search = tools.find((t) => t.name === "web_search");
const t0 = Date.now();
const result = await search.execute(
	"test-1",
	{ query: "rust sqlite-vec", count: 3, contentTop: 2, contentChars: 200 },
	new AbortController().signal,
	() => {},
	{},
);
console.log(`web_search execute took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const pkg = JSON.parse(result.content[0].text);
console.log("package keys:", Object.keys(pkg));
console.log("meta:", JSON.stringify(pkg.meta));
for (const r of pkg.results) {
	console.log(
		`  [${r.rank}] w=${r.weight} (${r.weightSource}) ${r.title.slice(0, 50)} | content=${r.content ? (r.content.ok ? `ok ${r.content.chars}字 excerpt=${r.content.coreText.length}` : `fail:${r.content.error}`) : "null"}`,
	);
}

// --- assertions ---
const assert = (cond, msg) => {
	if (!cond) throw new Error("FAIL: " + msg);
};
assert(pkg.engine === "bing", "engine");
assert(Array.isArray(pkg.results) && pkg.results.length === 3, "3 results");
assert(pkg.results[0].rank === 1 && pkg.results[2].rank === 3, "ranking");
assert(typeof pkg.results[0].weight === "number", "weight present");
assert(pkg.results[0].content !== undefined, "content field exists");
assert(pkg.meta.contentChars === 200, "meta.contentChars");
assert(typeof pkg.meta.timings?.totalMs === "number", "timings present");
assert(pkg.meta.fetchedPages + pkg.meta.failedPages === pkg.meta.contentTop, "fetch stats consistent");
const fetched = pkg.results.filter((r) => r.content && r.content.ok);
assert(fetched.length >= 1, "at least one page fetched ok");
for (const r of fetched) {
	assert(r.content.coreText.length <= 200, "excerpt bounded");
	if (r.content.coreText.length === 0) {
		assert(r.content.error, "empty content must carry an error note");
	}
}
const dropped = pkg.results.filter((r) => r.content === null);
for (const r of dropped) {
	assert(r.confidence === null, "unfetched results have null confidence");
}
assert(result.structuredContent && result.structuredContent.results.length === 3, "structuredContent present");
assert(result.details.results.length === 3, "details present");

// content JSON and structuredContent must be identical
assert(
	JSON.stringify(result.structuredContent) === JSON.stringify(pkg),
	"structuredContent matches content JSON",
);

console.log("\nINTEGRATION TEST PASSED");
