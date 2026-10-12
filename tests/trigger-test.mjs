// Verifies the tool-trigger control: guidance is injected into the context as a
// system message, adapted to which tools are active, deduplicated across turns,
// and gated by how often the tools were used this turn.
import { join } from "node:path";
import { REPO_ROOT, loadExtensionModule } from "./pi-env.mjs";

process.env.PI_WS_BIN = join(REPO_ROOT, "core", "target", "release", "pi-web-search");
process.env.PI_WS_DB_PATH = join(REPO_ROOT, "core", "target", "trigger-test.db");

const handlers = new Map();
let activeTools = ["web_search", "web_fetch"];
const tools = [];
const mockPi = {
	registerTool: (tool) => tools.push(tool),
	on: (event, handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
	getActiveTools: () => activeTools,
};
delete process.env.PI_WS_BIN; // 不启动核心：本测试只关心注入的文本

const mod = await loadExtensionModule();
mod.default(mockPi);
if (tools.length !== 2) throw new Error(`expected 2 tools, got ${tools.length}`);

const fire = (event, payload = {}) => {
	let last;
	for (const handler of handlers.get(event) ?? []) last = handler({ type: event, ...payload });
	return last;
};
const contextNote = () => {
	const result = fire("context", { messages: [] });
	const added = result?.messages?.at(-1);
	return added?.role === "system" && !added.content.startsWith("[web-tools]") ? null : (added?.content ?? null);
};
const assert = (condition, message) => {
	if (!condition) throw new Error("FAIL: " + message);
};

// 1) 首次进入上下文：注入基础触发规则
const first = contextNote();
assert(first?.startsWith("[web-tools]"), "first context injects the trigger note");
assert(first.includes("queries=[...]"), "note explains multi-phrasing");
assert(first.includes("web_fetch"), "note points at web_fetch");

// 2) 状态没变就不再注入（避免每轮刷屏）
assert(contextNote() === null, "unchanged state is not re-injected");

// 3) web_fetch 不在可用工具里 → 改成"用 includeContent 拿正文"
activeTools = ["web_search"];
const withoutFetch = contextNote();
assert(withoutFetch?.includes("includeContent=true"), "note adapts when web_fetch is unavailable");
assert(!withoutFetch.includes("read on from a line"), "no fetch advice when fetch is off");

// 4) 用量闸门：搜到阈值后提示别再换词搜
activeTools = ["web_search", "web_fetch"];
fire("turn_start", { turnIndex: 1 });
for (let i = 0; i < 4; i++) fire("tool_execution_start", { toolName: "web_search", toolCallId: `c${i}` });
const capped = contextNote();
assert(capped?.includes("called web_search 4 times"), `soft cap should fire, got: ${capped}`);
assert(capped.includes("stop changing the wording"), "soft cap tells the model to stop re-wording");

// 5) 新一轮重置计数：回到基础版本，不再提次数
fire("turn_start", { turnIndex: 2 });
const reset = contextNote();
assert(reset !== null && !reset.includes("called web_search"), "turn_start resets the usage gate");

console.log("trigger control: injection, adaptation, dedupe and soft caps all behave");
console.log("TRIGGER TEST PASSED");
process.exit(0);
