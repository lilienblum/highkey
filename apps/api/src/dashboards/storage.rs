//! Dashboard documents and their revisions, in SQLite.
//!
//! Every write validates the document, runs in one immediate transaction (so concurrent
//! writers queue instead of deadlocking on a lock upgrade), bumps `revision` with a
//! compare-and-set, and records a revision row.
use super::{
    error::DashboardError,
    spec::Document,
    validate::{Limits, check_document},
};
use crate::{error::ApiError, store};
use axum::http::{HeaderMap, StatusCode};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;

type Result<T> = std::result::Result<T, DashboardError>;

impl From<rusqlite::Error> for DashboardError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Api(ApiError::from(anyhow::Error::from(e)))
    }
}
impl From<serde_json::Error> for DashboardError {
    fn from(e: serde_json::Error) -> Self {
        Self::Api(ApiError::from(anyhow::Error::from(e)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Dashboard,
    Mcp,
    Api,
}
impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dashboard => "dashboard",
            Self::Mcp => "mcp",
            Self::Api => "api",
        }
    }
    fn parse(value: &str) -> Self {
        match value {
            "dashboard" => Self::Dashboard,
            "mcp" => Self::Mcp,
            _ => Self::Api,
        }
    }
}
/// `X-Piko-Origin: dashboard` marks writes made through the dashboard's proxy.
pub fn origin_from(headers: &HeaderMap) -> Origin {
    match headers.get("x-piko-origin").and_then(|v| v.to_str().ok()) {
        Some("dashboard") => Origin::Dashboard,
        _ => Origin::Api,
    }
}

#[derive(Debug, Serialize)]
pub struct Stored {
    pub id: String,
    pub slug: String,
    pub revision: i64,
    pub updated_at: String,
    pub document: Document,
}
#[derive(Debug, Serialize)]
pub struct Summary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub revision: i64,
    pub updated_at: String,
    pub widgets: usize,
}
#[derive(Debug, Serialize)]
pub struct RevisionInfo {
    pub revision: i64,
    pub origin: Origin,
    pub created_at: String,
}

pub fn migrate(db: &rusqlite::Connection) -> anyhow::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS dashboards(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE, slug TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id, slug));
         CREATE TABLE IF NOT EXISTS dashboard_revisions(dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE, revision INTEGER NOT NULL, document TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('dashboard','mcp','api')), created_at TEXT NOT NULL, PRIMARY KEY(dashboard_id, revision));",
    )?;
    Ok(())
}

fn not_found(what: &str) -> DashboardError {
    ApiError(StatusCode::NOT_FOUND, format!("{what} not found")).into()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
/// The JSON that is stored, which is the serialization `check_document` measures.
fn validated(doc: &Document) -> Result<String> {
    let report = check_document(doc);
    if !report.is_ok() {
        return Err(DashboardError::Invalid(report));
    }
    Ok(serde_json::to_string(doc)?)
}
fn begin(db: &rusqlite::Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        db,
        TransactionBehavior::Immediate,
    )?)
}
/// A project's dashboard by id or slug, as `(id, revision)`.
fn resolve(db: &rusqlite::Connection, product: &str, key: &str) -> Result<(String, i64)> {
    db.query_row(
        "SELECT id,revision FROM dashboards WHERE product_id=?1 AND (id=?2 OR slug=?2) ORDER BY id=?2 DESC LIMIT 1",
        params![product, key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| not_found("Dashboard"))
}
fn load(db: &rusqlite::Connection, id: &str) -> Result<Stored> {
    let (id, slug, revision, updated_at, document): (String, String, i64, String, String) = db
        .query_row(
            "SELECT id,slug,revision,updated_at,document FROM dashboards WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    Ok(Stored {
        id,
        slug,
        revision,
        updated_at,
        document: serde_json::from_str(&document)?,
    })
}

pub fn list(db: &rusqlite::Connection, product: &str) -> Result<Vec<Summary>> {
    store::product(db, product)?;
    let mut q = db.prepare(
        "SELECT id,slug,name,revision,updated_at,document FROM dashboards WHERE product_id=? ORDER BY name,id",
    )?;
    let rows = q.query_map([product], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, slug, name, revision, updated_at, document) = row?;
        let document: Value = serde_json::from_str(&document)?;
        out.push(Summary {
            id,
            slug,
            name,
            description: document["description"].as_str().map(String::from),
            revision,
            updated_at,
            widgets: document["widgets"].as_array().map_or(0, Vec::len),
        });
    }
    Ok(out)
}
pub fn get(db: &rusqlite::Connection, product: &str, key: &str) -> Result<Stored> {
    store::product(db, product)?;
    let (id, _) = resolve(db, product, key)?;
    load(db, &id)
}

/// A slug for a dashboard name. A name with no letter or digit, or with letters outside ASCII
/// (which slugifying would mangle, as in `n-code` for `Ünïcode`), becomes `dashboard`.
fn dashboard_slug(name: &str) -> String {
    let ascii = name.chars().any(|c| c.is_ascii_alphanumeric());
    let foreign = name.chars().any(|c| c.is_alphanumeric() && !c.is_ascii());
    if ascii && !foreign {
        store::project_slug(name)
    } else {
        "dashboard".into()
    }
}

pub fn create(
    db: &rusqlite::Connection,
    product: &str,
    doc: &Document,
    origin: Origin,
) -> Result<Stored> {
    let json = validated(doc)?;
    store::product(db, product)?;
    let tx = begin(db)?;
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM dashboards WHERE product_id=?",
        [product],
        |r| r.get(0),
    )?;
    if count as usize >= Limits::MAX_DASHBOARDS_PER_PROJECT {
        return Err(DashboardError::Limit(format!(
            "A project holds at most {} dashboards",
            Limits::MAX_DASHBOARDS_PER_PROJECT
        )));
    }
    let id = uuid::Uuid::now_v7().to_string();
    let at = now();
    let base = dashboard_slug(&doc.name);
    let mut slug = base.clone();
    let mut suffix = 2;
    loop {
        // The unique index arbitrates the slug; the immediate transaction already
        // serializes writers, so this also holds for concurrent creators.
        let inserted = tx.execute(
            "INSERT INTO dashboards(id,product_id,slug,name,document,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,1,?6,?6) ON CONFLICT(product_id,slug) DO NOTHING",
            params![id, product, slug, doc.name, json, at],
        )?;
        if inserted == 1 {
            break;
        }
        slug = format!("{base}-{suffix}");
        suffix += 1;
    }
    tx.execute(
        "INSERT INTO dashboard_revisions(dashboard_id,revision,document,origin,created_at) VALUES (?1,1,?2,?3,?4)",
        params![id, json, origin.as_str(), at],
    )?;
    tx.commit()?;
    load(db, &id)
}

/// Writes the next revision when the dashboard is still at `expected`.
fn save(
    tx: &Transaction<'_>,
    id: &str,
    expected: i64,
    doc: &Document,
    json: &str,
    origin: Origin,
) -> Result<()> {
    let at = now();
    let changed = tx.execute(
        "UPDATE dashboards SET name=?1,document=?2,revision=revision+1,updated_at=?3 WHERE id=?4 AND revision=?5",
        params![doc.name, json, at, id, expected],
    )?;
    if changed == 0 {
        let revision = tx.query_row("SELECT revision FROM dashboards WHERE id=?", [id], |r| {
            r.get(0)
        })?;
        return Err(DashboardError::Conflict { revision });
    }
    tx.execute(
        "INSERT INTO dashboard_revisions(dashboard_id,revision,document,origin,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, expected + 1, json, origin.as_str(), at],
    )?;
    prune(tx, id)
}
/// Keeps the newest 50 revisions plus the newest revision of each origin.
fn prune(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM dashboard_revisions WHERE dashboard_id=?1
           AND revision NOT IN (SELECT revision FROM dashboard_revisions WHERE dashboard_id=?1 ORDER BY revision DESC LIMIT ?2)
           AND revision NOT IN (SELECT MAX(revision) FROM dashboard_revisions WHERE dashboard_id=?1 GROUP BY origin)",
        params![id, Limits::MAX_REVISIONS as i64],
    )?;
    Ok(())
}

pub fn update(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    base_revision: i64,
    doc: &Document,
    origin: Origin,
) -> Result<Stored> {
    let json = validated(doc)?;
    store::product(db, product)?;
    let tx = begin(db)?;
    let (id, _) = resolve(&tx, product, key)?;
    save(&tx, &id, base_revision, doc, &json, origin)?;
    tx.commit()?;
    load(db, &id)
}
/// Writes a new revision equal to `revision`.
pub fn restore(
    db: &rusqlite::Connection,
    product: &str,
    key: &str,
    revision: i64,
    origin: Origin,
) -> Result<Stored> {
    store::product(db, product)?;
    let tx = begin(db)?;
    let (id, current) = resolve(&tx, product, key)?;
    let text: String = tx
        .query_row(
            "SELECT document FROM dashboard_revisions WHERE dashboard_id=? AND revision=?",
            params![id, revision],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Revision"))?;
    let doc: Document = serde_json::from_str(&text)?;
    let json = validated(&doc)?;
    save(&tx, &id, current, &doc, &json, origin)?;
    tx.commit()?;
    load(db, &id)
}
pub fn delete(db: &rusqlite::Connection, product: &str, key: &str) -> Result<()> {
    store::product(db, product)?;
    let tx = begin(db)?;
    let (id, _) = resolve(&tx, product, key)?;
    tx.execute(
        "DELETE FROM dashboard_revisions WHERE dashboard_id=?",
        [&id],
    )?;
    tx.execute("DELETE FROM dashboards WHERE id=?", [&id])?;
    tx.commit()?;
    Ok(())
}
/// Revisions kept, newest first.
pub fn revisions(db: &rusqlite::Connection, product: &str, key: &str) -> Result<Vec<RevisionInfo>> {
    store::product(db, product)?;
    let (id, _) = resolve(db, product, key)?;
    let mut q = db.prepare(
        "SELECT revision,origin,created_at FROM dashboard_revisions WHERE dashboard_id=? ORDER BY revision DESC",
    )?;
    let rows = q.query_map([id], |r| {
        Ok(RevisionInfo {
            revision: r.get(0)?,
            origin: Origin::parse(&r.get::<_, String>(1)?),
            created_at: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
