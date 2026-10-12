// Unit tests for web-search/core.ts — pure functions, run with plain node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	applySetCookies,
	buildSearchPackage,
	checkBlocked,
	classifyPageUrl,
	cookieHeaderFor,
	cosineSim,
	decodeEntities,
	DEFAULT_SOURCE_WEIGHTS,
	distanceToCosine,
	EMBED_DIM,
	embedText,
	extractTitle,
	filterCoreLines,
	filterToDomain,
	htmlToText,
	isBingHost,
	looksLikeCaptcha,
	mapLimit,
	matchWeight,
	parseArxivSearch,
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
	parseSites,
	parseSourceWeights,
	parseStackExchangeSearch,
	queryCoverage,
	relevanceScore,
	resolveSites,
	scoreConfidence,
	stripBoilerplate,
	stripTags,
	weightForHost,
} from "../core.ts";

// --- decodeEntities / stripTags ---
assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#65;&#x42;"), "a & b <c> AB");
assert.equal(decodeEntities("x&nbsp;y&ensp;z"), "x y z");
assert.equal(stripTags("<strong>Rust</strong> 教程 &amp; 入门"), "Rust 教程 & 入门");

// --- parseBingResults on real SERP ---
const serp = readFileSync(new URL("./bing_test.html", import.meta.url), "utf-8");
const results = parseBingResults(serp);
console.log(`parsed ${results.length} results from real SERP`);
assert.ok(results.length >= 5, `expected >=5 results, got ${results.length}`);
for (const r of results) {
	assert.ok(r.title.length > 0, "empty title");
	assert.ok(/^https?:\/\//.test(r.url), `bad url: ${r.url}`);
	assert.ok(!r.title.includes("<"), `title has tags: ${r.title}`);
	assert.ok(!r.snippet.includes("&ensp;"), `snippet has raw entity: ${r.snippet}`);
}
console.log("first 3:", results.slice(0, 3));

// --- captcha detection ---
assert.equal(looksLikeCaptcha(serp), false);
assert.equal(looksLikeCaptcha('<div class="b_captcha">请解决以下难题</div>'), true);

// --- htmlToText core-text extraction ---
const page = `<!doctype html><html><head><title>测试页 &amp; 标题</title>
<style>.x{color:red}</style><script>alert(1)</script></head>
<body><nav>菜单 首页 关于</nav>
<main><h1>正文标题</h1><p>第一段，包含&nbsp;空格。</p>
<p>第二段 <a href="https://x.example">链接</a> 文本。</p>
<ul><li>项目一</li><li>项目二</li></ul></main>
<footer>版权信息</footer></body></html>`;
const text = htmlToText(page);
console.log("--- htmlToText ---\n" + text);
assert.ok(text.includes("正文标题"));
assert.ok(text.includes("第一段，包含 空格"));
assert.ok(text.includes("• 项目一"));
assert.ok(text.includes("链接 文本"));
assert.ok(!text.includes("alert"), "script leaked");
assert.ok(!text.includes("color:red"), "style leaked");
assert.ok(!text.includes("菜单"), "nav not stripped");
assert.ok(!text.includes("版权信息"), "footer not stripped");
assert.ok(!text.includes("<"), "tags leaked");

assert.equal(extractTitle(page), "测试页 & 标题");

// --- stripBoilerplate: nested div sidebar removed as one unit ---
const page2 = `<html><body>
<div class="sidebar"><div><p>侧栏推荐</p><ul><li>广告位</li></ul></div></div>
<div id="comment-list"><div><p>评论区内容</p></div></div>
<main><h2>要点</h2><p>这是正文内容，句子足够长所以会保留下来。</p></main>
</body></html>`;
const t2 = htmlToText(page2);
console.log("--- nested boilerplate ---\n" + t2);
assert.ok(!t2.includes("侧栏推荐"), "sidebar leaked");
assert.ok(!t2.includes("广告位"), "sidebar li leaked");
assert.ok(!t2.includes("评论区"), "comment block leaked");
assert.ok(t2.includes("要点"), "heading lost");
assert.ok(t2.includes("这是正文内容"), "prose lost");

// --- filterCoreLines: menu/UI noise dropped, marked headings kept ---
const t3 = filterCoreLines(
	[
		"首页 | 关于我们 | 联系方式 | 登录 | 注册",
		"正文句子，应当保留下来作为核心内容。",
		"\x01结论\x01",
		"登录",
		"• 列表项内容",
		"版权所有 2024",
	].join("\n"),
);
console.log("--- filterCoreLines ---\n" + t3);
assert.ok(!t3.includes("首页 |"), "menu line kept");
assert.ok(!t3.includes("版权所有"), "copyright line kept");
assert.ok(!t3.includes("登录"), "ui line kept");
assert.ok(t3.includes("正文句子"), "prose dropped");
assert.ok(t3.includes("结论"), "short heading dropped");
assert.ok(t3.includes("• 列表项内容"), "list item dropped");

// --- empty / no-result SERP ---
assert.deepEqual(parseBingResults("<html><body>nothing</body></html>"), []);

// --- cookie jar helpers ---
assert.equal(isBingHost("cn.bing.com"), true);
assert.equal(isBingHost("www.bing.com"), true);
assert.equal(isBingHost("example.com"), false);
assert.equal(isBingHost("bing.com.evil.com"), false);

const jar = {};
applySetCookies(jar, [
	"MUID=abc123; expires=Wed, 21 Oct 2026 07:28:00 GMT; path=/; domain=.bing.com",
	"SRCHD=AF=NOFORM; path=/; secure",
	"empty=; path=/",
]);
assert.equal(jar.MUID, "abc123");
assert.equal(jar.SRCHD, "AF=NOFORM");
assert.equal(jar.empty, undefined, "empty cookie value should delete");
assert.equal(cookieHeaderFor(jar, "cn.bing.com"), "MUID=abc123; SRCHD=AF=NOFORM");
assert.equal(cookieHeaderFor(jar, "example.com"), undefined, "non-bing host gets no cookies");
applySetCookies(jar, ["MUID=x; Max-Age=0; path=/"]);
assert.equal(jar.MUID, undefined, "Max-Age=0 deletes cookie");
assert.equal(cookieHeaderFor(jar, "cn.bing.com"), "SRCHD=AF=NOFORM");
assert.equal(cookieHeaderFor({}, "cn.bing.com"), undefined);

// --- 信源权重库 ---
const w = parseSourceWeights({
	defaultWeight: 0.5,
	domains: { "GitHub.com": 0.9, "docs.rs": 0.95, "csdn.net": 0.2 },
});
assert.equal(weightForHost(w, "github.com"), 0.9);
assert.equal(weightForHost(w, "api.github.com"), 0.9, "subdomain suffix match");
assert.equal(weightForHost(w, "docs.rs"), 0.95);
assert.equal(weightForHost(w, "notgithub.com"), 0.5, "suffix must be a label boundary");
assert.equal(weightForHost(w, "zhuanlan.zhihu.com"), 0.5, "unknown domain uses default");
assert.equal(parseSourceWeights({ domains: { "x.com": 2 } }).domains["x.com"], 1, "weight clamped");
assert.throws(() => parseSourceWeights({ domains: { "x.com": "high" } }), /权重应为数字/);
assert.equal(weightForHost(DEFAULT_SOURCE_WEIGHTS, "arxiv.org"), 0.95);
assert.equal(weightForHost(DEFAULT_SOURCE_WEIGHTS, "blog.csdn.net"), 0.25);
assert.equal(weightForHost(DEFAULT_SOURCE_WEIGHTS, "example.org"), 0.5);

// --- matchWeight: 命中来源域名 ---
assert.deepEqual(matchWeight(w, "api.github.com"), { weight: 0.9, key: "github.com" });
assert.deepEqual(matchWeight(w, "unknown.example"), { weight: 0.5, key: null });
assert.deepEqual(matchWeight(DEFAULT_SOURCE_WEIGHTS, "blog.csdn.net"), { weight: 0.25, key: "csdn.net" });

// --- 黑名单：域名后缀 + 屏蔽词 ---
const bw = parseSourceWeights({
	defaultWeight: 0.5,
	domains: { "docs.rs": 0.95 },
	blockedDomains: ["qcc.com", "aiqicha.baidu.com"],
	blockedPatterns: ["企查查", "APEC会议"],
});
assert.deepEqual(checkBlocked(bw, { title: "小米科技有限责任公司 - 企查查", url: "https://www.qcc.com/firm/x.html" }), {
	blocked: true,
	reason: "黑名单域名: qcc.com",
});
assert.equal(
	checkBlocked(bw, { title: "正常页面", url: "https://sub.aiqicha.baidu.com/company_detail_1" }).blocked,
	true,
	"subdomain of blocked domain",
);
assert.equal(
	checkBlocked(bw, { title: "正常页面", url: "https://notqcc.com/firm/x" }).blocked,
	false,
	"label boundary: notqcc.com must not match qcc.com",
);
assert.equal(
	checkBlocked(bw, { title: "2026年APEC会议时间地点全览", url: "https://wenku.baidu.com/view/x" }).reason,
	"命中屏蔽词: APEC会议",
);
assert.equal(
	checkBlocked(bw, { title: "apec 会议 安排", url: "https://example.com/a" }).blocked,
	true,
	"pattern match ignores whitespace and case",
);
assert.equal(
	checkBlocked(bw, { title: "企查查式站点导航", url: "https://example.com/b" }).blocked,
	true,
	"pattern matches title",
);
assert.equal(
	checkBlocked(bw, { title: "SQLite vector search", url: "https://docs.rs/sqlite-vec" }).blocked,
	false,
	"clean result passes",
);
// 屏蔽词也会扫 URL 与摘要
assert.equal(
	checkBlocked(bw, { title: "某公司简介", url: "https://x.example/", snippet: "见企查查页面" }).blocked,
	true,
	"pattern matches snippet",
);

// 缺字段 → 补内置默认黑名单；显式空数组 → 尊重用户选择
assert.ok(parseSourceWeights({}).blockedDomains.includes("qcc.com"), "missing blockedDomains falls back to seed");
assert.deepEqual(parseSourceWeights({ blockedDomains: [], blockedPatterns: [] }).blockedDomains, []);
assert.throws(() => parseSourceWeights({ blockedDomains: "qcc.com" }), /字符串数组/);
assert.equal(
	checkBlocked(DEFAULT_SOURCE_WEIGHTS, { title: "小米科技有限责任公司 - 爱企查", url: "https://aiqicha.baidu.com/x" }).blocked,
	true,
	"seed blocks aiqicha",
);
assert.equal(
	checkBlocked(DEFAULT_SOURCE_WEIGHTS, { title: "正常结果", url: "https://docs.rs/sqlite-vec" }).blocked,
	false,
	"seed does not block normal docs",
);

// --- 黑名单：域名后缀 + 屏蔽词（空白/大小写不敏感） ---
{
	// w 没写 blocked 字段 → 落到默认黑名单（企查查/APEC会议 等）
	assert.equal(checkBlocked(w, { title: "某公司 - 企查查", url: "https://www.qcc.com/firm/x.html" }).blocked, true);
	assert.equal(checkBlocked(w, { title: "某公司", url: "https://www.qcc.com/firm/x.html" }).reason, "黑名单域名: qcc.com");
	assert.equal(checkBlocked(w, { title: "某公司详情", url: "https://aiqicha.baidu.com/company/1" }).blocked, true);
	assert.equal(checkBlocked(w, { title: "某公司", url: "https://notqcc.com/x" }).blocked, false, "suffix boundary");
	assert.equal(checkBlocked(w, { title: "2026年APEC会议时间地点全览", url: "https://wenku.baidu.com/view/abc" }).blocked, true);
	assert.equal(checkBlocked(w, { title: "APEC 会议 倒计时", url: "https://news.example.com/a" }).blocked, true, "空白不敏感");
	assert.equal(checkBlocked(w, { title: "apec会议纪要", url: "https://x.example/" }).blocked, true, "大小写不敏感");
	assert.equal(checkBlocked(w, { title: "Rust 程序设计语言", url: "https://rust-lang.org/" }).blocked, false);

	// 显式空数组 = 用户选择清空黑名单，不得回落到默认
	const cleared = parseSourceWeights({ blockedDomains: [], blockedPatterns: [] });
	assert.equal(checkBlocked(cleared, { title: "某公司 - 企查查", url: "https://www.qcc.com/firm/x" }).blocked, false);
	assert.deepEqual(cleared.blockedDomains, []);

	// 自定义屏蔽词
	const custom = parseSourceWeights({ blockedPatterns: ["会议日程"] });
	assert.equal(checkBlocked(custom, { title: "XXX 会议 日程安排", url: "https://x.example/" }).blocked, true);
	assert.throws(() => parseSourceWeights({ blockedDomains: "qcc.com" }), /字符串数组/);
}

// --- buildSearchPackage: JSON 信息包 ---
{
	const pkg = buildSearchPackage({
		query: "q",
		fetchedAt: "2026-10-11T00:00:00.000Z",
		contentChars: 10,
		dropReason: "低于 minWeight",
		results: [
			{
				title: "A",
				url: "https://docs.rs/x",
				snippet: "s1",
				weight: 0.95,
				weightSource: "docs.rs",
				content: { ok: true, title: "tA", coreText: "0123456789ABCDEF", error: undefined },
			},
			{
				title: "B",
				url: "https://x.dev/y",
				snippet: "s2",
				weight: 0.5,
				weightSource: null,
				content: { ok: false, title: "", coreText: "", error: "HTTP 403" },
			},
			{ title: "C", url: "https://c.example/z", snippet: "s3", weight: 0.5, weightSource: null },
		],
		dropped: [
			{ title: "D", url: "https://d.example/", snippet: "", weight: 0.1 },
			{ title: "E", url: "https://www.qcc.com/firm/x.html", snippet: "", weight: 0.5, reason: "黑名单域名: qcc.com" },
		],
		meta: {
			count: 4,
			offset: 0,
			includeContent: true,
			contentTop: 2,
			contentChars: 10,
			minWeight: 0.3,
			sites: null,
		},
	});
	assert.equal(pkg.engine, "bing");
	assert.equal(pkg.results.length, 3);
	assert.deepEqual(pkg.results.map((r) => r.rank), [1, 2, 3]);
	assert.equal(pkg.results[0].content.coreText, "0123456789", "excerpt sliced to contentChars");
	assert.equal(pkg.results[0].content.chars, 16, "full length reported");
	assert.equal(pkg.results[0].content.error, null);
	assert.equal(pkg.results[1].content.ok, false);
	assert.equal(pkg.results[1].content.error, "HTTP 403");
	assert.equal(pkg.results[2].content, null, "unfetched result has null content");
	assert.deepEqual(pkg.dropped, [
		{ title: "D", url: "https://d.example/", weight: 0.1, reason: "低于 minWeight" },
		{ title: "E", url: "https://www.qcc.com/firm/x.html", weight: 0.5, reason: "黑名单域名: qcc.com" },
	]);
	assert.equal(pkg.meta.fetchedPages, 1);
	assert.equal(pkg.meta.failedPages, 1);
	assert.equal(pkg.meta.minWeight, 0.3);
	assert.equal(pkg.meta.sites, null);
	assert.equal(pkg.results[0].via, "bing", "default via is bing");
	for (const k of ["query", "engine", "fetchedAt", "results", "dropped", "meta"]) {
		assert.ok(k in pkg, `package missing ${k}`);
	}
	for (const k of ["count", "offset", "includeContent", "contentTop", "contentChars", "minWeight", "fetchedPages", "failedPages", "sites"]) {
		assert.ok(k in pkg.meta, `meta missing ${k}`);
	}
	JSON.parse(JSON.stringify(pkg));
}

// --- mapLimit: order preserved, concurrency bounded, errors captured ---
{
	const active = [];
	let maxActive = 0;
	const settled = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
		active.push(x);
		maxActive = Math.max(maxActive, active.length);
		await new Promise((r) => setTimeout(r, 10));
		active.splice(active.indexOf(x), 1);
		if (x === 3) throw new Error("boom");
		return x * 2;
	});
	assert.equal(maxActive <= 2, true, `concurrency exceeded: ${maxActive}`);
	assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
	assert.deepEqual(
		settled.map((s) => (s.status === "fulfilled" ? s.value : null)),
		[2, 4, null, 8, 10, 12],
		"input order preserved",
	);
	assert.equal(settled[2].reason.message, "boom");
	assert.deepEqual(await mapLimit([], 3, async () => 1), []);
}

// --- classifyPageUrl：只留内容页 ---
const kindCases = [
	["https://example.com/", "homepage"],
	["https://example.com", "homepage"],
	["https://rust-lang.org/zh-CN/", "homepage"],
	["https://example.com/index.html", "homepage"],
	["https://example.com/default.aspx", "homepage"],
	["https://blog.example.com/", "homepage"],
	["https://example.com/blog", "list"],
	["https://example.com/blog/", "list"],
	["https://example.com/news", "list"],
	["https://example.com/tag?x=1", "list"],
	["https://example.com/category/rust/", "list"],
	["https://example.com/page/2", "list"],
	["https://example.com/page/250", "list"],
	["https://zhuanlan.zhihu.com/p/671404492", "content"],
	["https://www.cnblogs.com/damaoa/p/18952729", "content"],
	["https://example.com/post/p/12345678", "content"],
	["https://example.com/doc?p=3", "content"],
	["https://example.com/doc?page=3", "list"],
	["https://example.com/list?page=3", "list"],
	["https://stackoverflow.com/questions", "list"],
	["https://example.com/archive/2024/", "list"],
	["https://github.com/asg017/sqlite-vec", "content"],
	["https://docs.rs/sqlite-vec/latest/sqlite_vec/", "content"],
	["https://www.runoob.com/rust/rust-tutorial.html", "content"],
	["https://stackoverflow.com/questions/7106012/how-to-do-x", "content"],
	["https://example.com/blog/2024/01/how-to-do-x", "content"],
	["https://example.com/rust/rust-tutorial.html", "content"],
];
for (const [u, want] of kindCases) {
	assert.equal(classifyPageUrl(u), want, `${u} → ${want}`);
}
assert.equal(classifyPageUrl("not a url"), "content", "invalid url falls back to content");

// --- 站点注册表：别名/标签/域名解析 ---
const sites = parseSites({
	github: { domain: "github.com", tags: ["代码", "code"], search: { kind: "github" } },
	csdn: { domain: "csdn.net", tags: ["中文博客"], search: { kind: "bing-site" } },
	so: { domain: "stackoverflow.com", tags: ["问答"], search: { kind: "stackexchange", site: "stackoverflow" } },
});
assert.deepEqual(resolveSites(sites, ["github"]).map((r) => r.alias), ["github"], "alias match");
assert.deepEqual(resolveSites(sites, ["代码"]).map((r) => r.alias), ["github"], "tag match");
assert.deepEqual(resolveSites(sites, ["csdn.net"]).map((r) => r.alias), ["csdn"], "domain exact match");
assert.deepEqual(resolveSites(sites, ["csdn"]).map((r) => r.alias), ["csdn"], "domain prefix match");
assert.deepEqual(resolveSites(sites, ["github", "问答", "csdn"]).map((r) => r.alias), ["github", "csdn", "so"], "multi tokens keep registry order");
assert.deepEqual(resolveSites(sites, ["nope"]), [], "unknown token");
assert.throws(() => parseSites({ x: { domain: "x.com", search: { kind: "bad" } } }), /search\.kind/);
assert.throws(() => parseSites({ x: { domain: "x.com", search: { kind: "stackexchange" } } }), /search\.site/);
assert.ok(Object.keys(parseSourceWeights({}).sites).includes("github"), "missing sites falls back to seed");

// --- 站内 API 解析器 ---
{
	const gh = parseGitHubSearch({
		items: [
			{ full_name: "asg017/sqlite-vec", html_url: "https://github.com/asg017/sqlite-vec", description: "vector search", stargazers_count: 8179, language: "C" },
			{ full_name: "bad/no-url" },
		],
	});
	assert.equal(gh.length, 1, "github: entries without html_url are dropped");
	assert.equal(gh[0].url, "https://github.com/asg017/sqlite-vec");
	assert.ok(gh[0].snippet.includes("⭐ 8179"), "github: stars in snippet");

	const mdn = parseMDNSearch({ documents: [{ title: "Fetch API", mdn_url: "/zh-CN/docs/Web/API/Fetch_API", summary: "获取资源" }] });
	assert.equal(mdn[0].url, "https://developer.mozilla.org/zh-CN/docs/Web/API/Fetch_API");

	const se = parseStackExchangeSearch({
		items: [{ title: "How to &amp; why", link: "https://stackoverflow.com/questions/1/x", score: 12, answer_count: 3, is_answered: true }],
	});
	assert.equal(se[0].title, "How to & why", "SE title entities decoded");
	assert.ok(se[0].snippet.includes("得分 12") && se[0].snippet.includes("已解决"), "SE snippet signals");
	assert.deepEqual(parseGitHubSearch(null), []);
	assert.deepEqual(parseMDNSearch({}), []);
	assert.deepEqual(parseStackExchangeSearch({ items: "x" }), []);
}

// --- filterToDomain：site: 兜底强制域名 ---
{
	const res = filterToDomain(
		[
			{ title: "a", url: "https://blog.csdn.net/x/article/details/1", snippet: "" },
			{ title: "b", url: "https://csdn.net/y", snippet: "" },
			{ title: "c", url: "https://notcsdn.net/z", snippet: "" },
			{ title: "d", url: "https://github.com/a/b", snippet: "" },
		],
		"csdn.net",
	);
	assert.deepEqual(res.map((r) => r.title), ["a", "b"]);
}

// --- 新增平台解析器 ---
{
	const npm = parseNpmSearch({ objects: [{ package: { name: "sqlite-vec", version: "0.1.9", description: "vector search", links: { npm: "https://www.npmjs.com/package/sqlite-vec" } } }] });
	assert.equal(npm[0].title, "sqlite-vec");
	assert.ok(npm[0].snippet.includes("v0.1.9"), "npm version in snippet");

	const cr = parseCratesSearch({ crates: [{ name: "sqlite-vec", description: "FFI bindings", downloads: 3344496, max_version: "0.1.10" }] });
	assert.equal(cr[0].url, "https://crates.io/crates/sqlite-vec");
	assert.ok(cr[0].snippet.includes("⬇ 3344496"), "crates downloads in snippet");

	const gl = parseGitLabSearch([{ path_with_namespace: "a/b", web_url: "https://gitlab.com/a/b", description: null, star_count: 7 }]);
	assert.equal(gl[0].title, "a/b");
	assert.ok(gl[0].snippet.includes("★ 7"));

	const hn = parseHNSearch({ hits: [{ title: "Sqlite-vec &amp; friends", url: "https://example.com/x", objectID: "1", points: 314, num_comments: 42 }] });
	assert.equal(hn[0].title, "Sqlite-vec & friends", "HN title entities decoded");
	assert.ok(hn[0].snippet.includes("314 分"));
	assert.equal(parseHNSearch({ hits: [{ title: "Ask HN", objectID: "2" }] })[0].url, "https://news.ycombinator.com/item?id=2", "HN fallback to item url");

	const jj = parseJuejinSearch({ data: [{ result_model: { article_info: { article_id: "7646", title: "掘金文章", brief_content: "摘要", digg_count: 9, view_count: 100 } } }] });
	assert.equal(jj[0].url, "https://juejin.cn/post/7646");
	assert.ok(jj[0].snippet.includes("👍 9"));

	const cs = parseCsdnSearch({ result_vos: [{ title: "<em>SQLite</em>-<em>Vec</em>：AI 向量搜索", url: "https://blog.csdn.net/x/article/details/1?utm_medium=distribute&spm=1", description: "介绍" }] });
	assert.equal(cs[0].title, "SQLite-Vec：AI 向量搜索", "csdn em tags stripped");
	assert.equal(cs[0].url, "https://blog.csdn.net/x/article/details/1", "csdn tracking params stripped");

	const oa = parseOpenAlexSearch({ results: [{ display_name: "WunDeeDB.jl", doi: "https://doi.org/10.1/x", cited_by_count: 3, publication_year: 2025, primary_location: { landing_page_url: "https://doi.org/10.1/x" } }] });
	assert.equal(oa[0].title, "WunDeeDB.jl");
	assert.ok(oa[0].snippet.includes("引用 3"));

	const xr = parseCrossrefSearch({ message: { items: [{ title: ["SQLite Internals"], URL: "https://doi.org/10.1007/x", "is-referenced-by-count": 5, "container-title": ["Apress"] }] } });
	assert.equal(xr[0].title, "SQLite Internals");
	assert.equal(xr[0].url, "https://doi.org/10.1007/x");

	const ax = parseArxivSearch(`<feed><entry><title>Vector DB &amp; SQLite</title><id>http://arxiv.org/abs/2501.00001v1</id><summary>We study &lt;vectors&gt;.</summary></entry><entry><title>No id</title><summary>x</summary></entry></feed>`);
	assert.equal(ax.length, 1, "arxiv entry without id dropped");
	assert.equal(ax[0].title, "Vector DB & SQLite", "arxiv entities decoded");
	assert.ok(ax[0].snippet.includes("<vectors>"), "arxiv summary tags decoded");

	for (const [name, fn, empty] of [["npm", parseNpmSearch, {}], ["crates", parseCratesSearch, {}], ["gitlab", parseGitLabSearch, []], ["hn", parseHNSearch, {}], ["juejin", parseJuejinSearch, {}], ["csdn", parseCsdnSearch, {}], ["openalex", parseOpenAlexSearch, {}], ["crossref", parseCrossrefSearch, {}], ["arxiv", parseArxivSearch, "<feed></feed>"]]) {
		assert.deepEqual(fn(empty), [], `${name}: empty input → []`);
	}
}

// --- 轻量嵌入 + 置信度 ---
{
	const a = embedText("sqlite-vec 是 SQLite 的向量扩展，支持 KNN 查询");
	const b = embedText("SQLite 向量扩展 sqlite-vec，可以用 KNN 检索");
	const c = embedText("今天天气不错，适合出去散步和钓鱼");
	assert.equal(embedText("x").length, EMBED_DIM, "dims");
	assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6, "self cosine = 1（已归一化）");
	const simAB = cosineSim(a, b);
	const simAC = cosineSim(a, c);
	console.log(`embedding: sim(相关)=${simAB.toFixed(3)} sim(无关)=${simAC.toFixed(3)}`);
	assert.ok(simAB > simAC, "相关文本相似度应高于无关文本");
	assert.ok(simAB > 0.3, `related texts should be clearly similar, got ${simAB}`);
	assert.ok(simAC < 0.2, `unrelated texts should be dissimilar, got ${simAC}`);
	assert.ok(cosineSim(embedText(""), embedText("")) === 0, "空文本为零向量（余弦 0）");

	// L2 距离 ↔ 余弦换算：d=0 → 1；d=√2 → 0
	assert.equal(distanceToCosine(0), 1);
	assert.ok(Math.abs(distanceToCosine(Math.SQRT2)) < 1e-9);

	// 覆盖度/相关性：短查询 vs 长文档（纯余弦会被稀释）
	const q = embedText("sqlite-vec 向量扩展");
	const docOn = embedText("sqlite-vec 是 SQLite 的向量扩展，支持 KNN 查询。安装 sqlite-vec 后可创建向量表并做近邻检索。");
	const docOff = embedText("本文介绍 SQLite 的基础用法：建表、插入数据、索引与事务处理，适合初学者阅读。");
	const covOn = queryCoverage(q, docOn);
	const covOff = queryCoverage(q, docOff);
	console.log(`coverage: 相关=${covOn.toFixed(3)} 无关=${covOff.toFixed(3)}`);
	assert.ok(covOn > covOff, "相关文档覆盖度更高");
	assert.ok(covOn > 0.5, `相关文档应覆盖大部分查询特征，got ${covOn}`);
	const relOn = relevanceScore(q, docOn);
	const relOff = relevanceScore(q, docOff);
	assert.ok(relOn > relOff, "相关性应区分相关/无关");
	assert.ok(relOn > 0.5, `相关文档相关性应明显偏高，got ${relOn.toFixed(3)}`);
	assert.ok(relOn <= 1 && relOff >= 0, "相关性落在 0~1");

	// 置信度：相关性 40% + 权重 25% + 多源印证 35%（3 源满分）
	assert.equal(scoreConfidence({ relevance: 1, sourceWeight: 1, support: 3 }), 1);
	assert.equal(scoreConfidence({ relevance: 0, sourceWeight: 0, support: 0 }), 0);
	assert.equal(scoreConfidence({ relevance: 1, sourceWeight: 1, support: 0 }), 0.65, "无印证封顶 0.65");
	assert.equal(scoreConfidence({ relevance: 0.5, sourceWeight: 0.5, support: 1 }), Math.round((0.4 * 0.5 + 0.25 * 0.5 + 0.35 / 3) * 100) / 100);
	assert.ok(scoreConfidence({ relevance: 1, sourceWeight: 1, support: 9 }) <= 1, "clamped");
	assert.ok(scoreConfidence({ relevance: -1, sourceWeight: 0, support: 0 }) === 0, "negative clamped");
}

console.log("\nALL CORE TESTS PASSED");
