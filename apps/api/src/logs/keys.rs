use crate::{
    error::{ApiError, ApiResult},
    store,
};
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn migrate(db: &rusqlite::Connection) -> anyhow::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS log_settings(product_id TEXT PRIMARY KEY REFERENCES products(id), retention_days INTEGER NOT NULL DEFAULT 7);
      CREATE TABLE IF NOT EXISTS log_keys(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), source_id TEXT NOT NULL REFERENCES sources(id), label TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);")?;
    Ok(())
}
pub fn retention(db: &rusqlite::Connection, id: &str) -> ApiResult<i64> {
    store::product(db, id)?;
    Ok(db
        .query_row(
            "SELECT retention_days FROM log_settings WHERE product_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(anyhow::Error::from)?
        .unwrap_or(7))
}
pub fn set_retention(db: &rusqlite::Connection, id: &str, days: i64) -> ApiResult<Value> {
    store::product(db, id)?;
    if !(1..=365).contains(&days) {
        return Err(ApiError::bad("Log retention must be 1–365 days"));
    }
    db.execute("INSERT INTO log_settings(product_id,retention_days) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET retention_days=excluded.retention_days", params![id, days]).map_err(anyhow::Error::from)?;
    Ok(json!({"retention_days":days}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyInput {
    pub label: String,
    pub source_id: Option<String>,
}
pub fn create(db: &rusqlite::Connection, id: &str, input: KeyInput) -> ApiResult<Value> {
    let product = store::product(db, id)?;
    let source = crate::sources::key_source(&product, input.source_id.as_deref())?
        .id
        .as_str();
    if input.label.trim().is_empty() || input.label.len() > 80 {
        return Err(ApiError::bad("Key label must be 1–80 bytes"));
    }
    let key = store::secret("pl_");
    let key_id = uuid::Uuid::now_v7().to_string();
    db.execute("INSERT INTO log_keys(id,product_id,source_id,label,prefix,hash,created_at) VALUES (?,?,?,?,?,?,?)", params![key_id,id,source,input.label.trim(),&key[..11],store::hash(&key),chrono::Utc::now().to_rfc3339()]).map_err(anyhow::Error::from)?;
    Ok(json!({"id":key_id,"key":key,"source_id":source}))
}
pub fn list(db: &rusqlite::Connection, id: &str) -> ApiResult<Vec<Value>> {
    store::product(db, id)?;
    let mut q = db.prepare("SELECT id,source_id,label,prefix,created_at,revoked FROM log_keys WHERE product_id=? ORDER BY created_at,id").map_err(anyhow::Error::from)?;
    q.query_map([id], |r| Ok(json!({"id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"label":r.get::<_,String>(2)?,"prefix":r.get::<_,String>(3)?,"created_at":r.get::<_,String>(4)?,"revoked":r.get::<_,bool>(5)?}))).map_err(anyhow::Error::from)?.collect::<rusqlite::Result<_>>().map_err(|e| anyhow::Error::from(e).into())
}
pub fn revoke(db: &rusqlite::Connection, id: &str, key: &str) -> ApiResult<()> {
    store::product(db, id)?;
    if db
        .execute(
            "UPDATE log_keys SET revoked=1 WHERE id=? AND product_id=?",
            params![key, id],
        )
        .map_err(anyhow::Error::from)?
        == 0
    {
        return Err(ApiError::missing());
    }
    Ok(())
}
pub fn resolve(db: &rusqlite::Connection, key: &str) -> ApiResult<(String, String, i64)> {
    let (id, source): (String, String) = db
        .query_row(
            "SELECT product_id,source_id FROM log_keys WHERE hash=? AND revoked=0",
            [store::hash(key)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(anyhow::Error::from)?
        .ok_or_else(ApiError::unauthorized)?;
    crate::sources::get(db, &id, &source)?;
    let days = retention(db, &id)?;
    Ok((id, source, days))
}
