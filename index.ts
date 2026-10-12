/**
 * Web Search Extension
 *
 * 给 Pi 加两个网络工具（纯本地实现，无需 API key、无调用额度）：
 *   - web_search: 搜索（cn.bing.com）→ 信源权重过滤/标注 → 并发抓取结果页 → 核心文本摘要
 *   - web_fetch:  抓取网页正文（核心文本过滤版，自动截断）
 *
 * 反爬伪装（一致性伪装：固定一套浏览器指纹，不随机乱跳）：
 *   - 连贯的 Chrome 131/Linux 请求头（UA + Client Hints + Sec-Fetch-* + Referer）
 *   - Bing 会话 cookie 预热（先访问首页收 set-cookie，再带 cookie 搜索）
 *   - 按主机限速（Bing 序列 ≥1.2s+抖动；结果页同域串行、跨域并发 ≤3）
 *   - 手动跟随重定向并在每一跳按域附加 cookie
 *
 * 存储：SQLite（~/.pi/agent/web-search.db，node:sqlite + sqlite-vec v0.1.9）。
 *   权重/黑名单/站点表、搜索历史、抓取缓存；轻量向量嵌入（特征哈希）用于评估信息置信度
 *   （相关性 40% + 信源权重 25% + 多源印证 35%）。
 *
 * Usage: 把整个 web-search/ 目录放到 ~/.pi/agent/extensions/，重启 pi 或 /reload。
 */

import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	getCachedPage,
	loadWeights,
	openWebSearchDb,
	putCachedPage,
	recordSearch,
} from "./db.ts";
import { createOnnxEmbedder, type Embedder } from "./embed-onnx.ts";
import {
	applySetCookies,
	buildSearchPackage,
	checkBlocked,
	classifyPageUrl,
	cookieHeaderFor,
	cosineSim,
	EMBED_DIM,
	embedText,
	extractTitle,
	filterToDomain,
	htmlToText,
	isBingHost,
	looksLikeCaptcha,
	mapLimit,
	matchWeight,
	parseBingResults,
	parseCratesSearch,
	parseCrossrefSearch,
	parseCsdnSearch,
	parseGitHubSearch,
	parseGitLabSearch,
	parseHNSearch,
	parseJuejinSearch,
	parseMDNSearch,
	parseNpmSearch,
	parseOpenAlexSearch,
	parseArxivSearch,
	parseStackExchangeSearch,
	resolveSites,
	relevanceScore,
	scoreConfidence,
	SUPPORT_SIM_THRESHOLD,
	type PageContentInfo,
	type SearchPackage,
	type SearchResult,
	type SiteEntry,
	type SourceWeights,
} from "./core.ts";

// 一套连贯的 Chrome 131 on Linux 浏览器画像（字段之间互相印证，不随机轮换）。
const PROFILE = {
	userAgent:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
	secChUaPlatform: '"Linux"',
	acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
};

const BING_HOME = "https://cn.bing.com/";
const BING_SEARCH = "https://cn.bing.com/search";

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const DEFAULT_FETCH_CHARS = 20000;
const MAX_FETCH_CHARS = 100000;
const FETCH_TIMEOUT_MS = 12000;
const MIN_BING_GAP_MS = 1200;
const MIN_HOST_GAP_MS = 120;
const MAX_JITTER_MS = 400;
const SESSION_REFRESH_MS = 30 * 60 * 1000;
const MAX_REDIRECTS = 5;
const DEFAULT_CONTENT_TOP = 8;
const DEFAULT_CONTENT_CHARS = 1000;
const MAX_STORED_CONTENT_CHARS = 10000;
const CONTENT_CONCURRENCY = 16;
/**
 * 内容阶段的等待窗口（毫秒）：窗口内完成多少页就带多少页，到点即返回。
 * 页面是并行抓的，所以窗口不变时「多抓几页」= 多拿内容、不增加等待；
 * 想更全可调大（env PI_WS_CONTENT_WAIT_MS），想更快可调小。
 */
const CONTENT_WAIT_MS = Number(process.env.PI_WS_CONTENT_WAIT_MS ?? 3000);
const SITE_CONCURRENCY = 6;

const WebSearchParams = Type.Object({
	query: Type.String({ description: "搜索关键词，支持 Bing 语法：site:example.com、filetype:pdf、\"精确短语\"、-排除词" }),
	count: Type.Optional(Type.Integer({ description: `返回结果条数（默认 ${DEFAULT_COUNT}，最大 ${MAX_COUNT}）`, minimum: 1, maximum: MAX_COUNT })),
	offset: Type.Optional(Type.Integer({ description: "结果偏移量，用于翻页（默认 0，第二页传 10）", minimum: 0 })),
	includeContent: Type.Optional(Type.Boolean({ description: "抓取结果页并附核心文本摘要（默认 true；只要清单传 false）" })),
	contentTop: Type.Optional(Type.Integer({ description: `并发抓取的结果条数（默认 ${DEFAULT_CONTENT_TOP}，0 表示不抓；并行抓取，多抓不额外增加等待）`, minimum: 0, maximum: 20 })),
	contentChars: Type.Optional(Type.Integer({ description: `每条结果附带的核心文本字数（默认 ${DEFAULT_CONTENT_CHARS}）`, minimum: 200, maximum: 5000 })),
	minWeight: Type.Optional(Type.Number({ description: "信源权重下限（0~1），低于该权重的域名结果直接丢弃", minimum: 0, maximum: 1 })),
	sites: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"站内直达：站点别名/标签/域名（如 [\"github\"]、[\"代码\",\"csdn\"]）。提供后跳过搜索引擎，只搜这些站（github/mdn/stackoverflow 走原生 API，其余站用 site: 限定）。别名与标签见 ~/.pi/agent/web-sources.json 的 sites 段",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "要抓取的网页 URL（http/https）" }),
	maxChars: Type.Optional(Type.Integer({ description: `返回正文最大字符数（默认 ${DEFAULT_FETCH_CHARS}，最大 ${MAX_FETCH_CHARS}）`, minimum: 500, maximum: MAX_FETCH_CHARS })),
});

interface WeightedResult extends SearchResult {
	weight: number;
	weightSource: string | null;
	via: string;
	content?: { ok: boolean; title: string; coreText: string; error?: string };
}

interface PageContent {
	ok: boolean;
	title: string;
	coreText: string;
	error?: string;
	/** 抓取时就地算好的向量，供置信度复用（避免二次嵌入） */
	embedding?: Float32Array | null;
}

// --- JSON 信息包 schema（structuredContent/outputSchema 与 content 中的 JSON 对应） ---

const PageContentInfoSchema = Type.Object({
	ok: Type.Boolean(),
	title: Type.String(),
	coreText: Type.String(),
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
	content: Type.Union([PageContentInfoSchema, Type.Null()]),
	confidence: Type.Union([Type.Number(), Type.Null()]),
	relevance: Type.Union([Type.Number(), Type.Null()]),
	support: Type.Union([Type.Integer(), Type.Null()]),
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

interface FetchPackage {
	url: string;
	finalUrl: string;
	title: string;
	weight: number;
	weightSource: string | null;
	contentType: string;
	coreText: string;
	chars: number;
	truncated: boolean;
}

// --- 伪装请求层：会话 cookie + 按主机限速 + 浏览器请求头 ---

const cookieJar: Record<string, string> = {};
const hostLastAt = new Map<string, number>();
let sessionWarmedAt = 0;

function timeoutSignal(signal: AbortSignal): AbortSignal {
	try {
		return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
	} catch {
		return signal;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 同主机保持间隔 + 抖动；Bing 更保守（序列节奏），外部站按域并发。 */
async function paceFor(host: string): Promise<void> {
	const gap = (isBingHost(host) ? MIN_BING_GAP_MS : MIN_HOST_GAP_MS) + Math.floor(Math.random() * MAX_JITTER_MS);
	const wait = (hostLastAt.get(host) ?? 0) + gap - Date.now();
	if (wait > 0) await sleep(Math.min(wait, gap));
}

function collectCookies(res: Response, host: string): void {
	if (!isBingHost(host)) return; // 只收集 Bing 系 cookie，其他站点不带状态
	const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	applySetCookies(cookieJar, raw);
}

interface FetchOpts {
	secFetchSite: string;
	referer?: string;
}

function browserHeaders(opts: FetchOpts, cookie?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": PROFILE.userAgent,
		"sec-ch-ua": PROFILE.secChUa,
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": PROFILE.secChUaPlatform,
		Accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
		"Accept-Language": PROFILE.acceptLanguage,
		"Upgrade-Insecure-Requests": "1",
		"Sec-Fetch-Site": opts.secFetchSite,
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-User": "?1",
		"Sec-Fetch-Dest": "document",
	};
	if (opts.referer) headers["Referer"] = opts.referer;
	if (cookie) headers["Cookie"] = cookie;
	return headers;
}

/** 浏览器式 GET：手动跟随重定向，收 set-cookie 进会话 jar。 */
async function httpGet(url: string, signal: AbortSignal, opts: FetchOpts): Promise<Response> {
	let current = url;
	let currentOpts = opts;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const host = new URL(current).hostname;
		await paceFor(host);
		const cookie = cookieHeaderFor(cookieJar, host);
		const res = await fetch(current, {
			headers: browserHeaders(currentOpts, cookie),
			signal: timeoutSignal(signal),
			redirect: "manual",
		});
		hostLastAt.set(host, Date.now());
		collectCookies(res, host);
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) return res;
			const next = new URL(loc, current);
			currentOpts = {
				secFetchSite: isBingHost(next.hostname) && isBingHost(host) ? "same-site" : "cross-site",
				referer: current,
			};
			current = next.href;
			continue;
		}
		return res;
	}
	throw new Error(`重定向次数过多（>${MAX_REDIRECTS}）: ${url}`);
}

/** Bing 会话预热：先访问首页收 cookie。失败不阻断搜索；并发调用共享同一次预热。 */
let warmupPromise: Promise<void> | null = null;

function ensureBingSession(signal: AbortSignal): Promise<void> {
	if (Date.now() - sessionWarmedAt < SESSION_REFRESH_MS && Object.keys(cookieJar).length > 0) {
		return Promise.resolve();
	}
	warmupPromise ??= (async () => {
		try {
			await httpGet(BING_HOME, signal, { secFetchSite: "none" });
			sessionWarmedAt = Date.now();
		} catch {
			// 预热是尽力而为；搜不到结果时错误由搜索请求本身报告
		} finally {
			warmupPromise = null;
		}
	})();
	return warmupPromise;
}

// --- 存储层：SQLite（node:sqlite，零依赖） ---

const LEGACY_WEIGHTS_PATH =
	process.env.PI_WS_LEGACY_JSON ?? join(homedir(), ".pi", "agent", "web-sources.json"); // 旧版 JSON，仅首次导入用
const DB_PATH = process.env.PI_WS_DB_PATH ?? join(homedir(), ".pi", "agent", "web-search.db");
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));
const VENDOR_DIR = join(EXTENSION_DIR, "vendor");
const VEC_EXTENSION_PATH = join(VENDOR_DIR, "vec0.sqlite");
const PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let dbHandle: DatabaseSync | null = null;

function getDb(): DatabaseSync {
	dbHandle ??= openWebSearchDb(DB_PATH, LEGACY_WEIGHTS_PATH, VEC_EXTENSION_PATH);
	return dbHandle;
}

/**
 * 嵌入器：本地 ONNX（bge-small-zh-v1.5，512 维，语义级）为主，
 * vendor 缺件/加载失败时降级到内置哈希嵌入（256 维，词面级）。
 */
let embedderPromise: Promise<Embedder> | null = null;

function getEmbedder(): Promise<Embedder> {
	embedderPromise ??= (async () => {
		const onnx = await createOnnxEmbedder(VENDOR_DIR);
		if (onnx) return onnx;
		const hash: Embedder = {
			id: `hash-${EMBED_DIM}`,
			dim: EMBED_DIM,
			supportThreshold: SUPPORT_SIM_THRESHOLD,
			async embed(text: string) {
				return embedText(text);
			},
		};
		return hash;
	})();
	return embedderPromise;
}

function loadSourceWeights(): SourceWeights {
	return loadWeights(getDb());
}

// --- 结果页核心文本抓取 ---

async function fetchPageCore(url: string, referer: string, signal: AbortSignal): Promise<PageContent> {
	/** 统一在此算一次向量（缓存命中也要），供置信度阶段复用，避免二次嵌入 */
	const embedFor = async (title: string, text: string): Promise<Float32Array | null> => {
		try {
			const emb = await getEmbedder();
			return await emb.embed(`${title}\n${text}`);
		} catch {
			return null;
		}
	};
	const cached = getCachedPage(getDb(), url, PAGE_CACHE_TTL_MS);
	if (cached) {
		return {
			ok: true,
			title: cached.title,
			coreText: cached.coreText,
			error: cached.coreText ? undefined : "缓存正文为空",
			embedding: cached.coreText ? await embedFor(cached.title, cached.coreText) : null,
		};
	}
	try {
		const res = await httpGet(url, signal, { secFetchSite: "cross-site", referer });
		if (!res.ok) return { ok: false, title: "", coreText: "", error: `HTTP ${res.status}` };
		const contentType = res.headers.get("content-type") ?? "";
		if (/^(image|audio|video|application\/(pdf|zip|octet-stream))/.test(contentType)) {
			return { ok: false, title: "", coreText: "", error: `不支持的内容类型 ${contentType.split(";")[0]}` };
		}
		const body = await res.text();
		const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
		const coreText = isHtml ? htmlToText(body) : body;
		const title = isHtml ? extractTitle(body) : "";
		const stored = coreText.slice(0, MAX_STORED_CONTENT_CHARS);
		let embedding: Float32Array | null = null;
		if (stored) {
			// 向量失败（ONNX 异常）时仍写缓存与 FTS，只是没有向量
			embedding = await embedFor(title, stored);
			const emb = await getEmbedder();
			putCachedPage(getDb(), {
				url,
				title,
				coreText: stored,
				contentType: contentType || null,
				embedderId: embedding ? emb.id : undefined,
				embedding,
			});
		}
		return {
			ok: true,
			title,
			coreText: stored,
			error: stored ? undefined : "正文为空（可能是脚本渲染页或反爬拦截）",
			embedding,
		};
	} catch (err) {
		return { ok: false, title: "", coreText: "", error: (err as Error).message };
	}
}

/** 站内 API 请求头（XHR 形态：cors/empty + Origin），与网页伪装区分。 */
function apiHeaders(referer: string, origin: string): Record<string, string> {
	return {
		"User-Agent": PROFILE.userAgent,
		Accept: "application/json, text/plain, */*",
		"Accept-Language": PROFILE.acceptLanguage,
		Referer: referer,
		Origin: origin,
		"Sec-Fetch-Site": "same-origin",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Dest": "empty",
	};
}

/** 站内 API：GET/POST 走同一限速层。 */
async function httpApi(
	url: string,
	signal: AbortSignal,
	opts: { referer: string; origin: string; body?: unknown },
): Promise<Response> {
	const host = new URL(url).hostname;
	await paceFor(host);
	const headers = apiHeaders(opts.referer, opts.origin);
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(url, {
		method: opts.body === undefined ? "GET" : "POST",
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		signal: timeoutSignal(signal),
		redirect: "manual",
	});
	hostLastAt.set(host, Date.now());
	collectCookies(res, host);
	return res;
}

/**
 * Bing 兜底站（无原生 API 的站）：合成一次 site: 查询。
 * 多站时用 `(site:a OR site:b)`，把 N 次被节流的 Bing 请求压成 1 次；
 * 结果按域名本地强制过滤后由调用方分配（Bing 有时会放宽 site:）。
 */
async function fetchBingScoped(
	entries: Array<{ alias: string; entry: SiteEntry }>,
	query: string,
	signal: AbortSignal,
): Promise<{ results: SearchResult[]; error?: string }> {
	if (entries.length === 0) return { results: [] };
	try {
		await ensureBingSession(signal);
		const scope =
			entries.length === 1
				? `site:${entries[0].entry.domain}`
				: `(${entries.map((e) => `site:${e.entry.domain}`).join(" OR ")})`;
		const url = `${BING_SEARCH}?q=${encodeURIComponent(`${scope} ${query}`)}&first=1&form=QBRE&setmkt=zh-CN&setlang=zh-hans`;
		const res = await httpGet(url, signal, { secFetchSite: "same-origin", referer: BING_HOME });
		if (!res.ok) return { results: [], error: `Bing HTTP ${res.status}` };
		const html = await res.text();
		if (looksLikeCaptcha(html)) return { results: [], error: "Bing 返回风控页" };
		return { results: parseBingResults(html) };
	} catch (err) {
		return { results: [], error: (err as Error).message };
	}
}

/** 站内直达：按站点适配器搜一个站（仅原生 API 站；bing 兜底站走 fetchBingScoped）。 */
async function searchSite(alias: string, entry: SiteEntry, query: string, signal: AbortSignal): Promise<SearchResult[]> {
	const spec = entry.search;
	const q = encodeURIComponent(query);
	const need = async (res: Response, label: string): Promise<void> => {
		if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
	};
	switch (spec.kind) {
		case "github": {
			const res = await httpApi(`https://api.github.com/search/repositories?q=${q}&per_page=8`, signal, {
				referer: "https://github.com/",
				origin: "https://github.com",
			});
			await need(res, "GitHub API");
			return parseGitHubSearch(await res.json()).slice(0, 8);
		}
		case "gitlab": {
			const res = await httpApi(`https://gitlab.com/api/v4/projects?search=${q}&per_page=8`, signal, {
				referer: "https://gitlab.com/",
				origin: "https://gitlab.com",
			});
			await need(res, "GitLab API");
			return parseGitLabSearch(await res.json()).slice(0, 8);
		}
		case "npm": {
			const res = await httpApi(`https://registry.npmjs.org/-/v1/search?text=${q}&size=8`, signal, {
				referer: "https://www.npmjs.com/",
				origin: "https://www.npmjs.com",
			});
			await need(res, "npm registry");
			return parseNpmSearch(await res.json()).slice(0, 8);
		}
		case "crates": {
			const res = await httpApi(`https://crates.io/api/v1/crates?q=${q}&per_page=8`, signal, {
				referer: "https://crates.io/",
				origin: "https://crates.io",
			});
			await need(res, "crates.io API");
			return parseCratesSearch(await res.json()).slice(0, 8);
		}
		case "mdn": {
			const res = await httpApi(`https://developer.mozilla.org/api/v1/search?q=${q}&locale=zh-CN`, signal, {
				referer: "https://developer.mozilla.org/",
				origin: "https://developer.mozilla.org",
			});
			await need(res, "MDN API");
			return parseMDNSearch(await res.json()).slice(0, 8);
		}
		case "stackexchange": {
			const res = await httpApi(
				`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=${encodeURIComponent(spec.site ?? "")}`,
				signal,
				{ referer: `https://${spec.site}.com/`, origin: `https://${spec.site}.com` },
			);
			await need(res, "StackExchange API");
			return parseStackExchangeSearch(await res.json()).slice(0, 8);
		}
		case "hn": {
			const res = await httpApi(`https://hn.algolia.com/api/v1/search?query=${q}&hitsPerPage=8`, signal, {
				referer: "https://news.ycombinator.com/",
				origin: "https://news.ycombinator.com",
			});
			await need(res, "HN API");
			return parseHNSearch(await res.json()).slice(0, 8);
		}
		case "juejin": {
			const res = await httpApi("https://api.juejin.cn/search_api/v1/search", signal, {
				referer: "https://juejin.cn/",
				origin: "https://juejin.cn",
				body: { key_word: query, id_type: 0, cursor: "0", limit: 8, search_type: 0 },
			});
			await need(res, "掘金 API");
			return parseJuejinSearch(await res.json()).slice(0, 8);
		}
		case "csdn": {
			const res = await httpApi(`https://so.csdn.net/api/v3/search?q=${q}&t=all&p=1`, signal, {
				referer: `https://so.csdn.net/so/search?q=${q}`,
				origin: "https://so.csdn.net",
			});
			await need(res, "CSDN API");
			return parseCsdnSearch(await res.json()).slice(0, 8);
		}
		case "openalex": {
			const res = await httpApi(`https://api.openalex.org/works?search=${q}&per_page=8`, signal, {
				referer: "https://openalex.org/",
				origin: "https://openalex.org",
			});
			await need(res, "OpenAlex API");
			return parseOpenAlexSearch(await res.json()).slice(0, 8);
		}
		case "crossref": {
			const res = await httpApi(`https://api.crossref.org/works?query=${q}&rows=8`, signal, {
				referer: "https://www.crossref.org/",
				origin: "https://www.crossref.org",
			});
			await need(res, "CrossRef API");
			return parseCrossrefSearch(await res.json()).slice(0, 8);
		}
		case "arxiv": {
			const res = await httpApi(`https://export.arxiv.org/api/query?search_query=all:${q}&max_results=8`, signal, {
				referer: "https://arxiv.org/",
				origin: "https://arxiv.org",
			});
			await need(res, "arXiv API");
			return parseArxivSearch(await res.text()).slice(0, 8);
		}
		default:
			throw new Error(`searchSite: ${spec.kind} 不走单站适配器（bing-site 由 fetchBingScoped 统一处理）`);
	}
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "web search",
		description:
			"Search the web via Bing (cn.bing.com). Returns results annotated with a source-trust weight (0~1, from a local weight DB), " +
			"then concurrently fetches the top result pages and extracts their core text (boilerplate/nav/ads stripped). " +
			"Supports Bing operators: site:example.com, filetype:pdf, \"exact phrase\", -exclude. " +
			"Pass sites=[\"github\",\"csdn\"] (alias/tag/domain) to skip the search engine and search those sites directly (github/mdn/stackoverflow use native APIs). " +
			"Only content pages are returned — homepages and list/index pages are dropped. " +
			"Set includeContent=false for a list-only search, minWeight to drop low-trust domains. " +
			"Junk sources (business-registry farms, event spam, etc.) are excluded via the blacklist in ~/.pi/agent/web-sources.json (blockedDomains/blockedPatterns). " +
			"If a query returns nothing, rephrase it in English or Chinese. " +
			"Returns a JSON package: ranked results with source weight (w), a confidence score (0~1 = 相关性 40% + 信源权重 25% + 多源印证 35%, from lightweight local embeddings), core-text excerpt per fetched page, dropped sources, and fetch stats.",
		parameters: WebSearchParams,
		outputSchema: SearchPackageSchema,
		namespace: {
			name: "web",
			description: "Web search and page fetching via Bing",
			instructions:
				"Prefer web_search (it already attaches core page text for the top results). " +
				"Use web_fetch for one extra URL. Weigh claims by the w= source weight; prefer high-weight sources when quoting.",
		},
		annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const t0 = Date.now();
			const query = params.query.trim();
			if (!query) throw new Error("web_search: query 不能为空");
			const count = Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT);
			const offset = params.offset ?? 0;
			const includeContent = params.includeContent ?? true;
			const contentTop = params.contentTop ?? DEFAULT_CONTENT_TOP;
			const contentChars = Math.min(params.contentChars ?? DEFAULT_CONTENT_CHARS, 5000);
			const weights = loadSourceWeights();

			// 路径 A：站内直达（跳过搜索引擎）；路径 B：Bing 全网搜索
			const siteTokens = params.sites ?? [];
			const resolved = siteTokens.length > 0 ? resolveSites(weights.sites, siteTokens) : [];
			if (siteTokens.length > 0 && resolved.length === 0) {
				const available = Object.entries(weights.sites)
					.map(([alias, e]) => `${alias}(${e.tags.slice(0, 3).join("/") || e.domain})`)
					.join("、");
				throw new Error(`web_search: sites 未匹配到任何站点（${siteTokens.join(", ")}）。可用：${available}`);
			}

			let candidates: Array<SearchResult & { via?: string }> = [];
			let referer = BING_HOME;
			const searchStarted = Date.now();
			if (resolved.length > 0) {
				const failures: string[] = [];
				const perSite: SearchResult[][] = [];
				// API 站（github/npm/csdn/...）并发；bing 兜底站合并成一次 site: 查询
				// （Bing 请求被节流串行，N 个站 N 次请求会白等 N×1.2s）
				const bingEntries = resolved.filter((r) => r.entry.search.kind === "bing-site");
				const apiEntries = resolved.filter((r) => r.entry.search.kind !== "bing-site");
				const [apiSettled, bingResults] = await Promise.all([
					mapLimit(apiEntries, SITE_CONCURRENCY, async (r) => ({
						alias: r.alias,
						results: await searchSite(r.alias, r.entry, query, signal),
					})),
					fetchBingScoped(bingEntries, query, signal),
				]);
				for (const s of apiSettled) {
					if (s.status === "rejected") {
						failures.push((s.reason as Error).message);
						continue;
					}
					perSite.push(s.value.results.map((x) => ({ ...x, via: s.value.alias })));
				}
				if (bingEntries.length > 0) {
					if (bingResults.error) failures.push(bingResults.error);
					for (const e of bingEntries) {
						perSite.push(
							filterToDomain(bingResults.results, e.entry.domain)
								.slice(0, 8)
								.map((x) => ({ ...x, via: e.alias })),
						);
					}
				}
				// 各站结果轮询交错，避免单站占满 count 配额
				for (let i = 0; perSite.some((list) => i < list.length); i++) {
					for (const list of perSite) {
						if (i < list.length) candidates.push(list[i]);
					}
				}
				if (candidates.length === 0) {
					throw new Error(`web_search: 站内搜索（${resolved.map((r) => r.alias).join(", ")}）无结果${failures.length ? `；失败：${failures.join("; ")}` : ""}`);
				}
			} else {
				await ensureBingSession(signal);
				// form/setmkt 参数模拟搜索框提交的 URL 形态
				// 注：已验证 cn.bing.com 对无会话客户端忽略分页（first=11 / 真实下一页链接 / 各 form 变体
				// 均返回与第 1 页相同的 10 条），所以不做多页 SERP，避免白耗一次被节流的请求
				const url = `${BING_SEARCH}?q=${encodeURIComponent(query)}&first=${offset + 1}&form=QBRE&setmkt=zh-CN&setlang=zh-hans`;
				referer = url;
				const res = await httpGet(url, signal, { secFetchSite: "same-origin", referer: BING_HOME });
				if (!res.ok) throw new Error(`web_search: Bing 返回 HTTP ${res.status}`);
				const html = await res.text();
				if (looksLikeCaptcha(html)) {
					throw new Error("web_search: Bing 返回了验证码/风控页，稍后重试或换查询词");
				}
				candidates = parseBingResults(html);
				if (candidates.length === 0) {
					throw new Error(`web_search: 未解析到结果（query=${JSON.stringify(query)}）。可能无结果、页面结构变化、或被风控；换个查询词试试`);
				}
			}

			const serpMs = Date.now() - searchStarted;

			// 只保留内容页（首页/列表页剔除）→ 黑名单 → 信源权重 → 截取 count
			const minWeight = params.minWeight;
			const dropped: Array<SearchResult & { weight: number; reason: string }> = [];
			const kept: WeightedResult[] = [];
			for (const r of candidates) {
				const hostname = new URL(r.url).hostname;
				const { weight, key } = matchWeight(weights, hostname);
				const kind = classifyPageUrl(r.url);
				if (kind !== "content") {
					dropped.push({ ...r, weight, reason: kind === "homepage" ? "首页（非内容页）" : "列表页（非内容页）" });
					continue;
				}
				const hit = checkBlocked(weights, r);
				if (hit.blocked) {
					dropped.push({ ...r, weight, reason: hit.reason ?? "黑名单" });
					continue;
				}
				if (minWeight !== undefined && weight < minWeight) {
					dropped.push({ ...r, weight, reason: `信源权重低于 minWeight=${minWeight}` });
					continue;
				}
				kept.push({ ...r, weight, weightSource: key, via: r.via ?? "bing" });
			}
			const results = kept.slice(0, count);
			if (results.length === 0) {
				const why = dropped.map((d) => `${new URL(d.url).hostname}: ${d.reason}`).join("; ");
				throw new Error(`web_search: 全部 ${candidates.length} 条结果被过滤（${why}）。可在 ~/.pi/agent/web-sources.json 调整黑名单/minWeight 后重试`);
			}

			// 并发抓取结果页核心文本（带总预算：慢页不拖住整体，超时的标「预算内未返回」）
			const contentStarted = Date.now();
			const fetchList = includeContent ? results.slice(0, Math.max(0, contentTop)) : [];
			if (fetchList.length > 0) {
				// 等待窗口：窗口内完成的页面都带上；到点未完成的标记为「未在窗口内返回」
				// 并行抓取下窗口是唯一的时间约束，因此多抓页面只增内容、不增等待
				let releaseSoft: (() => void) | null = null;
				const softEnough = new Promise<void>((resolve) => {
					releaseSoft = resolve;
				});
				const softTimer = setTimeout(() => releaseSoft?.(), CONTENT_WAIT_MS);
				const all = mapLimit(fetchList, CONTENT_CONCURRENCY, async (r) => {
					const c = await fetchPageCore(r.url, referer, signal);
					if (c.ok && c.coreText.length < 200) c.error = "正文过短（疑似栏目页/空页）";
					r.content = c;
					return c;
				});
				const outcome = await Promise.race([all.then(() => "done" as const), softEnough.then(() => "window" as const)]);
				clearTimeout(softTimer); // 别让定时器吊住进程
				if (outcome !== "done") {
					for (const r of fetchList) {
						if (!r.content) {
							r.content = {
								ok: false,
								title: "",
								coreText: "",
								error: `未在 ${CONTENT_WAIT_MS / 1000}s 等待窗口内返回（后台仍在抓，已写入缓存）`,
							};
						}
					}
				}
			}
			const contentMs = Date.now() - contentStarted;

			// 置信度：相关性（查询↔页面，本地嵌入）+ 信源权重 + 多源印证
			// 印证只在「本批结果」内计算：跨查询的历史页面主题混杂，页级相似度不可靠（实测同异主题分布重叠）
			const emb = await getEmbedder();
			const embedStarted = Date.now();
			const queryVec = await emb.embed(query, "query");
			const pageVectors = new Map<string, Float32Array>();
			// 抓取阶段已算好向量，这里直接复用；只有缺失（预算竞态晚到/异常）才补算
			await mapLimit(fetchList, 4, async (r) => {
				const c = r.content;
				if (!c?.ok || !c.coreText) return;
				const vec = c.embedding ?? (await emb.embed(`${c.title}\n${c.coreText}`));
				pageVectors.set(r.url, vec);
			});
			const hostOf = (u: string): string => {
				try {
					return new URL(u).hostname;
				} catch {
					return u;
				}
			};
			for (const r of fetchList) {
				const pageVec = pageVectors.get(r.url);
				if (!pageVec) continue;
				const relevance = relevanceScore(queryVec, pageVec);
				const host = hostOf(r.url);
				const domains = new Set<string>();
				for (const other of fetchList) {
					if (other.url === r.url) continue;
					const ov = pageVectors.get(other.url);
					if (!ov) continue;
					const oh = hostOf(other.url);
					if (oh === host) continue;
					if (cosineSim(pageVec, ov) >= emb.supportThreshold) domains.add(oh);
				}
				r.relevance = Math.round(relevance * 1000) / 1000;
				r.support = domains.size;
				r.confidence = scoreConfidence({ relevance, sourceWeight: r.weight, support: domains.size });
			}

			const embedMs = Date.now() - embedStarted;

			// JSON 封装有用信息（content 与 structuredContent 同构）
			const pkg = buildSearchPackage({
				query,
				fetchedAt: new Date().toISOString(),
				contentChars,
				dropReason: "已过滤",
				results,
				dropped,
				meta: {
					count,
					offset,
					includeContent,
					contentTop: fetchList.length,
					contentChars,
					minWeight: minWeight ?? null,
					sites: resolved.length > 0 ? resolved.map((r) => r.alias) : null,
					timings: {
						serpMs,
						contentMs,
						embedMs,
						totalMs: Date.now() - t0,
					},
				},
			});

			// 落库：搜索历史 + 结果明细（含核心文本），供后续本地检索/复用
			recordSearch(getDb(), pkg, params as Record<string, unknown>);

			return {
				content: [{ type: "text", text: JSON.stringify(pkg, null, 2) }],
				structuredContent: pkg as unknown as Record<string, unknown>,
				details: pkg,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", JSON.stringify(args.query ?? "")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const pkg = result.details as SearchPackage | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Searching + fetching..."), 0, 0);
			if (!pkg) return new Text(theme.fg("dim", "No results"), 0, 0);
			let text = theme.fg("success", `${pkg.results.length} results`);
			if (pkg.meta.fetchedPages) text += theme.fg("muted", ` · ${pkg.meta.fetchedPages} pages`);
			if (pkg.meta.failedPages) text += theme.fg("warning", ` · ${pkg.meta.failedPages} failed`);
			if (pkg.dropped.length) text += theme.fg("muted", ` · ${pkg.dropped.length} dropped`);
			text += theme.fg("muted", ` for ${JSON.stringify(pkg.query)}`);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "web fetch",
		description:
			"Fetch a web page over HTTP(S) and return its core text content (boilerplate, nav, ads and menus are filtered out). " +
			"Output is truncated to maxChars (default 20000). Follows redirects. Use after web_search to read a specific result page.",
		parameters: WebFetchParams,
		outputSchema: FetchPackageSchema,
		namespace: {
			name: "web",
			description: "Web search and page fetching via Bing",
			instructions:
				"Prefer web_search (it already attaches core page text for the top results). " +
				"Use web_fetch for one extra URL. Weigh claims by the w= source weight; prefer high-weight sources when quoting.",
		},
		annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const raw = params.url.trim();
			let target: URL;
			try {
				target = new URL(raw);
			} catch {
				throw new Error(`web_fetch: 无效 URL: ${raw}`);
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error(`web_fetch: 仅支持 http/https，收到 ${target.protocol}`);
			}
			const maxChars = Math.min(params.maxChars ?? DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS);
			const weights = loadSourceWeights();

			if (isBingHost(target.hostname)) await ensureBingSession(signal);

			// 命中抓取缓存则直接返回（TTL 内不重复抓，落库与索引在抓取路径里做）
			const cached = getCachedPage(getDb(), target.href, PAGE_CACHE_TTL_MS);
			let finalUrl: string;
			let contentType: string;
			let title: string;
			let coreText: string;
			if (cached) {
				finalUrl = cached.url;
				contentType = cached.contentType ?? "";
				title = cached.title;
				coreText = cached.coreText;
			} else {
				// 直接地址栏导航：Sec-Fetch-Site: none、无 Referer
				const res = await httpGet(target.href, signal, { secFetchSite: "none" });
				if (!res.ok) throw new Error(`web_fetch: ${target.href} 返回 HTTP ${res.status}`);
				contentType = res.headers.get("content-type") ?? "";
				if (/^(image|audio|video|application\/(pdf|zip|octet-stream))/.test(contentType)) {
					throw new Error(`web_fetch: 不支持的内容类型 ${contentType.split(";")[0]}（该工具只处理文本/HTML）`);
				}
				const body = await res.text();
				const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
				title = isHtml ? extractTitle(body) : "";
				coreText = isHtml ? htmlToText(body) : body;
				finalUrl = res.url || target.href;
				if (coreText) {
					let embedding: Float32Array | null = null;
					let embedderId: string | undefined;
					try {
						const emb = await getEmbedder();
						embedding = await emb.embed(`${title}\n${coreText.slice(0, MAX_STORED_CONTENT_CHARS)}`);
						embedderId = emb.id;
					} catch {
						embedding = null;
					}
					putCachedPage(getDb(), {
						url: target.href,
						title,
						coreText: coreText.slice(0, MAX_STORED_CONTENT_CHARS),
						contentType: contentType || null,
						embedderId,
						embedding,
					});
				}
			}

			const truncated = coreText.length > maxChars;
			const shown = truncated ? coreText.slice(0, maxChars) : coreText;
			const { weight, key } = matchWeight(weights, target.hostname);
			const pkg: FetchPackage = {
				url: target.href,
				finalUrl,
				title,
				weight,
				weightSource: key,
				contentType,
				coreText: shown,
				chars: coreText.length,
				truncated,
			};
			// content 给模型读（可读排版），structuredContent 给程序用（JSON 封装）
			const header = [
				title ? `# ${title}` : null,
				`URL: ${pkg.finalUrl}`,
				`信源权重: w=${weight.toFixed(2)}${key ? ` (${key})` : ""}`,
				contentType ? `Content-Type: ${contentType.split(";")[0]}` : null,
				"",
			]
				.filter((x) => x !== null)
				.join("\n");
			let out = `${header}\n${shown}`;
			if (truncated) {
				out += `\n\n[内容已截断：显示前 ${maxChars} 字符 / 全文 ${coreText.length} 字符。需要更多内容时提高 maxChars 重新抓取]`;
			}

			return {
				content: [{ type: "text", text: out }],
				structuredContent: pkg as unknown as Record<string, unknown>,
				details: pkg,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", String(args.url ?? "")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const pkg = result.details as FetchPackage | undefined;
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			if (!pkg) return new Text(theme.fg("dim", "Empty"), 0, 0);
			let text = theme.fg("success", `${pkg.chars} chars`) + theme.fg("muted", ` w=${pkg.weight.toFixed(2)}`);
			if (pkg.truncated) text += theme.fg("warning", " (truncated)");
			if (pkg.title) text += theme.fg("muted", ` ${pkg.title.slice(0, 60)}`);
			return new Text(text, 0, 0);
		},
	});

	// 会话开始就在后台预热 Bing 会话（收 cookie），让首次搜索省掉预热等待
	if (typeof pi.on === "function") {
		pi.on("session_start", () => {
			void ensureBingSession(new AbortController().signal).catch(() => {});
		});
	}
}
