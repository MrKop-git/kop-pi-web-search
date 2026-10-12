// SQLite 存储层单测（node:sqlite 在普通 node 下可用）。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dbStats,
	getCachedPage,
	hasVecSupport,
	knnPages,
	loadWeights,
	neighborsOf,
	openWebSearchDb,
	putCachedPage,
	recordSearch,
	searchPages,
	vecCount,
} from "../db.ts";
import { cosineSim, DEFAULT_SOURCE_WEIGHTS, embedText } from "../core.ts";
import { createOnnxEmbedder } from "../embed-onnx.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-ws-db-"));

// --- 1) 全新库：内置种子 ---
{
	const db = openWebSearchDb(join(dir, "fresh.db"));
	const w = loadWeights(db);
	assert.equal(w.domains["github.com"], 0.95, "seed weights");
	assert.ok(w.blockedDomains.includes("qcc.com"), "seed blocked domains");
	assert.ok(w.blockedPatterns.includes("APIC会议".replace("APIC", "APEC")), "seed blocked patterns");
	assert.ok(Object.keys(w.sites).length >= 12, "seed sites");
	assert.equal(w.sites.github.search.kind, "github");
	assert.equal(w.sites.stackoverflow.search.site, "stackoverflow");
	assert.equal(w.defaultWeight, DEFAULT_SOURCE_WEIGHTS.defaultWeight);
	const st = dbStats(db);
	assert.equal(st.sources, Object.keys(DEFAULT_SOURCE_WEIGHTS.domains).length);
	assert.equal(st.searches, 0);
	db.close();
}

// --- 2) 旧版 JSON 导入 ---
{
	const legacy = join(dir, "web-sources.json");
	writeFileSync(
		legacy,
		JSON.stringify({
			defaultWeight: 0.42,
			domains: { "custom.example": 0.77 },
			blockedDomains: ["bad.example"],
			blockedPatterns: ["垃圾词"],
			sites: { mine: { domain: "mine.example", tags: ["自建"], search: { kind: "bing-site" } } },
		}),
	);
	const db = openWebSearchDb(join(dir, "imported.db"), legacy);
	const w = loadWeights(db);
	assert.equal(w.defaultWeight, 0.42, "imported defaultWeight");
	assert.equal(w.domains["custom.example"], 0.77);
	assert.deepEqual(w.blockedDomains, ["bad.example"]);
	assert.deepEqual(w.blockedPatterns, ["垃圾词"]);
	assert.equal(w.sites.mine.search.kind, "bing-site");
	const seeded = db.prepare("SELECT value FROM settings WHERE key='seeded_from'").get();
	assert.equal(seeded.value, legacy, "records where the seed came from");
	db.close();
}

// --- 3) 搜索落库 ---
{
	const db = openWebSearchDb(join(dir, "records.db"));
	const pkg = {
		query: "sqlite-vec",
		engine: "bing",
		fetchedAt: "2026-10-12T00:00:00.000Z",
		results: [
			{
				rank: 1,
				title: "A",
				url: "https://docs.rs/x",
				weight: 0.95,
				weightSource: "docs.rs",
				via: "bing",
				snippet: "s",
				content: { ok: true, title: "t", coreText: "SQLite 向量扩展正文", chars: 10, error: null },
				confidence: 0.72,
				relevance: 0.8,
				support: 2,
			},
		],
		dropped: [{ title: "J", url: "https://qcc.com/x", weight: 0.5, reason: "黑名单域名: qcc.com" }],
		meta: { count: 5, offset: 0, includeContent: true, contentTop: 1, contentChars: 500, minWeight: null, fetchedPages: 1, failedPages: 0, sites: ["github"] },
	};
	const id = recordSearch(db, pkg, { query: "sqlite-vec", sites: ["github"] });
	assert.ok(id > 0);
	const st = dbStats(db);
	assert.equal(st.searches, 1);
	assert.equal(st.results, 1 + 1, "结果 + 被丢弃项都落库");
	const row = db.prepare("SELECT sites, params FROM searches WHERE id=?").get(id);
	assert.equal(row.sites, '["github"]');
	const dropped = db.prepare("SELECT drop_reason FROM results WHERE dropped=1").get();
	assert.equal(dropped.drop_reason, "黑名单域名: qcc.com");
	const kept = db.prepare("SELECT core_text, content_ok, confidence, relevance, support FROM results WHERE dropped=0").get();
	assert.equal(kept.content_ok, 1);
	assert.equal(kept.core_text, "SQLite 向量扩展正文");
	assert.equal(kept.confidence, 0.72, "置信度落库");
	assert.equal(kept.relevance, 0.8);
	assert.equal(kept.support, 2);
	db.close();
}

// --- 4) 抓取缓存 + TTL + FTS ---
{
	const db = openWebSearchDb(join(dir, "cache.db"));
	assert.equal(getCachedPage(db, "https://x.example/a", 60_000), null, "miss before insert");
	putCachedPage(db, { url: "https://x.example/a", title: "向量检索指南", coreText: "sqlite-vec 是 SQLite 的向量扩展，支持 KNN 查询。", contentType: "text/html" });
	const hit = getCachedPage(db, "https://x.example/a", 60_000);
	assert.equal(hit.title, "向量检索指南");
	assert.equal(getCachedPage(db, "https://x.example/a", -1), null, "negative TTL → expired");
	// FTS：中文 ≥3 字走 FTS5 trigram，英文同样可搜
	assert.equal(searchPages(db, "向量扩展").length, 1, "FTS 中文匹配");
	assert.equal(searchPages(db, "sqlite").length, 1, "FTS 英文匹配");
	// 2 字查询退回 LIKE
	assert.equal(searchPages(db, "向量").length, 1, "LIKE fallback for short CJK query");
	// 覆盖写：并发/重复抓取不应产生重复行
	putCachedPage(db, { url: "https://x.example/a", title: "向量检索指南 v2", coreText: "更新后的正文：向量扩展。", contentType: "text/html" });
	assert.equal(dbStats(db).pages, 1, "upsert keeps a single row");
	assert.equal(getCachedPage(db, "https://x.example/a", 60_000).title, "向量检索指南 v2");
	// 更新后 FTS 不应残留旧内容
	assert.equal(searchPages(db, "KNN").length, 0, "stale FTS row removed on update");
	assert.equal(searchPages(db, "向量扩展").length, 1, "new content still searchable");
	assert.equal(searchPages(db, "不存在的词").length, 0);
	db.close();
}

// --- 5) sqlite-vec：多嵌入器向量表 / KNN / 多源印证 / 降级 ---
{
	const VEC = new URL("../vendor/vec0.sqlite", import.meta.url).pathname;
	const EMB = "hash-256";
	const db = openWebSearchDb(join(dir, "vec.db"), undefined, VEC);
	assert.equal(hasVecSupport(db), true, "sqlite-vec 已加载");
	assert.equal(db.prepare("SELECT vec_version() v").get().v, "v0.1.9", "sqlite-vec v0.1.9");

	const add = (url, title, core) =>
		putCachedPage(db, { url, title, coreText: core, contentType: "text/html", embedderId: EMB, embedding: embedText(`${title}\n${core}`) });
	add("https://a.example/1", "sqlite-vec 向量扩展指南", "sqlite-vec 是 SQLite 的向量扩展，支持 KNN 近邻查询与 cosine 距离。");
	add("https://b.example/2", "SQLite 向量检索实践", "用 sqlite-vec 在 SQLite 里做向量检索：KNN 查询、cosine 距离、向量扩展安装。");
	add("https://c.example/3", "钓鱼入门", "今天天气不错，讲讲钓鱼的装备与技巧，适合新手的散步式野钓。");

	assert.equal(dbStats(db).vectors, 3, "三页都写了向量");
	assert.equal(vecCount(db, EMB), 3);

	// 近邻：相似页应显著近于无关页
	const aVec = embedText("sqlite-vec 向量扩展指南\nsqlite-vec 是 SQLite 的向量扩展，支持 KNN 近邻查询与 cosine 距离。");
	const nbrs = neighborsOf(db, EMB, aVec, "https://a.example/1", 3);
	const b = nbrs.find((n) => n.url === "https://b.example/2");
	const c = nbrs.find((n) => n.url === "https://c.example/3");
	console.log(`向量近邻: cosine(a,b)=${b.cosine.toFixed(3)}  cosine(a,c)=${c ? c.cosine.toFixed(3) : "n/a"}`);
	assert.ok(b && b.cosine > 0.3, "同主题页余弦应较高");
	assert.ok(!c || c.cosine < 0.2, "无关页余弦应较低");
	assert.ok(!nbrs.some((n) => n.url === "https://a.example/1"), "近邻不含自身");

	// KNN 直接查询
	const hits = knnPages(db, EMB, embedText("SQLite 向量扩展 KNN"), 2);
	assert.equal(hits.length, 2);
	assert.ok(hits[0].url.includes("a.example") || hits[0].url.includes("b.example"), "最相关的是向量主题页");

	// 不同嵌入器 → 独立向量表，互不干扰
	const add2 = (url) => putCachedPage(db, { url, title: "另一嵌入器", coreText: "不同嵌入器的向量放另一张表。", contentType: "text/html", embedderId: "hash-999", embedding: new Float32Array(999).fill(0.1) });
	add2("https://d.example/4");
	assert.equal(vecCount(db, "hash-999"), 1, "第二个嵌入器独立成表");
	assert.equal(vecCount(db, EMB), 3, "原表不受影响");
	assert.equal(dbStats(db).vectors, 4, "统计跨表累加");
	db.close();

	// 不传扩展路径 → 自动降级，仅 FTS
	const db2 = openWebSearchDb(join(dir, "novec.db"));
	assert.equal(hasVecSupport(db2), false, "无扩展时降级");
	putCachedPage(db2, { url: "https://x.example/1", title: "无向量", coreText: "降级模式下仍可写缓存与 FTS。", contentType: "text/html" });
	assert.equal(searchPages(db2, "降级模式").length, 1, "FTS 仍可用");
	assert.deepEqual(neighborsOf(db2, EMB, embedText("x"), "https://x.example/1", 3), [], "无向量时近邻为空");
	assert.equal(dbStats(db2).vectors, 0);
	db2.close();
}

// --- 6) 本地 ONNX 嵌入（bge-small-zh-v1.5 int8） ---
{
	const VENDOR = new URL("../vendor", import.meta.url).pathname;
	const emb = await createOnnxEmbedder(VENDOR);
	assert.ok(emb, "ONNX 嵌入器加载成功");
	assert.equal(emb.dim, 512, "512 维");
	const t0 = Date.now();
	const [q, relZh, relEn, offOther] = await Promise.all([
		emb.embed("sqlite-vec 向量扩展怎么用"),
		emb.embed("sqlite-vec 是 SQLite 的向量检索扩展，支持 KNN 与余弦距离。"),
		emb.embed("sqlite-vec is a vector search extension for SQLite with KNN support."),
		emb.embed("今天天气不错，适合出门散步和钓鱼。"),
	]);
	console.log(`ONNX 嵌入 4 条 ${Date.now() - t0}ms | 余弦: 相关中文 ${cosineSim(q, relZh).toFixed(3)} 相关英文 ${cosineSim(q, relEn).toFixed(3)} 无关 ${cosineSim(q, offOther).toFixed(3)}`);
	assert.ok(cosineSim(q, relZh) > 0.6, "相关中文应高相似");
	assert.ok(cosineSim(q, relZh) > cosineSim(q, offOther) + 0.2, "相关显著高于无关");
	assert.ok(cosineSim(q, relEn) > 0.4, "跨语言也有语义相似（bge 多语言能力）");
	assert.ok(emb.supportThreshold >= 0.5 && emb.supportThreshold <= 0.8, "印证阈值在合理区间");
	// 向量已归一化
	let n = 0;
	for (const x of relZh) n += x * x;
	assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-3, "L2 归一化");

	// 缺件时返回 null（降级路径）
	assert.equal(await createOnnxEmbedder(join(dir, "nope")), null, "vendor 缺件返回 null");
}

console.log("ALL DB TESTS PASSED");
