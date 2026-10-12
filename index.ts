/**
 * Web Search Extension for pi — thin TypeScript shell around the Rust core.
 *
 * 两个工具（web_search / web_fetch）注册在 TS 侧（pi 的扩展 API 只吃 TS/JS），
 * 实际工作由 Rust 二进制完成：它常驻一个子进程，逐行收发 JSON，因此
 * 嵌入模型只加载一次、SQLite 连接与 HTTP 连接池跨调用复用。
 *
 * 热重载：
 * - Rust 核心：每次请求前比对二进制指纹，被重建过就换子进程（见 CoreClient）。
 *   二进制取 core/bin 与 core/target/release 里较新的那个，`cargo build --release` 即生效。
 * - TS 壳：watchSelf 盯着本文件，改动后用 pi 自带的 jiti（moduleCache: false）重新 import
 *   本模块并重跑工厂——registerTool 同名覆盖并刷新工具表，所以连 schema 一起生效。
 *   不用再敲 /reload；jiti 找不到时（例如 pi 以打包二进制运行）只提示，不影响原有功能。
 *
 * 数据库：PI_WS_DB_PATH 或 ~/.pi/agent/web-search.db
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

/** 构建产物的候选位置（按存在性 + 新旧挑） */
function binaryCandidates(): string[] {
	return [
		join(EXTENSION_DIR, "core", "bin", "pi-web-search"),
		join(EXTENSION_DIR, "core", "target", "release", "pi-web-search"),
	];
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return -1;
	}
}

/** 二进制指纹：路径 + mtime + 大小，用来判断"是不是刚重建过" */
function stampOf(path: string): string {
	try {
		const s = statSync(path);
		return `${path}:${s.mtimeMs}:${s.size}`;
	} catch {
		return `${path}:missing`;
	}
}

function findBinary(): string | null {
	const explicit = process.env.PI_WS_BIN;
	if (explicit) return existsSync(explicit) ? explicit : null;
	let best: { path: string; mtime: number } | null = null;
	for (const candidate of binaryCandidates()) {
		if (!existsSync(candidate)) continue;
		const mtime = mtimeOf(candidate);
		if (!best || mtime > best.mtime) best = { path: candidate, mtime };
	}
	return best?.path ?? null;
}

const MISSING_BINARY =
	"未找到 Rust 核心二进制。请先构建：cd core && cargo build --release\n" +
	`（查找位置：${binaryCandidates().join("、")}，或用 PI_WS_BIN 指定）`;

// ---------------------------------------------------------------- self hot reload

const RELOAD_DEBOUNCE_MS = 300;

/** pi 的 node_modules：自带 jiti / typebox / pi-tui，重新加载本模块要用它 */
function findPiNodeModules(): string | null {
	const override = process.env.PI_AGENT_DIR;
	if (override && existsSync(join(override, "jiti"))) return override;
	const releases = join(homedir(), ".pi", "agent", "install", "releases");
	try {
		for (const version of readdirSync(releases).sort().reverse()) {
			const nodeModules = join(releases, version, "node_modules");
			if (existsSync(join(nodeModules, "jiti"))) return nodeModules;
		}
	} catch {
		// 目录不存在就是没有：返回 null，让调用方退化成"提示用户 /reload"
	}
	return null;
}

/**
 * 重新加载本模块（拿到改动后的工厂）。
 * pi 用 `moduleCache: false` 加载扩展，所以同一个文件重新 import 会重新执行；
 * 新模块的 import 需要同样的别名，才能解析到 typebox / pi-tui。
 */
async function reloadSelfFactory(): Promise<(pi: ExtensionAPI) => unknown> {
	const nodeModules = findPiNodeModules();
	if (!nodeModules) throw new Error("找不到 pi 的 node_modules（jiti），请用 /reload 重载扩展");
	const { createRequire } = await import("node:module");
	const require = createRequire(join(nodeModules, "@earendil-works", "pi-coding-agent", "package.json"));
	const { createJiti } = await import(pathToFileURL(join(nodeModules, "jiti", "lib", "jiti.mjs")).href);
	const jiti = createJiti(pathToFileURL(SELF_PATH).href, {
		moduleCache: false,
		alias: {
			typebox: require.resolve("typebox"),
			"@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
		},
	});
	const factory = await jiti.import(SELF_PATH, { default: true });
	if (typeof factory !== "function") throw new Error("重新加载后的模块没有导出工厂函数");
	return factory as (pi: ExtensionAPI) => unknown;
}

/** 盯着扩展目录，自己的源码一改就回调（编辑器换文件是 rename，所以监听目录而不是单文件） */
function watchSelf(onChange: () => void): () => void {
	const own = basename(SELF_PATH);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(dirname(SELF_PATH), (_event, filename) => {
			const name = filename ? String(filename) : "";
			if (name && name !== own && !name.endsWith(".ts")) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				onChange();
			}, RELOAD_DEBOUNCE_MS);
		});
		watcher.on("error", () => {});
	} catch {
		return () => {};
	}
	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
	};
}

// ---------------------------------------------------------------- JSON schemas

const PageContentSchema = Type.Object({
	ok: Type.Boolean(),
	title: Type.String(),
	coreText: Type.String(),
	published: Type.Union([Type.String(), Type.Null()], { description: "页面自带时间（YYYY-MM-DD）" }),
	chars: Type.Integer(),
	error: Type.Union([Type.String(), Type.Null()]),
});

const PackagedResultSchema = Type.Object({
	rank: Type.Integer(),
	title: Type.String(),
	url: Type.String(),
	weight: Type.Number(),
	weightSource: Type.Union([Type.String(), Type.Null()]),
	via: Type.String(),
	snippet: Type.String(),
	published: Type.Union([Type.String(), Type.Null()], { description: "发布时间（YYYY-MM-DD），取不到为 null" }),
	content: Type.Union([PageContentSchema, Type.Null()]),
	confidence: Type.Union([Type.Number(), Type.Null()]),
	relevance: Type.Union([Type.Number(), Type.Null()]),
	support: Type.Union([Type.Integer(), Type.Null()]),
	recency: Type.Union([Type.Number(), Type.Null()], { description: "新鲜度 0~1，半衰期 365 天，无日期为 0.5" }),
});

const SearchPackageSchema = Type.Object({
	query: Type.String(),
	engine: Type.String(),
	fetchedAt: Type.String(),
	results: Type.Array(PackagedResultSchema),
	dropped: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			weight: Type.Number(),
			reason: Type.String(),
		}),
	),
	meta: Type.Object({
		count: Type.Integer(),
		offset: Type.Integer(),
		includeContent: Type.Boolean(),
		contentTop: Type.Integer(),
		contentChars: Type.Integer(),
		minWeight: Type.Union([Type.Number(), Type.Null()]),
		fetchedPages: Type.Integer(),
		failedPages: Type.Integer(),
		sites: Type.Union([Type.Array(Type.String()), Type.Null()]),
		sortBy: Type.String(),
		timings: Type.Object({
			serpMs: Type.Integer(),
			contentMs: Type.Integer(),
			embedMs: Type.Integer(),
			totalMs: Type.Integer(),
		}),
	}),
});

const FetchPackageSchema = Type.Object({
	url: Type.String(),
	finalUrl: Type.String(),
	title: Type.String(),
	weight: Type.Number(),
	weightSource: Type.Union([Type.String(), Type.Null()]),
	contentType: Type.String(),
	coreText: Type.String(),
	chars: Type.Integer(),
	truncated: Type.Boolean(),
});

// ---------------------------------------------------------------- parameters

const WebSearchParams = Type.Object({
	query: Type.String({ description: "搜索关键词，支持 Bing 语法：site:example.com、filetype:pdf、\"精确短语\"、-排除词" }),
	count: Type.Optional(Type.Integer({ description: "返回结果条数（默认 8，最大 20）", minimum: 1, maximum: 20 })),
	offset: Type.Optional(Type.Integer({ description: "结果偏移量（默认 0）", minimum: 0 })),
	sites: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"站内直达：站点别名/标签/域名（如 [\"github\"]、[\"代码\",\"csdn\"]、[\"顶会\"]、[\"期刊\"]）。提供后跳过搜索引擎，只搜这些站" +
				"（github/gitlab/npm/crates/mdn/stackoverflow/hn/juejin/csdn/openalex/crossref/arxiv/openreview 走原生 API，" +
				"tse/tosem/toplas/emse/tpami/jmlr/aij/tacl/cl 等头部期刊走 OpenAlex 按 ISSN 检索，其余用 site: 检索）",
		}),
	),
	includeContent: Type.Optional(Type.Boolean({ description: "抓取结果页并附核心文本（默认 true）" })),
	contentTop: Type.Optional(Type.Integer({ description: "并发抓取的结果条数（默认 8；并行抓取，多抓不额外增加等待）", minimum: 0, maximum: 20 })),
	contentChars: Type.Optional(Type.Integer({ description: "每条结果附带的核心文本字数（默认 1000）", minimum: 200, maximum: 5000 })),
	minWeight: Type.Optional(Type.Number({ description: "信源权重下限（0~1），低于该权重的结果丢弃", minimum: 0, maximum: 1 })),
	sortBy: Type.Optional(
		Type.Union([Type.Literal("time"), Type.Literal("relevance")], {
			description: "结果排序：time（默认）按发布时间倒序、越新越前，没有日期的排在后面；relevance 保持引擎原序",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "要抓取的网页 URL（http/https）" }),
	maxChars: Type.Optional(Type.Integer({ description: "返回正文最大字符数（默认 20000）", minimum: 500, maximum: 100000 })),
});

// ---------------------------------------------------------------- core client

interface CoreResponse {
	error?: string;
	[key: string]: unknown;
}

/**
 * 常驻 Rust 核心客户端：一行请求 → 一行响应，请求串行化（核心内部已并行抓取）。
 *
 * 热重载：每次请求前比对二进制的指纹（路径 + mtime + 大小），发现 `cargo build`
 * 换过文件就把旧子进程换掉，下一条请求由新核心处理——不必重启 pi。
 * 二进制第一次出现也认（pi 先启动、后构建的场景）。
 */
class CoreClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private childStamp = "";
	private buffer = "";
	private pending: Array<{ resolve: (v: CoreResponse) => void; reject: (e: Error) => void }> = [];
	private queue: Promise<unknown> = Promise.resolve();

	/** 二进制没变就复用常驻进程，变了（或还没起来）就重新拉一个 */
	private ensureChild(): ChildProcessWithoutNullStreams {
		const bin = findBinary();
		if (!bin) throw new Error(MISSING_BINARY);
		const stamp = stampOf(bin);
		if (this.child && !this.child.killed && this.childStamp === stamp) return this.child;

		if (this.child) {
			console.error(`[pi-web-search] 检测到核心二进制更新，热重载 ${bin}`);
			this.shutdown();
		}
		this.childStamp = stamp;

		const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (line: string) => {
			const text = String(line).trim();
			if (text) console.error(`[pi-web-search] ${text}`);
		});
		child.on("exit", () => {
			// 被热重载替换掉的旧进程退出时，等待队列已经属于新进程，不能动
			if (this.child !== child) return;
			this.child = null;
			this.childStamp = "";
			const pending = this.pending;
			this.pending = [];
			for (const p of pending) p.reject(new Error("核心进程退出"));
		});
		this.child = child;
		return child;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const waiter = this.pending.shift();
			if (!waiter) continue;
			try {
				waiter.resolve(JSON.parse(line) as CoreResponse);
			} catch (err) {
				waiter.reject(new Error(`核心返回了非 JSON 内容: ${line.slice(0, 200)}`));
			}
		}
	}

	/** 关闭常驻子进程（pi 会话结束/重载、或换二进制时调用） */
	shutdown(): void {
		const child = this.child;
		this.child = null;
		this.childStamp = "";
		this.buffer = "";
		if (child && !child.killed) {
			child.stdin.end();
			child.kill();
		}
	}

	/** 等在途请求收尾——热重载时别把正在跑的工具调用打断 */
	async whenIdle(): Promise<void> {
		await this.queue.catch(() => undefined);
	}

	/** 发送一个请求；同一时刻只允许一个在途请求，保证响应顺序可对应 */
	request(payload: Record<string, unknown>): Promise<CoreResponse> {
		const run = this.queue.then(() => this.send(payload));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private send(payload: Record<string, unknown>): Promise<CoreResponse> {
		return new Promise<CoreResponse>((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			try {
				child = this.ensureChild();
			} catch (err) {
				reject(err as Error);
				return;
			}
			this.pending.push({ resolve, reject });
			child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
				if (err) reject(err);
			});
		});
	}
}

// ---------------------------------------------------------------- extension

export default function webSearchExtension(pi: ExtensionAPI) {
	const client = new CoreClient();
	const disposers: Array<() => void> = [];
	let reloading = false;

	const dispose = async (): Promise<void> => {
		for (const off of disposers.splice(0)) {
			try {
				off();
			} catch {
				// 取消订阅失败无所谓：下面还会换掉整个实例
			}
		}
		await client.whenIdle();
		client.shutdown();
	};

	const stopWatching = watchSelf(() => {
		void reload();
	});

	/**
	 * 热重载：先取到新代码（语法错就保留当前版本），再拆掉旧实例，最后跑新工厂。
	 * 工具是同名覆盖注册的，所以 schema 也跟着更新。
	 */
	async function reload(): Promise<void> {
		if (reloading) return;
		reloading = true;
		try {
			const factory = await reloadSelfFactory();
			stopWatching();
			await dispose();
			await factory(pi);
			console.error("[pi-web-search] index.ts 有改动，已热重载扩展（工具与 schema 均已更新）");
		} catch (error) {
			console.error(`[pi-web-search] 热重载失败，继续用当前版本：${error instanceof Error ? error.message : String(error)}（如需重来请 /reload）`);
		} finally {
			reloading = false;
		}
	}

	// 会话结束/重载时收回子进程与文件监听（二进制更新由 ensureChild 自己处理）
	if (typeof pi.on === "function") {
		disposers.push(
			pi.on("session_shutdown", () => {
				stopWatching();
				void dispose();
			}),
		);
	}

	pi.registerTool({
		name: "web_search",
		label: "web search",
		description:
			"Search the web (Bing SERP or site-direct APIs) and concurrently fetch the top result pages, returning core text plus a source-trust weight and a confidence score. " +
			"Only content pages are returned — homepages and list/index pages are dropped; junk sources are excluded via the blacklist. " +
			"Pass sites=[\"github\",\"csdn\"] to skip the search engine and search those sites directly. " +
			"Every result carries its publish date (published) and a freshness score (recency), and results are sorted newest-first unless sortBy=\"relevance\". " +
			"Returns a JSON package: results (with weight, via, published, confidence, relevance, support and fetched core text), dropped items and stage timings.",
		parameters: WebSearchParams,
		outputSchema: SearchPackageSchema,
		namespace: { name: "web", description: "Web search and page fetching (Rust core)" },
		annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const res = await client.request({ cmd: "search", ...(params as Record<string, unknown>) });
			if (res.error) throw new Error(res.error);
			const pkg = res as unknown as Record<string, unknown>;
			return {
				content: [{ type: "text", text: JSON.stringify(pkg, null, 2) }],
				structuredContent: pkg,
				details: pkg,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", JSON.stringify(args.query ?? "")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const pkg = result.details as
				| { results?: unknown[]; dropped?: unknown[]; meta?: { fetchedPages?: number; timings?: { totalMs?: number } } }
				| undefined;
			if (isPartial) return new Text(theme.fg("warning", "Searching + fetching..."), 0, 0);
			if (!pkg?.results) return new Text(theme.fg("dim", "No results"), 0, 0);
			let text = theme.fg("success", `${pkg.results.length} results`);
			if (pkg.meta?.fetchedPages) text += theme.fg("muted", ` · ${pkg.meta.fetchedPages} pages`);
			if (pkg.dropped?.length) text += theme.fg("muted", ` · ${pkg.dropped.length} dropped`);
			if (pkg.meta?.timings?.totalMs) text += theme.fg("dim", ` · ${pkg.meta.timings.totalMs}ms`);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "web fetch",
		description:
			"Fetch a web page over HTTP(S) and return its core text (boilerplate, nav, ads and menus removed), with the source-trust weight. " +
			"Follows redirects and reuses the local fetch cache.",
		parameters: WebFetchParams,
		outputSchema: FetchPackageSchema,
		namespace: { name: "web", description: "Web search and page fetching (Rust core)" },
		annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const res = await client.request({ cmd: "fetch", ...(params as Record<string, unknown>) });
			if (res.error) throw new Error(res.error);
			const pkg = res as unknown as Record<string, unknown>;
			const header = [
				pkg.title ? `# ${pkg.title}` : null,
				`URL: ${pkg.finalUrl}`,
				`信源权重: ${(pkg.weight as number).toFixed(2)}${pkg.weightSource ? ` (${pkg.weightSource})` : ""}`,
				"",
			]
				.filter((x) => x !== null)
				.join("\n");
			let out = `${header}\n${pkg.coreText}`;
			if (pkg.truncated) out += `\n\n[内容已截断：共 ${pkg.chars} 字符，可提高 maxChars 重新抓取]`;
			return { content: [{ type: "text", text: out }], structuredContent: pkg, details: pkg };
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", String(args.url ?? "")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const pkg = result.details as { chars?: number; title?: string; truncated?: boolean } | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			if (!pkg?.chars) return new Text(theme.fg("dim", "Empty"), 0, 0);
			let text = theme.fg("success", `${pkg.chars} chars`);
			if (pkg.truncated) text += theme.fg("warning", " (truncated)");
			if (pkg.title) text += theme.fg("muted", ` ${pkg.title.slice(0, 60)}`);
			return new Text(text, 0, 0);
		},
	});
}
