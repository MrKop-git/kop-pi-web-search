// Verifies both hot-reload paths of the shell:
//   1. a rebuilt Rust core binary is swapped in on the next request (no copy, no restart)
//   2. an edited index.ts re-registers the tools through pi's own jiti (no /reload)
import { copyFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, loadTools } from "./pi-env.mjs";

const BUILT = join(REPO_ROOT, "core", "target", "release", "pi-web-search");

// ---------------------------------------------------------------- 1) 核心二进制

const workDir = mkdtempSync(join(tmpdir(), "pi-ws-hot-"));
const bin = join(workDir, "pi-web-search");
copyFileSync(BUILT, bin);

process.env.PI_WS_BIN = bin;
process.env.PI_WS_DB_PATH = join(workDir, "test.db");
process.env.PI_WS_LEGACY_JSON = "/nonexistent";

const stderr = [];
const realError = console.error;
console.error = (...args) => stderr.push(args.join(" "));

const tools = await loadTools();
const fetchTool = tools.find((t) => t.name === "web_fetch");
const call = (id) =>
	fetchTool.execute(id, { url: "https://example.com/", maxChars: 400 }, new AbortController().signal, () => {}, {});

const first = await call("t1");
if (!first.content?.[0]?.text) throw new Error("第一次抓取没有返回内容");

// 模拟 `cargo build --release` 产出的新二进制：文件被重写，mtime 变新
const future = new Date(Date.now() + 5000);
utimesSync(bin, future, future);

const second = await call("t2");
if (!second.content?.[0]?.text) throw new Error("热重载之后的抓取没有返回内容");

const reloads = stderr.filter((l) => l.includes("热重载"));
const starts = stderr.filter((l) => l.includes("ready db="));
if (reloads.length !== 1) throw new Error(`期望 1 次核心热重载，实际 ${reloads.length}：${stderr.join(" | ")}`);
if (starts.length !== 2) throw new Error(`期望 2 个核心进程（初次 + 重载），实际 ${starts.length}`);
realError(`core binary reload: ${starts.length} core processes, ${reloads.length} reload`);

// ---------------------------------------------------------------- 2) TS 壳

const extDir = mkdtempSync(join(tmpdir(), "pi-ws-tshot-"));
const extPath = join(extDir, "index.ts");
const source = readFileSync(join(REPO_ROOT, "index.ts"), "utf8");
const marker = "HOT-RELOAD-MARKER-42";
writeFileSync(extPath, source);
copyFileSync(extPath, join(extDir, "index.ts.orig"));

const reloaded = await loadTools(extPath);
const before = reloaded.length;
if (before !== 2) throw new Error(`初次加载应有 2 个工具，实际 ${before}`);

// 改一行描述，等 watchSelf 的防抖（300 ms）过去
const edited = source.replace('description:\n\t\t\t"Search the web', `description:\n\t\t\t"${marker} search the web`);
if (edited === source) throw new Error("测试没改到内容：找不到要替换的描述");
writeFileSync(extPath, edited);

const deadline = Date.now() + 8000;
while (Date.now() < deadline && !reloaded.some((t) => String(t.description).includes(marker))) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}
console.error = realError;

const newTools = reloaded.filter((t) => String(t.description).includes(marker));
if (newTools.length === 0) throw new Error(`TS 改动后没有重新注册工具（共 ${reloaded.length} 次注册）`);
if (reloaded.length !== before + 2) throw new Error(`期望重载后共 4 次注册，实际 ${reloaded.length}`);
if (newTools.length !== 1 || newTools[0].name !== "web_search") throw new Error(`重载后带标记的工具不对：${newTools.map((t) => t.name)}`);
const fetchRegistrations = reloaded.filter((t) => t.name === "web_fetch").length;
if (fetchRegistrations !== 2) throw new Error(`web_fetch 应该注册两次（旧 + 重载后），实际 ${fetchRegistrations}`);

console.log(`ts shell reload: ${reloaded.length} registrations, marker landed on ${newTools.map((t) => t.name).join("+")}`);
console.log("HOT RELOAD TEST PASSED");
