// Probe the Rust core directly (no pi, no model): one search, human-readable output.
//
// Usage: node tests/probe.mjs "查询词" [count] [contentTop] [sites]
//   env: PI_WS_BIN  path to the pi-web-search binary (default: core/bin, then core/target/release)
//        PI_WS_DB_PATH  database path (default: ~/.pi/agent/web-search.db)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function findBinary() {
	for (const c of [process.env.PI_WS_BIN, join(REPO_ROOT, "core/bin/pi-web-search"), join(REPO_ROOT, "core/target/release/pi-web-search")]) {
		if (c && existsSync(c)) return c;
	}
	console.error("找不到核心二进制：先 `cd core && cargo build --release`，或用 PI_WS_BIN 指定");
	process.exit(1);
}

const query = process.argv[2];
if (!query) {
	console.error('用法: node tests/probe.mjs "查询词" [count] [contentTop] [sites]');
	process.exit(2);
}
const count = Number(process.argv[3] ?? 5);
const contentTop = Number(process.argv[4] ?? 3);
const sites = (process.argv[5] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const request = { cmd: "search", query, count, contentTop, contentChars: 300, ...(sites.length ? { sites } : {}) };
const t0 = Date.now();
const proc = spawnSync(findBinary(), [], { input: `${JSON.stringify(request)}\n`, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
if (proc.error) throw proc.error;
const line = (proc.stdout || "").trim().split("\n").pop() ?? "";
if (!line) {
	console.error(proc.stderr || "核心没有返回内容");
	process.exit(1);
}
const res = JSON.parse(line);
if (res.error) {
	console.error(`核心报错: ${res.error}`);
	process.exit(1);
}
const pkg = res;
const tm = pkg.meta.timings;
console.log(
	`query=${JSON.stringify(query)}${sites.length ? ` sites=${sites.join("+")}` : ""}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
		`[serp ${tm.serpMs}ms / content ${tm.contentMs}ms / embed ${tm.embedMs}ms | pages ${pkg.meta.fetchedPages}/${pkg.meta.contentTop}]`,
);
if (pkg.meta.sites) console.log(`sites: ${pkg.meta.sites.join(", ")}`);
console.log(`\n保留 ${pkg.results.length} 条（w= 信源权重，conf= 置信度，via= 来路）：`);
for (const r of pkg.results) {
	const conf = r.confidence == null ? "—" : `${r.confidence} (rel ${r.relevance} / support ${r.support})`;
	console.log(`  [${r.rank}] via=${r.via} w=${r.weight} conf=${conf}  ${r.title.slice(0, 50)}`);
	console.log(`      ${r.url.slice(0, 100)}`);
}
if (pkg.dropped.length) {
	console.log(`\n丢弃 ${pkg.dropped.length} 条：`);
	for (const d of pkg.dropped) console.log(`  ✕ ${d.reason}  |  ${d.title.slice(0, 50)}`);
}
