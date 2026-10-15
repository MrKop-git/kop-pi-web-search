//! SQLite storage: weights/blacklist/sites, search history, fetch cache and
//! sqlite-vec vector tables. Mirrors the schema used by the TypeScript build so
//! an existing database keeps working.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::weights::{SiteEntry, SiteSearchSpec, SourceWeights};

/// sqlite-vec 是静态编译进来的 C 扩展，打开任何连接前注册一次
/// （进程内重复调用安全，`sqlite3_auto_extension` 会去重）。
pub fn register_vec_extension() {
    use rusqlite::ffi::sqlite3_auto_extension;
    unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

const SCHEMA: &str = r#"
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
"#;

pub struct Store {
    pub conn: Connection,
    vec_enabled: bool,
}

impl Store {
    /// 打开（必要时建库 + 播种）。`legacy_json` 存在时优先从旧版 JSON 导入。
    pub fn open(path: &Path, legacy_json: Option<&Path>) -> Result<Self> {
        register_vec_extension();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("打开数据库失败: {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(SCHEMA)?;

        let vec_enabled = conn.query_row("select vec_version()", [], |r| r.get::<_, String>(0)).is_ok();

        let count: i64 = conn.query_row("select count(*) from sites", [], |r| r.get(0))?;
        if count == 0 {
            let weights = load_or_default(legacy_json);
            seed(&conn, &weights)?;
        }
        // 新版本新增的内置信源也要进老库（旧版 web-sources.json 里没有这些）
        seed_new_defaults(&conn)?;
        Ok(Self { conn, vec_enabled })
    }

    pub fn vec_enabled(&self) -> bool {
        self.vec_enabled
    }

    /// 最近返回过的结果 URL（跨调用防重叠用）。`fetched_at` 形如 "@1700000000"。
    pub fn recent_urls(&self, since_epoch: i64) -> Result<HashSet<String>> {
        let mut urls = HashSet::new();
        let mut stmt = self.conn.prepare(
            "select r.url from results r join searches s on s.id = r.search_id \
             where r.dropped = 0 and cast(substr(s.fetched_at, 2) as integer) >= ?",
        )?;
        for row in stmt.query_map([since_epoch], |row| row.get::<_, String>(0))? {
            urls.insert(row?);
        }
        Ok(urls)
    }

    pub fn load_weights(&self) -> Result<SourceWeights> {
        let mut w = SourceWeights {
            default_weight: 0.5,
            domains: HashMap::new(),
            blocked_domains: Vec::new(),
            blocked_patterns: Vec::new(),
            sites: HashMap::new(),
        };
        if let Some(v) = self
            .conn
            .query_row("select value from settings where key='defaultWeight'", [], |r| r.get::<_, String>(0))
            .optional()?
        {
            w.default_weight = v.parse().unwrap_or(0.5);
        }
        let mut stmt = self.conn.prepare("select host, weight from sources")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)? as f32)))? {
            let (host, weight) = row?;
            w.domains.insert(host, weight);
        }
        let mut stmt = self.conn.prepare("select host from blocked_domains")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            w.blocked_domains.push(row?);
        }
        let mut stmt = self.conn.prepare("select pattern from blocked_patterns")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            w.blocked_patterns.push(row?);
        }
        let mut stmt = self.conn.prepare("select alias, domain, tags, kind, site from sites")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        for row in rows {
            let (alias, domain, tags, kind, site) = row?;
            let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
            w.sites.insert(
                alias,
                SiteEntry { domain, tags, search: SiteSearchSpec { kind, site } },
            );
        }
        Ok(w)
    }

    /// 落库一次搜索（结果 + 被丢弃项）
    pub fn record_search(&self, pkg: &crate::protocol::SearchPackage, params_json: &str) -> Result<i64> {
        self.conn.execute(
            "insert into searches(query, engine, sites, fetched_at, params) values (?, ?, ?, ?, ?)",
            params![
                pkg.query,
                pkg.engine,
                pkg.meta.sites.as_ref().map(|s| serde_json::to_string(s).unwrap_or_default()),
                pkg.fetched_at,
                params_json
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let mut stmt = self.conn.prepare(
            "insert into results(search_id, rank, title, url, weight, weight_source, via, snippet, core_text,
             content_ok, content_error, confidence, relevance, support, dropped, drop_reason)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;
        for r in &pkg.results {
            let content = r.content.as_ref();
            stmt.execute(params![
                id,
                r.rank as i64,
                r.title,
                r.url,
                r.weight as f64,
                r.weight_source,
                r.via,
                r.snippet,
                content.map(|c| c.core_text.clone()),
                content.map(|c| if c.ok { 1i64 } else { 0i64 }),
                content.and_then(|c| c.error.clone()),
                r.confidence.map(|v| v as f64),
                r.relevance.map(|v| v as f64),
                r.support.map(|v| v as i64),
                0i64,
                Option::<String>::None,
            ])?;
        }
        for d in &pkg.dropped {
            stmt.execute(params![
                id, 0i64, d.title, d.url, d.weight as f64, Option::<String>::None, "dropped", "", Option::<String>::None,
                Option::<i64>::None, Option::<String>::None, Option::<f64>::None, Option::<f64>::None, Option::<i64>::None,
                1i64, d.reason,
            ])?;
        }
        Ok(id)
    }

    pub fn cached_page(&self, url: &str, max_age_ms: i64) -> Result<Option<CachedPage>> {
        let row = self
            .conn
            .query_row(
                "select url, title, core_text, content_type, fetched_at from pages where url = ?",
                [url],
                |r| {
                    Ok(CachedPage {
                        url: r.get(0)?,
                        title: r.get(1)?,
                        core_text: r.get(2)?,
                        content_type: r.get(3)?,
                        fetched_at: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row.filter(|p| now_ms() - p.fetched_at <= max_age_ms))
    }

    pub fn put_cached_page(&self, page: &CachedPage, embedding: Option<&[f32]>, embedder_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "insert into pages(url, title, core_text, content_type, fetched_at) values (?, ?, ?, ?, ?)
             on conflict(url) do update set title=excluded.title, core_text=excluded.core_text,
               content_type=excluded.content_type, fetched_at=excluded.fetched_at",
            params![page.url, page.title, page.core_text, page.content_type, now_ms()],
        )?;
        let rowid: i64 = self.conn.query_row("select rowid from pages where url = ?", [&page.url], |r| r.get(0))?;
        self.conn.execute("delete from pages_fts where rowid = ?", [rowid])?;
        self.conn.execute(
            "insert into pages_fts(rowid, title, core_text, url) values (?, ?, ?, ?)",
            params![rowid, page.title, page.core_text, page.url],
        )?;
        if let (Some(vec), Some(id)) = (embedding, embedder_id) {
            if self.ensure_vec_table(id, vec.len())? {
                let table = vec_table_name(id);
                self.conn.execute(&format!("delete from {table} where url = ?"), [&page.url])?;
                self.conn.execute(
                    &format!("insert into {table}(url, embedding) values (?, ?)"),
                    params![page.url, vec_to_blob(vec)],
                )?;
            }
        }
        Ok(())
    }

    pub fn ensure_vec_table(&self, embedder_id: &str, dim: usize) -> Result<bool> {
        if !self.vec_enabled {
            return Ok(false);
        }
        let sql = format!(
            "create virtual table if not exists {} using vec0(url text primary key, embedding float[{dim}])",
            vec_table_name(embedder_id)
        );
        Ok(self.conn.execute_batch(&sql).is_ok())
    }

    pub fn stats(&self) -> Result<serde_json::Value> {
        let n = |t: &str| -> i64 { self.conn.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0)).unwrap_or(0) };
        Ok(serde_json::json!({
            "sources": n("sources"),
            "blockedDomains": n("blocked_domains"),
            "blockedPatterns": n("blocked_patterns"),
            "sites": n("sites"),
            "searches": n("searches"),
            "results": n("results"),
            "pages": n("pages"),
            "vecEnabled": self.vec_enabled,
        }))
    }
}

#[derive(Debug, Clone)]
pub struct CachedPage {
    pub url: String,
    pub title: String,
    pub core_text: String,
    pub content_type: Option<String>,
    pub fetched_at: i64,
}

pub fn vec_table_name(embedder_id: &str) -> String {
    let sanitized: String = embedder_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("pages_vec_{sanitized}")
}

pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_or_default(legacy_json: Option<&Path>) -> SourceWeights {
    if let Some(path) = legacy_json {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                return parse_weights_json(&value).unwrap_or_default();
            }
        }
    }
    SourceWeights::default()
}

/// 解析旧版 web-sources.json（字段缺失时回落到内置种子）
pub fn parse_weights_json(value: &serde_json::Value) -> Option<SourceWeights> {
    let obj = value.as_object()?;
    let mut w = SourceWeights::default();
    if let Some(d) = obj.get("defaultWeight").and_then(|v| v.as_f64()) {
        w.default_weight = d as f32;
    }
    if let Some(domains) = obj.get("domains").and_then(|v| v.as_object()) {
        w.domains.clear();
        for (k, v) in domains {
            if let Some(f) = v.as_f64() {
                w.domains.insert(k.to_ascii_lowercase(), f as f32);
            }
        }
    }
    if let Some(list) = obj.get("blockedDomains").and_then(|v| v.as_array()) {
        w.blocked_domains = list.iter().filter_map(|v| v.as_str()).map(|s| s.to_ascii_lowercase()).collect();
    }
    if let Some(list) = obj.get("blockedPatterns").and_then(|v| v.as_array()) {
        w.blocked_patterns = list.iter().filter_map(|v| v.as_str()).map(str::to_string).collect();
    }
    if let Some(sites) = obj.get("sites").and_then(|v| v.as_object()) {
        for (alias, raw) in sites {
            let Some(entry) = raw.as_object() else { continue };
            let Some(domain) = entry.get("domain").and_then(|v| v.as_str()) else { continue };
            let tags = entry
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
                .unwrap_or_default();
            let spec = entry.get("search").and_then(|v| v.as_object());
            let kind = spec.and_then(|s| s.get("kind")).and_then(|v| v.as_str()).unwrap_or("bing-site").to_string();
            let site = spec.and_then(|s| s.get("site")).and_then(|v| v.as_str()).map(str::to_string);
            w.sites.insert(alias.to_ascii_lowercase(), SiteEntry { domain: domain.to_ascii_lowercase(), tags, search: SiteSearchSpec { kind, site } });
        }
    }
    Some(w)
}

fn seed(conn: &Connection, w: &SourceWeights) -> Result<()> {
    conn.execute("insert or ignore into settings(key, value) values ('defaultWeight', ?)", [w.default_weight.to_string()])?;
    for (host, weight) in &w.domains {
        conn.execute("insert or ignore into sources(host, weight) values (?, ?)", params![host, *weight as f64])?;
    }
    for host in &w.blocked_domains {
        conn.execute("insert or ignore into blocked_domains(host) values (?)", [host])?;
    }
    for pattern in &w.blocked_patterns {
        conn.execute("insert or ignore into blocked_patterns(pattern) values (?)", [pattern])?;
    }
    for (alias, entry) in &w.sites {
        conn.execute(
            "insert or ignore into sites(alias, domain, tags, kind, site) values (?, ?, ?, ?, ?)",
            params![alias, entry.domain, serde_json::to_string(&entry.tags)?, entry.search.kind, entry.search.site],
        )?;
    }
    Ok(())
}

/// 内置种子版本：新增内置信源时 +1，老库在打开时补齐缺失的行（已有行不动）
const SEED_VERSION: i64 = 4;

fn seed_new_defaults(conn: &Connection) -> Result<()> {
    let current: i64 = conn
        .query_row("select value from settings where key='seedVersion'", [], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if current >= SEED_VERSION {
        return Ok(());
    }
    seed(conn, &SourceWeights::default())?;
    conn.execute("insert or replace into settings(key, value) values ('seedVersion', ?)", [SEED_VERSION.to_string()])?;
    Ok(())
}
