/**
 * Pure helpers for the web-search extension: Bing result parsing, core-text
 * extraction, source-weight DB, and bounded concurrency. No imports, so this
 * file can be unit-tested with plain `node`.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// ---------------------------------------------------------------- entities

export function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
			try {
				return String.fromCodePoint(parseInt(h, 16));
			} catch {
				return m;
			}
		})
		.replace(/&#(\d+);/g, (m, d) => {
			try {
				return String.fromCodePoint(parseInt(d, 10));
			} catch {
				return m;
			}
		})
		.replace(/&nbsp;/gi, " ")
		.replace(/&ensp;/gi, " ")
		.replace(/&emsp;/gi, " ")
		.replace(/&thinsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&ndash;/gi, "–")
		.replace(/&mdash;/gi, "—")
		.replace(/&hellip;/gi, "…")
		.replace(/&middot;/gi, "·")
		.replace(/&bull;/gi, "•")
		.replace(/&copy;/gi, "©")
		.replace(/&reg;/gi, "®")
		.replace(/&trade;/gi, "™")
		.replace(/&amp;/gi, "&");
}

export function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- bing SERP

function titleFromChunk(chunk: string): { title: string; url: string } | null {
	const m = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
	if (!m) return null;
	const url = decodeEntities(m[1]).trim();
	if (!url || /^(#|javascript:|mailto:)/i.test(url)) return null;
	return { title: stripTags(m[2]), url };
}

function snippetFromChunk(chunk: string): string {
	const caption = chunk.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
	if (caption) return stripTags(caption[1]);
	const p = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
	return p ? stripTags(p[1]) : "";
}

/**
 * Parse a Bing SERP into results. Returns [] when the page has no
 * organic result blocks (which usually means a captcha or an empty SERP).
 */
export function parseBingResults(html: string): SearchResult[] {
	const chunks = html.split(/class="b_algo"/).slice(1);
	const seen = new Set<string>();
	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		const head = titleFromChunk(chunk);
		if (!head || seen.has(head.url)) continue;
		seen.add(head.url);
		results.push({ ...head, snippet: snippetFromChunk(chunk) });
	}
	return results;
}

/** Detect a Bing captcha / challenge page so callers can fail loud. */
export function looksLikeCaptcha(html: string): boolean {
	return /b_captcha|sb_form_captcha|请解决以下难题|Enter the characters you see/i.test(html);
}

// ---------------------------------------------------------------- core text

const TAG_BOILERPLATE = new Set([
	"script",
	"style",
	"noscript",
	"svg",
	"iframe",
	"template",
	"form",
	"nav",
	"aside",
	"footer",
	"button",
	"dialog",
	"menu",
]);

const ATTR_BOILERPLATE =
	/(^|[\s\-_])(sidebar|widget|comments?|footnotes?|footer|nav|navbar|menu|banner|promo|advert|ads?|related|recommend|share|sharing|social|breadcrumb|pagination|pagin|cookies?|popup|modal|subscribe|newsletter|toolbar|tags?|author|read-more|more-articles|hot|trending|ranking|copyright|notice|alert|feedback|survey|login|signup|sign-in|register|search-form|skiplink)([\s\-_]|$)/i;

const SIMPLE_STRIP_RE =
	/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function isVoidTag(tagText: string, name: string): boolean {
	return VOID_TAGS.has(name) || /\/\s*>$/.test(tagText);
}

function isBoilerplateTag(tagText: string, name: string): boolean {
	if (TAG_BOILERPLATE.has(name)) return true;
	const attrs = tagText.match(/\b(?:class|id)\s*=\s*("([^"]*)"|'([^']*)')/gi);
	if (!attrs) return false;
	for (const a of attrs) {
		const v = a.replace(/^\w+\s*=\s*["']?|["']$/g, "");
		if (ATTR_BOILERPLATE.test(` ${v} `)) return true;
	}
	return false;
}

/**
 * Stack-scanner that drops whole boilerplate subtrees (tag name or class/id
 * match). Handles nested tags correctly — a sidebar full of nested divs goes
 * away as one unit.
 */
export function stripBoilerplate(html: string): string {
	let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(SIMPLE_STRIP_RE, "");
	let out = "";
	let i = 0;
	let skipDepth = 0;
	while (i < s.length) {
		const lt = s.indexOf("<", i);
		if (lt === -1) {
			if (!skipDepth) out += s.slice(i);
			break;
		}
		if (!skipDepth) out += s.slice(i, lt);
		const gt = s.indexOf(">", lt);
		if (gt === -1) {
			if (!skipDepth) out += s.slice(lt);
			break;
		}
		const tagText = s.slice(lt, gt + 1);
		i = gt + 1;
		const m = tagText.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/);
		if (!m) {
			if (!skipDepth) out += tagText;
			continue;
		}
		const closing = m[1] === "/";
		const name = m[2].toLowerCase();
		const isVoid = isVoidTag(tagText, name);
		if (skipDepth > 0) {
			if (!isVoid) skipDepth += closing ? -1 : 1;
			if (skipDepth < 0) skipDepth = 0;
			continue;
		}
		if (!closing && !isVoid && isBoilerplateTag(tagText, name)) {
			skipDepth = 1;
			continue;
		}
		out += tagText;
	}
	return out;
}

// 标题/列表行标记：过滤时保护标题不被「短行丢弃」误杀
const HEAD_OPEN = "\x01";

const MENU_LINE_RE = /^[^。！？.!?]{0,24}(\s*[|｜·・/／、]\s*[^。！？.!?]{0,24}){2,}$/;
const UI_LINE_RE =
	/^(首页|登录|注册|下载|APP|客户端|菜单|导航|返回(?:顶部|首页)?|上一页|下一页|上一篇|下一篇|阅读全文|点击(?:查看|进入|下载|关注)?|查看更多|展开(?:更多|全文)?|关于我们|联系方式|友情链接|版权(?:所有)?|关注我们|扫码(?:关注)?|分享到|设为首页|加入收藏|网站地图|相关(?:推荐|文章|阅读)|热门(?:推荐|文章)|猜你喜欢)/;

/** Post text-conversion filter: keep headings, list items and prose; drop menu/UI noise. */
export function filterCoreLines(s: string): string {
	const kept = s
		.split("\n")
		.map((l) => l.trim())
		.filter((line) => {
			if (!line) return false;
			if (line.includes(HEAD_OPEN)) return true;
			if (line.startsWith("• ")) return true;
			if (MENU_LINE_RE.test(line)) return false;
			if (UI_LINE_RE.test(line)) return false;
			if (line.length < 4) return false;
			return true;
		})
		.map((line) => line.split(HEAD_OPEN).join(""));
	return kept.join("\n");
}

/** Extract core readable text: drop boilerplate/nav/ads, keep headings + prose. */
export function htmlToText(html: string): string {
	let s = stripBoilerplate(html);

	// Prefer a main content region when the page has one.
	const main = s.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
	const article = s.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
	const region = main?.[1] ?? (article && article[1].length > 500 ? article[1] : null);
	if (region) s = region;

	s = s.replace(/<h[1-6][^>]*>/gi, `\n${HEAD_OPEN}`);
	s = s.replace(/<\/h[1-6]\s*>/gi, `${HEAD_OPEN}\n\n`);
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<li[^>]*>/gi, "• ");
	s = s.replace(
		/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt)\s*>/gi,
		"\n\n",
	);
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = filterCoreLines(s);
	return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract a page title without pulling in scripts/styles. */
export function extractTitle(html: string): string {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return m ? stripTags(m[1]) : "";
}

// ---------------------------------------------------------------- cookie jar

/** Merge Set-Cookie strings into a name→value jar (empty/expired values delete). */
export function applySetCookies(jar: Record<string, string>, setCookieStrings: string[]): void {
	for (const sc of setCookieStrings) {
		const first = sc.split(";")[0] ?? "";
		const eq = first.indexOf("=");
		if (eq <= 0) continue;
		const name = first.slice(0, eq).trim();
		const value = first.slice(eq + 1).trim();
		if (!name) continue;
		if (value === "" || /max-age=0\b/i.test(sc) || /expires=thu,\s*01\s+jan\s+1970/i.test(sc)) {
			delete jar[name];
		} else {
			jar[name] = value;
		}
	}
}

/**
 * Build a Cookie header for the given host. Only Bing-family hosts receive
 * the jar (those are the only cookies we ever collect), so arbitrary
 * web_fetch targets stay cookie-free like a fresh browser tab.
 */
export function cookieHeaderFor(jar: Record<string, string>, host: string): string | undefined {
	if (!isBingHost(host)) return undefined;
	const pairs = Object.entries(jar).map(([k, v]) => `${k}=${v}`);
	return pairs.length ? pairs.join("; ") : undefined;
}

export function isBingHost(host: string): boolean {
	return /(^|\.)bing\.com$/i.test(host);
}

// ---------------------------------------------------------------- 信源权重库

export interface SourceWeights {
	defaultWeight: number;
	domains: Record<string, number>;
	/** 域名后缀黑名单：命中直接丢弃（企业信息站/内容农场等） */
	blockedDomains: string[];
	/** 屏蔽词：标题/URL/摘要命中即丢弃（对空白不敏感、大小写不敏感） */
	blockedPatterns: string[];
	/** 常用站点注册表：别名/标签 → 站内直达搜索适配器 */
	sites: SiteRegistry;
}

/** Built-in seed; written to the weights file on first run for user editing. */
export const DEFAULT_SOURCE_WEIGHTS: SourceWeights = {
	defaultWeight: 0.5,
	// 垃圾信源黑名单：企业信息查询站、B2B 黄页农场、文档农场、会讯垃圾
	blockedDomains: [
		"qcc.com", // 企查查
		"tianyancha.com", // 天眼查
		"aiqicha.baidu.com", // 爱企查
		"qixin.com", // 启信宝
		"shuidi.cn", // 水滴信用
		"xizhi.com", // 悉知
		"11467.com", // 顺企网
		"atobo.com.cn", // 阿土伯
		"wenku.baidu.com", // 百度文库（文档农场）
	],
	blockedPatterns: [
		"企查查",
		"爱企查",
		"天眼查",
		"启信宝",
		"水滴信用",
		"APEC会议",
	],
	// 常用站点：别名 → 站内直达。原生 API 优先，没有 API 的站用 Bing site: 兜底
	sites: {
		github: {
			domain: "github.com",
			tags: ["代码", "仓库", "开源", "code", "repo", "源码"],
			search: { kind: "github" },
		},
		stackoverflow: {
			domain: "stackoverflow.com",
			tags: ["问答", "q&a", "报错", "踩坑"],
			search: { kind: "stackexchange", site: "stackoverflow" },
		},
		mdn: {
			domain: "developer.mozilla.org",
			tags: ["web", "前端", "浏览器", "api 文档"],
			search: { kind: "mdn" },
		},
		npm: {
			domain: "npmjs.com",
			tags: ["js 包", "node", "前端包"],
			search: { kind: "npm" },
		},
		crates: {
			domain: "crates.io",
			tags: ["rust 包", "rust crate"],
			search: { kind: "crates" },
		},
		gitlab: {
			domain: "gitlab.com",
			tags: ["gitlab"],
			search: { kind: "gitlab" },
		},
		hn: {
			domain: "news.ycombinator.com",
			tags: ["hacker news", "技术新闻"],
			search: { kind: "hn" },
		},
		juejin: {
			domain: "juejin.cn",
			tags: ["掘金", "稀土"],
			search: { kind: "juejin" },
		},
		csdn: {
			domain: "csdn.net",
			tags: ["中文博客", "博客"],
			search: { kind: "csdn" },
		},
		openalex: {
			domain: "openalex.org",
			tags: ["学术", "论文", "paper"],
			search: { kind: "openalex" },
		},
		crossref: {
			domain: "doi.org",
			tags: ["文献", "doi"],
			search: { kind: "crossref" },
		},
		arxiv: {
			domain: "arxiv.org",
			tags: ["论文", "预印本"],
			search: { kind: "arxiv" },
		},
		"docs.rs": {
			domain: "docs.rs",
			tags: ["rust 文档", "api 文档"],
			search: { kind: "bing-site" },
		},
		zhihu: {
			domain: "zhihu.com",
			tags: ["知乎"],
			search: { kind: "bing-site" },
		},
	},
	domains: {
		// 官方文档 / 代码托管 / 学术 —— 最高
		"github.com": 0.95,
		"gitlab.com": 0.95,
		"docs.rs": 0.95,
		"crates.io": 0.9,
		"npmjs.com": 0.85,
		"doi.org": 0.85,
		"openalex.org": 0.8,
		"doc.rust-lang.org": 0.95,
		"docs.python.org": 0.95,
		"developer.mozilla.org": 0.95,
		"w3.org": 0.95,
		"ietf.org": 0.95,
		"rfc-editor.org": 0.95,
		"arxiv.org": 0.95,
		"acm.org": 0.95,
		"ieee.org": 0.95,
		"nature.com": 0.95,
		"science.org": 0.95,
		"ncbi.nlm.nih.gov": 0.95,
		"stackoverflow.com": 0.9,
		"wikipedia.org": 0.9,
		"kubernetes.io": 0.9,
		"docs.docker.com": 0.9,
		"learn.microsoft.com": 0.9,
		"docs.aws.amazon.com": 0.9,
		"kernel.org": 0.9,
		"lwn.net": 0.9,
		"man7.org": 0.85,
		"gnu.org": 0.85,
		// 官方厂商 / 深度技术写作
		"rust-lang.org": 0.85,
		"python.org": 0.85,
		"golang.org": 0.85,
		"cloud.google.com": 0.8,
		"developer.android.com": 0.8,
		"developer.apple.com": 0.8,
		"martinfowler.com": 0.8,
		"blog.cloudflare.com": 0.75,
		// 优质社区 / 媒体
		"medium.com": 0.7,
		"dev.to": 0.7,
		"infoq.com": 0.7,
		"infoq.cn": 0.7,
		"news.ycombinator.com": 0.7,
		"cloud.tencent.com": 0.7,
		"cloud.aliyun.com": 0.7,
		"developer.huawei.com": 0.7,
		"sspai.com": 0.65,
		"linux.cn": 0.65,
		// 一般技术社区
		"juejin.cn": 0.6,
		"segmentfault.com": 0.55,
		"oschina.net": 0.55,
		"runoob.com": 0.55,
		"cnblogs.com": 0.5,
		"reddit.com": 0.5,
		// 质量参差 —— 按需降权
		"zhihu.com": 0.45,
		"baike.baidu.com": 0.45,
		"w3cschool.cn": 0.4,
		"jianshu.com": 0.35,
		// 内容农场 / 采集站
		"csdn.net": 0.25,
		"51cto.com": 0.25,
		"jishuzhan.net": 0.2,
		"doc88.com": 0.15,
		"docin.com": 0.15,
	},
};

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

/** Validate/normalize a weights JSON payload; throws with a clear message. */
export function parseSourceWeights(input: unknown): SourceWeights {
	if (typeof input !== "object" || input === null) {
		throw new Error("信源权重库格式错误：应为 { defaultWeight, domains } 对象");
	}
	const obj = input as Record<string, unknown>;
	const defaultWeight =
		typeof obj.defaultWeight === "number" && Number.isFinite(obj.defaultWeight)
			? clamp01(obj.defaultWeight)
			: 0.5;
	const domains: Record<string, number> = {};
	if (obj.domains !== undefined) {
		if (typeof obj.domains !== "object" || obj.domains === null || Array.isArray(obj.domains)) {
			throw new Error("信源权重库格式错误：domains 应为 {域名: 权重} 对象");
		}
		for (const [key, value] of Object.entries(obj.domains as Record<string, unknown>)) {
			const host = key.trim().toLowerCase().replace(/^\./, "");
			if (!host) continue;
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`信源权重库格式错误：${key} 的权重应为数字`);
			}
			domains[host] = clamp01(value);
		}
	}
	const parseStringArray = (field: unknown, fallback: string[]): string[] => {
		if (field === undefined) return fallback;
		if (!Array.isArray(field)) {
			throw new Error(`信源权重库格式错误：${field} 字段应为字符串数组`);
		}
		return field
			.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
			.map((x) => x.trim());
	};
	return {
		defaultWeight,
		domains,
		blockedDomains: parseStringArray(obj.blockedDomains, DEFAULT_SOURCE_WEIGHTS.blockedDomains).map(
			(h) => h.toLowerCase().replace(/^\./, ""),
		),
		blockedPatterns: parseStringArray(obj.blockedPatterns, DEFAULT_SOURCE_WEIGHTS.blockedPatterns),
		sites: parseSites(obj.sites),
	};
}

/** Longest-suffix host match against the weight DB; falls back to defaultWeight. */
export function matchWeight(
	weights: SourceWeights,
	host: string,
): { weight: number; key: string | null } {
	const h = host.toLowerCase().replace(/\.$/, "");
	let bestKey = "";
	for (const key of Object.keys(weights.domains)) {
		if ((h === key || h.endsWith(`.${key}`)) && key.length > bestKey.length) {
			bestKey = key;
		}
	}
	return bestKey
		? { weight: weights.domains[bestKey], key: bestKey }
		: { weight: weights.defaultWeight, key: null };
}

export function weightForHost(weights: SourceWeights, host: string): number {
	return matchWeight(weights, host).weight;
}

/** 去空白小写化，用于屏蔽词对「APEC会议 / APEC 会议」这类写法不敏感。 */
function normalizeForMatch(s: string): string {
	return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * Check a result against the blocklists. Domain blacklist uses suffix match;
 * patterns match title/url/snippet as whitespace- and case-insensitive substrings.
 */
export function checkBlocked(
	weights: SourceWeights,
	r: { title: string; url: string; snippet?: string },
): { blocked: boolean; reason: string | null } {
	let host = "";
	try {
		host = new URL(r.url).hostname.toLowerCase();
	} catch {
		host = "";
	}
	if (host) {
		for (const d of weights.blockedDomains) {
			if (host === d || host.endsWith(`.${d}`)) {
				return { blocked: true, reason: `黑名单域名: ${d}` };
			}
		}
	}
	const hay = normalizeForMatch(`${r.title} ${r.url} ${r.snippet ?? ""}`);
	for (const p of weights.blockedPatterns) {
		if (normalizeForMatch(p)) {
			if (hay.includes(normalizeForMatch(p))) {
				return { blocked: true, reason: `命中屏蔽词: ${p}` };
			}
		}
	}
	return { blocked: false, reason: null };
}

// ---------------------------------------------------------------- 常用站点标签（站内直达）

export interface SiteSearchSpec {
	kind:
		| "github"
		| "mdn"
		| "stackexchange"
		| "npm"
		| "crates"
		| "gitlab"
		| "hn"
		| "juejin"
		| "csdn"
		| "openalex"
		| "crossref"
		| "arxiv"
		| "bing-site";
	/** stackexchange 必填：目标站点，如 stackoverflow */
	site?: string;
}

export interface SiteEntry {
	domain: string;
	tags: string[];
	search: SiteSearchSpec;
}

export type SiteRegistry = Record<string, SiteEntry>;

const SITE_KINDS = [
	"github",
	"mdn",
	"stackexchange",
	"npm",
	"crates",
	"gitlab",
	"hn",
	"juejin",
	"csdn",
	"openalex",
	"crossref",
	"arxiv",
	"bing-site",
] as const;

/** 站点注册表：别名 → {域名, 标签, 搜索适配器}。缺失时用内置种子。 */
export function parseSites(input: unknown): SiteRegistry {
	if (input === undefined) return DEFAULT_SOURCE_WEIGHTS.sites;
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("信源权重库格式错误：sites 应为 {别名: {domain, tags, search}} 对象");
	}
	const out: SiteRegistry = {};
	for (const [rawAlias, rawEntry] of Object.entries(input as Record<string, unknown>)) {
		const alias = rawAlias.trim().toLowerCase();
		if (!alias) continue;
		if (typeof rawEntry !== "object" || rawEntry === null) {
			throw new Error(`sites.${rawAlias} 配置应为对象`);
		}
		const e = rawEntry as Record<string, unknown>;
		const domain = typeof e.domain === "string" ? e.domain.trim().toLowerCase() : "";
		if (!domain) throw new Error(`sites.${rawAlias} 缺少 domain`);
		const tags = Array.isArray(e.tags)
			? e.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
			: [];
		const searchRaw = (typeof e.search === "object" && e.search !== null ? e.search : {}) as Record<string, unknown>;
		const kind = searchRaw.kind;
		if (typeof kind !== "string" || !(SITE_KINDS as readonly string[]).includes(kind)) {
			throw new Error(`sites.${rawAlias}.search.kind 应为 ${SITE_KINDS.join(" / ")}`);
		}
		const spec: SiteSearchSpec = { kind: kind as SiteSearchSpec["kind"] };
		if (typeof searchRaw.site === "string" && searchRaw.site.trim()) spec.site = searchRaw.site.trim();
		if (spec.kind === "stackexchange" && !spec.site) {
			throw new Error(`sites.${rawAlias}.search.site 缺失（stackexchange 需要站点名，如 stackoverflow）`);
		}
		out[alias] = { domain, tags, search: spec };
	}
	return out;
}

/** 把用户给的 token（别名/标签/域名）解析成站点条目，按注册表顺序去重。 */
export function resolveSites(
	registry: SiteRegistry,
	tokens: string[],
): Array<{ alias: string; entry: SiteEntry }> {
	const wanted = new Set(tokens.map((t) => t.trim().toLowerCase()).filter(Boolean));
	const out: Array<{ alias: string; entry: SiteEntry }> = [];
	if (wanted.size === 0) return out;
	for (const [alias, entry] of Object.entries(registry)) {
		const hit =
			wanted.has(alias) ||
			entry.tags.some((tag) => wanted.has(tag.toLowerCase())) ||
			[...wanted].some(
				(t) =>
					entry.domain === t ||
					entry.domain.endsWith(`.${t}`) ||
					entry.domain.startsWith(`${t}.`),
			);
		if (hit) out.push({ alias, entry });
	}
	return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** GitHub 仓库搜索 API 响应 → 结果。 */
export function parseGitHubSearch(json: unknown): SearchResult[] {
	const items = asRecord(json)?.items;
	if (!Array.isArray(items)) return [];
	const out: SearchResult[] = [];
	for (const raw of items) {
		const it = asRecord(raw);
		if (!it) continue;
		const url = typeof it.html_url === "string" ? it.html_url : "";
		if (!/^https?:\/\//.test(url)) continue;
		const snippet = [
			typeof it.description === "string" ? it.description : "",
			typeof it.stargazers_count === "number" ? `⭐ ${it.stargazers_count}` : "",
			typeof it.language === "string" ? it.language : "",
		]
			.filter(Boolean)
			.join(" · ")
			.slice(0, 300);
		out.push({ title: String(it.full_name ?? it.name ?? url), url, snippet });
	}
	return out;
}

/** MDN 搜索 API 响应 → 结果。 */
export function parseMDNSearch(json: unknown): SearchResult[] {
	const docs = asRecord(json)?.documents;
	if (!Array.isArray(docs)) return [];
	const out: SearchResult[] = [];
	for (const raw of docs) {
		const d = asRecord(raw);
		if (!d || typeof d.mdn_url !== "string") continue;
		out.push({
			title: String(d.title ?? d.mdn_url),
			url: `https://developer.mozilla.org${d.mdn_url}`,
			snippet: String(d.summary ?? "").slice(0, 300),
		});
	}
	return out;
}

/** StackExchange 搜索 API 响应 → 结果。 */
export function parseStackExchangeSearch(json: unknown): SearchResult[] {
	const items = asRecord(json)?.items;
	if (!Array.isArray(items)) return [];
	const out: SearchResult[] = [];
	for (const raw of items) {
		const it = asRecord(raw);
		if (!it || typeof it.link !== "string") continue;
		const score = typeof it.score === "number" ? `得分 ${it.score}` : "";
		const answers = typeof it.answer_count === "number" ? `${it.answer_count} 答案` : "";
		const state = it.is_answered === true ? "已解决" : "未解决";
		out.push({
			title: decodeEntities(String(it.title ?? "")),
			url: it.link,
			snippet: [score, answers, state].filter(Boolean).join(" · "),
		});
	}
	return out;
}

/** npm registry 搜索响应 → 结果。 */
export function parseNpmSearch(json: unknown): SearchResult[] {
	const objects = asRecord(json)?.objects;
	if (!Array.isArray(objects)) return [];
	const out: SearchResult[] = [];
	for (const raw of objects) {
		const pkg = asRecord(asRecord(raw)?.package);
		if (!pkg || typeof pkg.name !== "string") continue;
		const links = asRecord(pkg.links) ?? {};
		const url = (typeof links.npm === "string" && links.npm) || `https://www.npmjs.com/package/${pkg.name}`;
		out.push({
			title: pkg.name,
			url,
			snippet: [
				typeof pkg.description === "string" ? pkg.description : "",
				typeof pkg.version === "string" ? `v${pkg.version}` : "",
			]
				.filter(Boolean)
				.join(" · ")
				.slice(0, 300),
		});
	}
	return out;
}

/** crates.io 搜索响应 → 结果。 */
export function parseCratesSearch(json: unknown): SearchResult[] {
	const crates = asRecord(json)?.crates;
	if (!Array.isArray(crates)) return [];
	const out: SearchResult[] = [];
	for (const raw of crates) {
		const c = asRecord(raw);
		if (!c || typeof c.name !== "string") continue;
		out.push({
			title: c.name,
			url: `https://crates.io/crates/${c.name}`,
			snippet: [
				typeof c.description === "string" ? c.description : "",
				typeof c.downloads === "number" ? `⬇ ${c.downloads}` : "",
				typeof c.max_version === "string" ? `v${c.max_version}` : "",
			]
				.filter(Boolean)
				.join(" · ")
				.slice(0, 300),
		});
	}
	return out;
}

/** GitLab 项目搜索响应 → 结果。 */
export function parseGitLabSearch(json: unknown): SearchResult[] {
	if (!Array.isArray(json)) return [];
	const out: SearchResult[] = [];
	for (const raw of json) {
		const p = asRecord(raw);
		if (!p || typeof p.web_url !== "string") continue;
		out.push({
			title: String(p.path_with_namespace ?? p.name ?? p.web_url),
			url: p.web_url,
			snippet: [
				typeof p.description === "string" ? p.description : "",
				typeof p.star_count === "number" ? `★ ${p.star_count}` : "",
			]
				.filter(Boolean)
				.join(" · ")
				.slice(0, 300),
		});
	}
	return out;
}

/** Hacker News (Algolia) 搜索响应 → 结果。 */
export function parseHNSearch(json: unknown): SearchResult[] {
	const hits = asRecord(json)?.hits;
	if (!Array.isArray(hits)) return [];
	const out: SearchResult[] = [];
	for (const raw of hits) {
		const h = asRecord(raw);
		if (!h) continue;
		const url =
			(typeof h.url === "string" && h.url) ||
			(typeof h.objectID === "string" ? `https://news.ycombinator.com/item?id=${h.objectID}` : "");
		if (!/^https?:\/\//.test(url)) continue;
		out.push({
			title: decodeEntities(String(h.title ?? h.story_title ?? url)),
			url,
			snippet: [
				typeof h.points === "number" ? `${h.points} 分` : "",
				typeof h.num_comments === "number" ? `${h.num_comments} 评论` : "",
				typeof h.created_at === "string" ? h.created_at.slice(0, 10) : "",
			]
				.filter(Boolean)
				.join(" · "),
		});
	}
	return out;
}

/** 掘金搜索响应 → 结果。 */
export function parseJuejinSearch(json: unknown): SearchResult[] {
	const data = asRecord(json)?.data;
	if (!Array.isArray(data)) return [];
	const out: SearchResult[] = [];
	for (const raw of data) {
		const info = asRecord(asRecord(asRecord(raw)?.result_model)?.article_info);
		if (!info || typeof info.article_id !== "string") continue;
		out.push({
			title: decodeEntities(String(info.title ?? info.article_id)),
			url: `https://juejin.cn/post/${info.article_id}`,
			snippet: [
				typeof info.brief_content === "string" ? info.brief_content : "",
				typeof info.digg_count === "number" ? `👍 ${info.digg_count}` : "",
				typeof info.view_count === "number" ? `${info.view_count} 阅读` : "",
			]
				.filter(Boolean)
				.join(" · ")
				.slice(0, 300),
		});
	}
	return out;
}

/** CSDN 搜索 API 响应 → 结果（标题带 <em> 高亮标签需清洗，URL 去掉跟踪参数）。 */
export function parseCsdnSearch(json: unknown): SearchResult[] {
	const hits = asRecord(json)?.result_vos;
	if (!Array.isArray(hits)) return [];
	const out: SearchResult[] = [];
	for (const raw of hits) {
		const h = asRecord(raw);
		if (!h || typeof h.url !== "string") continue;
		let url = decodeEntities(h.url);
		try {
			const u = new URL(url);
			url = `${u.origin}${u.pathname}`;
		} catch {
			continue;
		}
		out.push({
			title: stripTags(String(h.title ?? url)),
			url,
			snippet: stripTags(String(h.description ?? h.digest ?? "")).slice(0, 300),
		});
	}
	return out;
}

/** OpenAlex 学术搜索响应 → 结果。 */
export function parseOpenAlexSearch(json: unknown): SearchResult[] {
	const results = asRecord(json)?.results;
	if (!Array.isArray(results)) return [];
	const out: SearchResult[] = [];
	for (const raw of results) {
		const w = asRecord(raw);
		if (!w || typeof w.display_name !== "string") continue;
		const landing = asRecord(w.primary_location)?.landing_page_url;
		const url = (typeof landing === "string" && landing) || (typeof w.doi === "string" ? w.doi : "");
		if (!/^https?:\/\//.test(url)) continue;
		out.push({
			title: stripTags(w.display_name),
			url,
			snippet: [
				typeof w.cited_by_count === "number" ? `引用 ${w.cited_by_count}` : "",
				typeof w.publication_year === "number" ? String(w.publication_year) : "",
			]
				.filter(Boolean)
				.join(" · "),
		});
	}
	return out;
}

/** CrossRef 学术搜索响应 → 结果。 */
export function parseCrossrefSearch(json: unknown): SearchResult[] {
	const items = asRecord(asRecord(json)?.message)?.items;
	if (!Array.isArray(items)) return [];
	const out: SearchResult[] = [];
	for (const raw of items) {
		const it = asRecord(raw);
		if (!it || typeof it.URL !== "string") continue;
		const titleRaw = Array.isArray(it.title) ? it.title[0] : it.title;
		out.push({
			title: stripTags(String(titleRaw ?? it.URL)),
			url: it.URL,
			snippet: [
				typeof it["is-referenced-by-count"] === "number" ? `引用 ${it["is-referenced-by-count"]}` : "",
				Array.isArray(it["container-title"]) ? String(it["container-title"][0] ?? "") : "",
			]
				.filter(Boolean)
				.join(" · ")
				.slice(0, 300),
		});
	}
	return out;
}

/** arXiv Atom 响应 → 结果（正则解析，零依赖）。 */
export function parseArxivSearch(xml: string): SearchResult[] {
	const out: SearchResult[] = [];
	const entries = xml.split("<entry>").slice(1);
	for (const raw of entries) {
		const title = raw.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
		const id = raw.match(/<id>([\s\S]*?)<\/id>/i)?.[1] ?? "";
		const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] ?? "";
		const url = id.trim();
		if (!/^https?:\/\//.test(url)) continue;
		out.push({
			title: stripTags(title).replace(/\s+/g, " "),
			url,
			snippet: stripTags(summary).replace(/\s+/g, " ").slice(0, 300),
		});
	}
	return out;
}

/** 站内兜底（bing-site）：结果必须属于目标域名，本地强制过滤。 */
export function filterToDomain(results: SearchResult[], domain: string): SearchResult[] {
	const d = domain.toLowerCase();
	return results.filter((r) => {
		try {
			const host = new URL(r.url).hostname.toLowerCase();
			return host === d || host.endsWith(`.${d}`);
		} catch {
			return false;
		}
	});
}

// ---------------------------------------------------------------- 页面类型判定（只返回内容页）

export type PageKind = "content" | "homepage" | "list";

const LIST_SEGMENT_RE =
	/^(blog|blogs|news|articles?|posts?|archive|archives|category|categories|tags?|topics?|questions?|list|lists|index|search|collections?|channel|channels|column|columns|nav|sitemap|feed|rss|all|more)$/i;
const PAGINATION_SEGMENT_RE = /^(page|p)[-_]?\d+$/i;
const INDEX_FILE_RE = /^(index|home|default|main)\.(html?|php|aspx?|jsp|shtml)$/i;
const LOCALE_SEGMENT_RE = /^[a-z]{2}(-[a-z]{2})?$/i;

/**
 * 判断 URL 更像内容页 / 首页 / 列表页。
 * 规则只看路径形状（不抓页面）：站点根、栏目根、列表词结尾、分页参数 → 非内容页。
 */
export function classifyPageUrl(url: string): PageKind {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "content";
	}
	const segments = u.pathname.split("/").filter(Boolean);
	if (segments.length === 0) return "homepage";
	const last = segments[segments.length - 1];
	const trailingSlash = u.pathname.endsWith("/");
	if (INDEX_FILE_RE.test(last)) return "homepage";
	if (PAGINATION_SEGMENT_RE.test(last)) return "list";
	// /page/2 这类：末段是短数字且前一段是 page（注意：裸 p 在知乎/博客园是文章 ID，不能当分页）
	if (segments.length >= 2 && /^\d{1,3}$/.test(last) && /^page$/i.test(segments[segments.length - 2])) {
		return "list";
	}
	if (LIST_SEGMENT_RE.test(last)) return "list";
	// 栏目根：/rust/ 这类单段目录（含语言根 /zh-CN/）
	if (trailingSlash && segments.length === 1) return "homepage";
	if (trailingSlash && segments.length === 2 && LOCALE_SEGMENT_RE.test(segments[0])) return "homepage";
	// 分页/翻页查询参数（不含裸 p：WordPress 的 ?p=123 是文章 ID）
	for (const key of ["page", "paged", "start", "offset", "pageno", "pageNo"]) {
		const v = u.searchParams.get(key);
		if (v !== null && /^\d+$/.test(v)) return "list";
	}
	// 目录型路径：/category/xxx/ 或 /tag/yyy/（倒数第二段是列表词且以 / 结尾）
	if (trailingSlash && segments.length >= 2 && LIST_SEGMENT_RE.test(segments[segments.length - 2])) {
		return "list";
	}
	return "content";
}

// ---------------------------------------------------------------- 轻量向量嵌入 + 置信度

/** 嵌入维度（特征哈希）。256 维 × f32 = 1KB/页。 */
export const EMBED_DIM = 256;

/**
 * 判定「多源互相印证」的余弦相似度阈值。
 * 2026-10-12 用真实抓取页面标定：同主题跨站 0.28~0.51，无关页面 ≤0.21 → 取 0.25。
 * 注意：词面级嵌入（无模型）跨语言几乎无重叠（中文页 vs 英文页 ≈0.1），
 * 因此跨语言印证识别不到——这是轻量方案的已知边界。
 */
export const SUPPORT_SIM_THRESHOLD = 0.25;

function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

function addFeature(v: Float32Array, key: string, weight: number): void {
	const h = hash32(key);
	const sign = h & 0x80000000 ? -1 : 1;
	v[h % EMBED_DIM] += sign * weight;
}

/**
 * 轻量本地嵌入（零依赖、无模型、毫秒级）：把「拉丁词 + 中文 2/3-gram」做特征哈希，
 * L2 归一化后即为余弦可比向量。用于相关性/多源一致性判断，不做语义蕴含。
 */
export function embedText(text: string): Float32Array {
	const v = new Float32Array(EMBED_DIM);
	const s = text.toLowerCase().slice(0, 20000);
	// 拉丁词（含版本号/包名等  2 字符以上 token）
	for (const w of s.match(/[a-z0-9_+#./-]{2,}/g) ?? []) addFeature(v, `w:${w}`, 1);
	// 中文按 2-gram / 3-gram（汉字连续段），对词序不敏感
	const cjk = (s.match(/[㐀-鿿]+/g) ?? []).join("");
	for (let i = 0; i + 1 < cjk.length; i++) addFeature(v, `c2:${cjk.slice(i, i + 2)}`, 1);
	for (let i = 0; i + 2 < cjk.length; i++) addFeature(v, `c3:${cjk.slice(i, i + 3)}`, 0.6);
	let norm = 0;
	for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
	return v;
}

/** 两个已归一化向量的余弦相似度。 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

/**
 * 查询词面覆盖度：查询特征在页面向量里出现的比例。
 * 短查询 vs 长文档时，纯余弦会被文档长度稀释，覆盖度更稳（0~1）。
 */
export function queryCoverage(queryVec: Float32Array, pageVec: Float32Array): number {
	let total = 0;
	let hit = 0;
	for (let i = 0; i < queryVec.length; i++) {
		const q = queryVec[i];
		if (Math.abs(q) < 1e-6) continue;
		total++;
		if (Math.abs(pageVec[i]) > 1e-6 && Math.sign(pageVec[i]) === Math.sign(q)) hit++;
	}
	return total === 0 ? 0 : hit / total;
}

/** 相关性 = 覆盖度 60% + 余弦 40%（覆盖度抗长度稀释，余弦压噪声）。 */
export function relevanceScore(queryVec: Float32Array, pageVec: Float32Array): number {
	const coverage = queryCoverage(queryVec, pageVec);
	const cosine = Math.max(0, cosineSim(queryVec, pageVec));
	return Math.min(1, 0.6 * coverage + 0.4 * cosine);
}

/** sqlite-vec 默认度量是 L2，归一化向量下 cosine = 1 - d²/2。 */
export function distanceToCosine(distance: number): number {
	return 1 - (distance * distance) / 2;
}

export interface ConfidenceInput {
	/** 与查询的余弦相似度（0~1） */
	relevance: number;
	/** 信源权重（0~1） */
	sourceWeight: number;
	/** 除自身域名外、内容相近（≥SUPPORT_SIM_THRESHOLD）的独立信源数量 */
	support: number;
}

/**
 * 置信度 = 相关性 40% + 信源权重 25% + 多源印证 35%（3 个以上独立信源即满分）。
 * 这是启发式（词面级相似 + 信源可信度 + 交叉印证），不是事实核查。
 */
export function scoreConfidence(i: ConfidenceInput): number {
	const supportScore = Math.min(1, Math.max(0, i.support) / 3);
	const raw =
		0.4 * clamp01(i.relevance) + 0.25 * clamp01(i.sourceWeight) + 0.35 * supportScore;
	return Math.round(clamp01(raw) * 100) / 100;
}



export interface PageContentInfo {
	ok: boolean;
	title: string;
	coreText: string;
	chars: number;
	error: string | null;
}

// ---------------------------------------------------------------- 信息包（JSON 封装）

export interface PackagedResult {
	rank: number;
	title: string;
	url: string;
	weight: number;
	weightSource: string | null;
	/** 结果来路：bing 或站点别名（github/csdn/...） */
	via: string;
	snippet: string;
	content: PageContentInfo | null;
	/** 置信度（启发式：相关性 + 信源权重 + 多源印证）；未抓取页为 null */
	confidence: number | null;
	/** 与查询的余弦相似度 */
	relevance: number | null;
	/** 印证该内容的独立信源数（不含自身域名） */
	support: number | null;
}

export interface DroppedResult {
	title: string;
	url: string;
	weight: number;
	reason: string;
}

export interface SearchPackageTimings {
	/** 检索阶段（Bing SERP 或站内 API 并行） */
	serpMs: number;
	/** 结果页并发抓取阶段（含抓取内联的嵌入） */
	contentMs: number;
	/** 置信度嵌入阶段（复用抓取期向量后通常很小） */
	embedMs: number;
	/** 端到端总耗时 */
	totalMs: number;
}

export interface SearchPackageMeta {
	count: number;
	offset: number;
	includeContent: boolean;
	contentTop: number;
	contentChars: number;
	minWeight: number | null;
	fetchedPages: number;
	failedPages: number;
	/** 站内直达时列出命中的站点别名；普通搜索为 null */
	sites: string[] | null;
	/** 各阶段耗时（毫秒），用于观察调度效率 */
	timings: SearchPackageTimings;
}

export interface SearchPackage {
	query: string;
	engine: string;
	fetchedAt: string;
	results: PackagedResult[];
	dropped: DroppedResult[];
	meta: SearchPackageMeta;
}

export interface BuildSearchPackageInput {
	query: string;
	engine?: string;
	fetchedAt: string;
	contentChars: number;
	dropReason: string;
	results: Array<
		SearchResult & {
			weight: number;
			weightSource?: string | null;
			via?: string;
			confidence?: number | null;
			relevance?: number | null;
			support?: number | null;
			content?: { ok: boolean; title: string; coreText: string; error?: string };
		}
	>;
	dropped: Array<SearchResult & { weight: number; reason?: string }>;
	meta: Omit<SearchPackageMeta, "fetchedPages" | "failedPages" | "timings"> & {
		timings?: Partial<SearchPackageTimings>;
	};
}

/**
 * Assemble the JSON package of useful search information: ranked results with
 * source weights and core-text excerpts (sliced to contentChars; full length
 * reported in chars), plus dropped low-trust sources and fetch stats.
 */
export function buildSearchPackage(input: BuildSearchPackageInput): SearchPackage {
	let fetchedPages = 0;
	let failedPages = 0;
	const results: PackagedResult[] = input.results.map((r, i) => {
		let content: PageContentInfo | null = null;
		if (r.content) {
			if (r.content.ok) fetchedPages++;
			else failedPages++;
			content = {
				ok: r.content.ok,
				title: r.content.title,
				coreText: r.content.coreText.slice(0, input.contentChars),
				chars: r.content.coreText.length,
				error: r.content.error ?? null,
			};
		}
		return {
			rank: i + 1,
			title: r.title,
			url: r.url,
			weight: r.weight,
			weightSource: r.weightSource ?? null,
			via: r.via ?? "bing",
			snippet: r.snippet,
			content,
			confidence: r.confidence ?? null,
			relevance: r.relevance ?? null,
			support: r.support ?? null,
		};
	});
	return {
		query: input.query,
		engine: input.engine ?? "bing",
		fetchedAt: input.fetchedAt,
		results,
		dropped: input.dropped.map((d) => ({
			title: d.title,
			url: d.url,
			weight: d.weight,
			reason: d.reason ?? input.dropReason,
		})),
		meta: {
			count: input.meta.count,
			offset: input.meta.offset,
			includeContent: input.meta.includeContent,
			contentTop: input.meta.contentTop,
			contentChars: input.meta.contentChars,
			minWeight: input.meta.minWeight,
			fetchedPages,
			failedPages,
			sites: input.meta.sites,
			timings: {
				serpMs: 0,
				contentMs: 0,
				embedMs: 0,
				totalMs: 0,
				...input.meta.timings,
			},
		},
	};
}

// ---------------------------------------------------------------- concurrency

/**
 * Map with bounded concurrency. Results keep input order; per-item failures
 * are captured as rejected settled results instead of aborting the batch.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let next = 0;
	const workers = Math.max(1, Math.min(limit, items.length || 1));
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = { status: "fulfilled", value: await fn(items[i], i) };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		}
	}
	await Promise.all(Array.from({ length: workers }, () => worker()));
	return results;
}
