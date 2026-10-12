// Shared test helper: load this extension through the jiti copy that ships with
// pi (same loader pi itself uses), so tests exercise the real module graph.
//
// pi's install dir is auto-discovered; override with PI_AGENT_DIR pointing at
// the node_modules directory that contains `jiti` and `@earendil-works/…`.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const VENDOR_DIR = join(REPO_ROOT, "vendor");

function findPiNodeModules() {
	if (process.env.PI_AGENT_DIR) return process.env.PI_AGENT_DIR;
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	if (existsSync(releases)) {
		for (const version of readdirSync(releases).sort().reverse()) {
			const nm = join(releases, version, "node_modules");
			if (existsSync(join(nm, "jiti"))) return nm;
		}
	}
	throw new Error(
		"找不到 pi 的安装目录（需要其中的 jiti 来加载 TypeScript 扩展）。\n" +
			"请设置环境变量 PI_AGENT_DIR 指向包含 jiti 的 node_modules 目录。",
	);
}

/** Import the extension module (default export = the factory) via pi's jiti. */
export async function loadExtensionModule(extensionPath = join(REPO_ROOT, "index.ts")) {
	const nm = findPiNodeModules();
	const { createJiti } = await import(join(nm, "jiti", "lib", "jiti.mjs"));
	const require = createRequire(join(nm, "@earendil-works/pi-coding-agent", "package.json"));
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		alias: {
			typebox: require.resolve("typebox"),
			"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
		},
	});
	return jiti.import(extensionPath);
}

/** Register the extension against a mock ExtensionAPI and return its tools. */
export async function loadTools(extensionPath) {
	const mod = await loadExtensionModule(extensionPath);
	const tools = [];
	mod.default({ registerTool: (t) => tools.push(t), on: () => () => {} });
	return tools;
}
