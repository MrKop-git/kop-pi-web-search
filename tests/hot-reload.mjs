// Verifies the shell hot-reloads a rebuilt core binary: after the file changes,
// the next request goes to a fresh child process — no pi restart, no manual copy.
import { copyFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, loadTools } from "./pi-env.mjs";

const BUILT = join(REPO_ROOT, "core", "target", "release", "pi-web-search");
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

console.error = realError;
const reloads = stderr.filter((l) => l.includes("热重载"));
const starts = stderr.filter((l) => l.includes("ready db="));
if (reloads.length !== 1) throw new Error(`期望 1 次热重载，实际 ${reloads.length}：${stderr.join(" | ")}`);
if (starts.length !== 2) throw new Error(`期望 2 个核心进程（初次 + 重载），实际 ${starts.length}`);

console.log(`hot reload: ${starts.length} core processes, ${reloads.length} reload`);
console.log("HOT RELOAD TEST PASSED");
