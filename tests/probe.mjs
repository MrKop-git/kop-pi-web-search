// Probe: run web_search model-free for an arbitrary query and print kept
// results + dropped reasons + stage timings. Uses a throwaway DB unless you
// point PI_WS_DB_PATH at a real one.
//
// Usage: node tests/probe.mjs "查询词" [count] [contentTop] [sites]
//   e.g. node tests/probe.mjs "sqlite-vec" 5 3 github,csdn
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "./pi-env.mjs";

const query = process.argv[2];
if (!query) {
	console.error('用法: node tests/probe.mjs "查询词" [count] [contentTop] [sites]');
	console.error('  例: node tests/probe.mjs "sqlite-vec" 5 3 github,csdn');
	process.exit(2);
}
const count = Number(process.argv[3] ?? 5);
const contentTop = Number(process.argv[4] ?? 2);
const sites = (process.argv[5] ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

process.env.PI_WS_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "pi-ws-probe-")), "test.db");

const tools = await loadTools();
const search = tools.find((t) => t.name === "web_search");
if (!search) throw new Error("web_search tool not registered");

const t0 = Date.now();
const result = await search.execute(
	"probe",
	{ query, count, contentTop, contentChars: 200, ...(sites.length ? { sites } : {}) },
	new AbortController().signal,
	() => {},
	{},
);
const pkg = JSON.parse(result.content[0].text);
const tm = pkg.meta.timings ?? {};
console.log(
	`query=${JSON.stringify(query)}${sites.length ? ` sites=${sites.join("+")}` : ""}  ` +
		`${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
		`[serp ${tm.serpMs}ms / content ${tm.contentMs}ms / embed ${tm.embedMs}ms | pages ${pkg.meta.fetchedPages}/${pkg.meta.contentTop}]`,
);

console.log(`\n保留 ${pkg.results.length} 条（via= 来路，conf= 置信度）：`);
for (const r of pkg.results) {
	const conf =
		r.confidence === null || r.confidence === undefined
			? "—"
			: `${r.confidence} (rel ${r.relevance} / support ${r.support})`;
	console.log(`  [${r.rank}] via=${r.via} w=${r.weight} conf=${conf}  ${r.title.slice(0, 50)}`);
}
if (pkg.dropped.length) {
	console.log(`\n丢弃 ${pkg.dropped.length} 条：`);
	for (const d of pkg.dropped) console.log(`  ✕ ${d.reason}  |  ${d.title.slice(0, 50)}`);
}
