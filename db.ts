/**
 * SQLite storage layer for the web-search extension (Node 内置 node:sqlite，零依赖)。
 *
 * 表结构：
 *   settings          键值（defaultWeight 等）
 *   sources           信源权重库 (host → weight)
 *   blocked_domains   域名黑名单
 *   blocked_patterns  屏蔽词黑名单
 *   sites             常用站点注册表（别名/标签/适配器）
 *   searches          搜索历史（query/engine/sites/时间/参数）
 *   results           每次搜索的结果明细（含核心文本）
 *   pages             抓取缓存（url → 正文），带 fetched_at 供 TTL 判断
 *   pages_vec         pages 的 sqlite-vec 向量索引（vec0，float[256]）
 *   pages_fts         pages 的 FTS5 全文索引（trigram，支持中文）
 *
 * 首次初始化：优先从旧版 web-sources.json 导入，否则写内置种子。
 */

import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
	distanceToCosine,
	DEFAULT_SOURCE_WEIGHTS,
	parseSourceWeights,
	type SearchPackage,
	type SiteRegistry,
	type SourceWeights,
} from "./core.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (host TEXT PRIMARY KEY, weight REAL NOT NULL);
CREATE TABLE IF NOT EXISTS blocked_domains (host TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS blocked_patterns (pattern TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sites (
  alias TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL,
  site TEXT
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  engine TEXT NOT NULL,
  sites TEXT,
  fetched_at TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL REFERENCES searches(id),
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  weight REAL NOT NULL,
  weight_source TEXT,
  via TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  core_text TEXT,
  content_ok INTEGER,
  content_error TEXT,
  confidence REAL,
  relevance REAL,
  support INTEGER,
  dropped INTEGER NOT NULL DEFAULT 0,
  drop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_results_search ON results(search_id);
CREATE INDEX IF NOT EXISTS idx_results_url ON results(url);
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  core_text TEXT NOT NULL DEFAULT '',
  content_type TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, core_text, url UNINDEXED, tokenize='trigram');
`;

export interface CachedPage {
	url: string;
	title: string;
	coreText: string;
	contentType: string | null;
	fetchedAt: number;
}

export interface DbStats {
	sources: number;
	blockedDomains: number;
	blockedPatterns: number;
	sites: number;
	searches: number;
	results: number;
	pages: number;
	vectors: number;
	vecEnabled: boolean;
}

/**
 * 打开（必要时初始化）数据库。dbPath 不存在时会建库并播种：
 * 有旧版 weights JSON 就从它导入，否则用内置种子。
 * vecExtensionPath 存在且可加载时启用 sqlite-vec（向量索引/置信度），否则自动降级为仅 FTS。
 */
export function openWebSearchDb(
	dbPath: string,
	legacyJsonPath?: string,
	vecExtensionPath?: string,
): DatabaseSync {
	const db = new DatabaseSync(dbPath, { allowExtension: true });
	db.exec("PRAGMA journal_mode = WAL");
	migrateSchema(db);
	db.exec(SCHEMA);
	const count = db.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number };
	if (count.n === 0) seedDb(db, legacyJsonPath);
	loadVecExtension(db, vecExtensionPath);
	return db;
}

/** 给已存在的旧库补新列（CREATE TABLE IF NOT EXISTS 不会改已有表）。 */
function migrateSchema(db: DatabaseSync): void {
	const cols = db.prepare("PRAGMA table_info(results)").all() as Array<{ name: string }>;
	const has = (c: string): boolean => cols.some((x) => x.name === c);
	if (cols.length > 0 && !has("confidence")) {
		db.exec("ALTER TABLE results ADD COLUMN confidence REAL");
		db.exec("ALTER TABLE results ADD COLUMN relevance REAL");
		db.exec("ALTER TABLE results ADD COLUMN support INTEGER");
	}
}

/** 尝试加载 sqlite-vec；失败则静默降级（FTS 仍可用）。 */
function loadVecExtension(db: DatabaseSync, vecExtensionPath?: string): void {
	if (!vecExtensionPath || !existsSync(vecExtensionPath)) return;
	try {
		db.loadExtension(vecExtensionPath);
	} catch {
		// 扩展不可用：只影响向量相关能力
	}
}

/** 向量表名（每个嵌入器一张，维度不同互不干扰）。 */
export function vecTableName(embedderId: string): string {
	return `pages_vec_${embedderId.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
}

/** 确保某嵌入器的向量表存在（首次使用时按维度建表）。 */
export function ensureVecTable(db: DatabaseSync, embedderId: string, dim: number): boolean {
	if (!hasVecSupport(db)) return false;
	try {
		db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(embedderId)} USING vec0(url TEXT PRIMARY KEY, embedding float[${dim}])`,
		);
		return true;
	} catch {
		return false;
	}
}

/** 向量能力是否可用（sqlite-vec 已加载）。 */
export function hasVecSupport(db: DatabaseSync): boolean {
	try {
		db.prepare("SELECT vec_version()").get();
		return true;
	} catch {
		return false;
	}
}

function seedDb(db: DatabaseSync, legacyJsonPath?: string): void {
	let weights: SourceWeights = DEFAULT_SOURCE_WEIGHTS;
	let importedFrom = "builtin-defaults";
	if (legacyJsonPath && existsSync(legacyJsonPath)) {
		try {
			weights = parseSourceWeights(JSON.parse(readFileSync(legacyJsonPath, "utf-8")));
			importedFrom = legacyJsonPath;
		} catch {
			// 旧文件损坏：退回内置种子
		}
	}
	db.exec("BEGIN");
	try {
		const setSetting = db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
		setSetting.run("defaultWeight", String(weights.defaultWeight));
		setSetting.run("seeded_from", importedFrom);
		const insSrc = db.prepare("INSERT OR REPLACE INTO sources(host, weight) VALUES (?, ?)");
		for (const [host, w] of Object.entries(weights.domains)) insSrc.run(host, w);
		const insBd = db.prepare("INSERT OR REPLACE INTO blocked_domains(host) VALUES (?)");
		for (const h of weights.blockedDomains) insBd.run(h);
		const insBp = db.prepare("INSERT OR REPLACE INTO blocked_patterns(pattern) VALUES (?)");
		for (const p of weights.blockedPatterns) insBp.run(p);
		const insSite = db.prepare("INSERT OR REPLACE INTO sites(alias, domain, tags, kind, site) VALUES (?, ?, ?, ?, ?)");
		for (const [alias, e] of Object.entries(weights.sites)) {
			insSite.run(alias, e.domain, JSON.stringify(e.tags), e.search.kind, e.search.site ?? null);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** 从库里读出权重库/黑名单/站点表（与 web-sources.json 同构）。 */
export function loadWeights(db: DatabaseSync): SourceWeights {
	const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
	const domains: Record<string, number> = {};
	for (const r of rows<{ host: string; weight: number }>("SELECT host, weight FROM sources")) {
		domains[r.host] = r.weight;
	}
	const sites: SiteRegistry = {};
	for (const r of rows<{ alias: string; domain: string; tags: string; kind: string; site: string | null }>(
		"SELECT alias, domain, tags, kind, site FROM sites",
	)) {
		let tags: string[] = [];
		try {
			tags = JSON.parse(r.tags) as string[];
		} catch {
			tags = [];
		}
		sites[r.alias] = {
			domain: r.domain,
			tags,
			search: r.site ? { kind: r.kind as never, site: r.site } : { kind: r.kind as never },
		};
	}
	const setting = db.prepare("SELECT value FROM settings WHERE key = 'defaultWeight'").get() as
		| { value: string }
		| undefined;
	return {
		defaultWeight: Number(setting?.value ?? DEFAULT_SOURCE_WEIGHTS.defaultWeight),
		domains,
		blockedDomains: rows<{ host: string }>("SELECT host FROM blocked_domains").map((r) => r.host),
		blockedPatterns: rows<{ pattern: string }>("SELECT pattern FROM blocked_patterns").map((r) => r.pattern),
		sites,
	};
}

/** 落库一次搜索（searches + results，含被丢弃项）。 */
export function recordSearch(db: DatabaseSync, pkg: SearchPackage, params: Record<string, unknown>): number {
	db.exec("BEGIN");
	try {
		const info = db
			.prepare("INSERT INTO searches(query, engine, sites, fetched_at, params) VALUES (?, ?, ?, ?, ?)")
			.run(
				pkg.query,
				pkg.engine,
				pkg.meta.sites ? JSON.stringify(pkg.meta.sites) : null,
				pkg.fetchedAt,
				JSON.stringify(params),
			);
		const searchId = Number(info.lastInsertRowid);
		const ins = db.prepare(
			`INSERT INTO results(search_id, rank, title, url, weight, weight_source, via, snippet, core_text, content_ok, content_error, confidence, relevance, support, dropped, drop_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const r of pkg.results) {
			ins.run(
				searchId,
				r.rank,
				r.title,
				r.url,
				r.weight,
				r.weightSource,
				r.via,
				r.snippet,
				r.content?.coreText ?? null,
				r.content ? (r.content.ok ? 1 : 0) : null,
				r.content?.error ?? null,
				r.confidence,
				r.relevance,
				r.support,
				0,
				null,
			);
		}
		for (const d of pkg.dropped) {
			ins.run(searchId, 0, d.title, d.url, d.weight, null, "dropped", "", null, null, null, null, null, null, 1, d.reason);
		}
		db.exec("COMMIT");
		return searchId;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** 读抓取缓存；超过 maxAgeMs 视为过期返回 null。 */
export function getCachedPage(db: DatabaseSync, url: string, maxAgeMs: number): CachedPage | null {
	const row = db
		.prepare("SELECT url, title, core_text, content_type, fetched_at FROM pages WHERE url = ?")
		.get(url) as
		| { url: string; title: string; core_text: string; content_type: string | null; fetched_at: number }
		| undefined;
	if (!row) return null;
	if (Date.now() - row.fetched_at > maxAgeMs) return null;
	return {
		url: row.url,
		title: row.title,
		coreText: row.core_text,
		contentType: row.content_type,
		fetchedAt: row.fetched_at,
	};
}

/** 写抓取缓存 + 更新 FTS 索引（带 embedding 时同时写该嵌入器的向量表）。 */
export function putCachedPage(
	db: DatabaseSync,
	page: {
		url: string;
		title: string;
		coreText: string;
		contentType: string | null;
		embedderId?: string;
		embedding?: Float32Array | null;
	},
): void {
	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO pages(url, title, core_text, content_type, fetched_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(url) DO UPDATE SET title=excluded.title, core_text=excluded.core_text,
			   content_type=excluded.content_type, fetched_at=excluded.fetched_at`,
		).run(page.url, page.title, page.coreText, page.contentType, Date.now());
		const row = db.prepare("SELECT rowid FROM pages WHERE url = ?").get(page.url) as { rowid: number };
		db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(row.rowid);
		db.prepare("INSERT INTO pages_fts(rowid, title, core_text, url) VALUES (?, ?, ?, ?)").run(
			row.rowid,
			page.title,
			page.coreText,
			page.url,
		);
		if (page.embedding && page.embedderId && ensureVecTable(db, page.embedderId, page.embedding.length)) {
			const table = vecTableName(page.embedderId);
			db.prepare(`DELETE FROM ${table} WHERE url = ?`).run(page.url);
			db.prepare(`INSERT INTO ${table}(url, embedding) VALUES (?, ?)`).run(page.url, vecToBlob(page.embedding));
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function vecToBlob(v: Float32Array): Uint8Array {
	return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export interface VecNeighbor {
	url: string;
	distance: number;
	cosine: number;
}

/** 向量近邻检索（sqlite-vec KNN，指定嵌入器的向量表）。 */
export function knnPages(db: DatabaseSync, embedderId: string, queryVec: Float32Array, k: number): VecNeighbor[] {
	if (!hasVecSupport(db)) return [];
	try {
		const rows = db
			.prepare(`SELECT url, distance FROM ${vecTableName(embedderId)} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
			.all(vecToBlob(queryVec), k) as Array<{ url: string; distance: number }>;
		return rows.map((r) => {
			const distance = Number(r.distance);
			return { url: r.url, distance, cosine: distanceToCosine(distance) };
		});
	} catch {
		return []; // 该嵌入器还没建表
	}
}

/** 找与给定页面向量相近的其他页面（用于「多源印证」计数），排除自身 URL。 */
export function neighborsOf(
	db: DatabaseSync,
	embedderId: string,
	pageVec: Float32Array,
	selfUrl: string,
	k: number,
): VecNeighbor[] {
	return knnPages(db, embedderId, pageVec, k + 1).filter((n) => n.url !== selfUrl);
}

export function vecCount(db: DatabaseSync, embedderId: string): number {
	if (!hasVecSupport(db)) return 0;
	try {
		return (db.prepare(`SELECT COUNT(*) AS n FROM ${vecTableName(embedderId)}`).get() as { n: number }).n;
	} catch {
		return 0;
	}
}

export function dbStats(db: DatabaseSync): DbStats {
	const n = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	const vecTables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pages_vec_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
		)
		.all() as Array<{ name: string }>;
	let vectors = 0;
	for (const t of vecTables) {
		try {
			vectors += (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n;
		} catch {
			// 忽略无法读取的向量表
		}
	}
	return {
		sources: n("sources"),
		blockedDomains: n("blocked_domains"),
		blockedPatterns: n("blocked_patterns"),
		sites: n("sites"),
		searches: n("searches"),
		results: n("results"),
		pages: n("pages"),
		vectors,
		vecEnabled: hasVecSupport(db),
	};
}

/**
 * 在已抓取内容里做本地全文检索（FTS5 trigram；查询词 <3 字符时退回 LIKE）。
 */
export function searchPages(db: DatabaseSync, query: string, limit = 10): CachedPage[] {
	const q = query.trim();
	if (!q) return [];
	type Row = { url: string; title: string; core_text: string; content_type: string | null; fetched_at: number };
	let rows: Row[];
	if ([...q].length >= 3 && !/[\s"]/.test(q)) {
		rows = db
			.prepare(
				`SELECT p.url, p.title, p.core_text, p.content_type, p.fetched_at
				 FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
				 WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(q, limit) as Row[];
	} else {
		const like = `%${q}%`;
		rows = db
			.prepare(
				`SELECT url, title, core_text, content_type, fetched_at FROM pages
				 WHERE title LIKE ? OR core_text LIKE ? ORDER BY fetched_at DESC LIMIT ?`,
			)
			.all(like, like, limit) as Row[];
	}
	return rows.map((r) => ({
		url: r.url,
		title: r.title,
		coreText: r.core_text,
		contentType: r.content_type,
		fetchedAt: r.fetched_at,
	}));
}
