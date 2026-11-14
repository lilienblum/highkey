use crate::{
    dashboards::error::DashboardError,
    error::{ApiError, ApiResult},
    model::{KeyInfo, Product, ProductInput},
};
use anyhow::Result;
use duckdb::Connection;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn secret(prefix: &str) -> String {
    format!(
        "{prefix}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
pub struct Store {
    pub changes: crate::changes::Changes,
    pub sqlite_path: PathBuf,
    pub analytics: crate::product_db::ProductDatabases,
    pub logs: crate::product_db::ProductDatabases,
    pub log_query_slots: Arc<tokio::sync::Semaphore>,
    pub query_slots: Arc<tokio::sync::Semaphore>,
    pub state_slots: Arc<tokio::sync::Semaphore>,
    /// Widget runs pass these before taking a query slot, so dashboards never hold the last one.
    pub dashboard_event_gate: Arc<tokio::sync::Semaphore>,
    pub dashboard_log_gate: Arc<tokio::sync::Semaphore>,
}
impl Store {
    pub fn open(path: &Path, queries: usize) -> Result<Arc<Self>> {
        std::fs::create_dir_all(path)?;
        let sqlite_path = path.join("state.sqlite");
        let mut sql = rusqlite::Connection::open(&sqlite_path)?;
        sql.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, retention_days INTEGER NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ingestion_keys(id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), label TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
          DROP TABLE IF EXISTS sessions; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          ")?;
        crate::sources::migrate(&mut sql)?;
        crate::logs::keys::migrate(&sql)?;
        crate::dashboards::storage::migrate(&sql)?;
        crate::views::migrate(&sql)?;
        let analytics = crate::product_db::ProductDatabases::new(path.join("products"))?;
        let migrated = sql
            .query_row(
                "SELECT value FROM settings WHERE key='product_databases_migrated'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        if path.join("events.duckdb").exists() && migrated.is_none() {
            let imported = analytics.import_legacy(&path.join("events.duckdb"))?;
            sql.execute(
                "INSERT INTO settings VALUES ('product_databases_migrated','1')",
                [],
            )?;
            tracing::info!(
                imported,
                "Migrated analytics to separate product databases; original file retained"
            );
        }
        Ok(Arc::new(Self {
            changes: crate::changes::Changes::default(),
            sqlite_path,
            analytics,
            logs: crate::product_db::ProductDatabases::for_logs(path.join("logs"))?,
            log_query_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            query_slots: Arc::new(tokio::sync::Semaphore::new(queries)),
            state_slots: Arc::new(tokio::sync::Semaphore::new(16)),
            dashboard_event_gate: Arc::new(tokio::sync::Semaphore::new(
                queries.saturating_sub(1).max(1),
            )),
            dashboard_log_gate: Arc::new(tokio::sync::Semaphore::new(1)),
        }))
    }
    pub fn sqlite(&self) -> Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open(&self.sqlite_path)?;
        conn.busy_timeout(Duration::from_secs(2))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(conn)
    }
    pub async fn state<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&rusqlite::Connection) -> ApiResult<T> + Send + 'static,
    ) -> ApiResult<T> {
        let permit = self
            .state_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let db = store.sqlite()?;
            f(&db)
        })
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
    }
    pub async fn query<T: Send + 'static>(
        self: &Arc<Self>,
        product_id: String,
        f: impl FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
    ) -> ApiResult<T> {
        let permit = self
            .query_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut lease = store.analytics.connection(&product_id)?;
            // Pin the product instance and admission permit until actual completion.
            f(&mut lease.connection)
        })
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
    }
    /// Runs dashboard work on the events and/or logs connection of `product`, within `deadline`.
    ///
    /// The deadline covers waiting at the dashboard gates and for query slots as well as the
    /// work itself. Gates keep the last event slot and one log slot for interactive queries,
    /// which keep `try_acquire`. At the deadline, or as soon as the caller's future is dropped,
    /// the work's statements are interrupted (and the caller gets `Timeout`, with `queued` set when the deadline passed before any work started); the permits stay
    /// with the blocking work until it really ends.
    pub async fn widget_query<T: Send + 'static>(
        self: &Arc<Self>,
        product: String,
        events: bool,
        logs: bool,
        deadline: tokio::time::Instant,
        f: impl FnOnce(Option<&mut Connection>, Option<&mut Connection>) -> ApiResult<T>
        + Send
        + 'static,
    ) -> Result<T, DashboardError> {
        use std::sync::atomic::{AtomicBool, Ordering};
        let started = tokio::time::Instant::now();
        let timeout = move |queued| DashboardError::Timeout {
            after_ms: started.elapsed().as_millis() as u64,
            queued,
        };
        // Acquire in one fixed order (log gate, log slot, event gate, event slot) so runs that
        // need both signals cannot deadlock each other. The scarcer log stages come first, so
        // a run waiting for them holds no event permit that events-only runs need.
        let mut permits = Vec::with_capacity(4);
        let mut stages = Vec::new();
        if logs {
            stages.push(&self.dashboard_log_gate);
            stages.push(&self.log_query_slots);
        }
        if events {
            stages.push(&self.dashboard_event_gate);
            stages.push(&self.query_slots);
        }
        for semaphore in stages {
            let permit = tokio::time::timeout_at(deadline, semaphore.clone().acquire_owned())
                .await
                .map_err(|_| timeout(true))?
                .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
            permits.push(permit);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let (handles_tx, handles_rx) = tokio::sync::oneshot::channel();
        let store = self.clone();
        let stop = cancelled.clone();
        let mut work = tokio::task::spawn_blocking(move || {
            let _permits = permits;
            // Nobody reads this result: the caller already answered with a timeout.
            let gone = || {
                ApiError(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "Widget run passed its deadline".into(),
                )
            };
            if stop.load(Ordering::SeqCst) {
                return Err(gone());
            }
            let mut event_lease = events
                .then(|| store.analytics.connection(&product))
                .transpose()?;
            let mut log_lease = logs.then(|| store.logs.connection(&product)).transpose()?;
            let handles: Vec<_> = event_lease
                .iter()
                .chain(log_lease.iter())
                .map(|lease| lease.connection.interrupt_handle())
                .collect();
            let _ = handles_tx.send(handles);
            // Checked after the handles are out, so a run that times out here is either
            // skipped or interrupted, never left running unwatched.
            if stop.load(Ordering::SeqCst) {
                return Err(gone());
            }
            f(
                event_lease.as_mut().map(|lease| &mut lease.connection),
                log_lease.as_mut().map(|lease| &mut lease.connection),
            )
        });
        // The watchdog owns the work, so the deadline holds even when the caller's future is
        // dropped (an aborted request). A dropped caller stops the work at once.
        let (result_tx, mut result_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut result_tx = result_tx;
            let finished = tokio::select! {
                biased;
                joined = &mut work => Some(joined),
                _ = tokio::time::sleep_until(deadline) => None,
                _ = result_tx.closed() => None,
            };
            if let Some(joined) = finished {
                let _ = result_tx.send(joined);
                return;
            }
            cancelled.store(true, Ordering::SeqCst);
            drop(result_tx);
            let Ok(handles) = handles_rx.await else {
                return;
            };
            // DuckDB clears an interrupt when a statement starts, so one interrupt can land
            // between statements and be lost. Keep signalling until the work ends.
            loop {
                for handle in &handles {
                    handle.interrupt();
                }
                if tokio::time::timeout(Duration::from_millis(50), &mut work)
                    .await
                    .is_ok()
                {
                    break;
                }
            }
        });
        match tokio::time::timeout_at(deadline, &mut result_rx).await {
            Ok(Ok(joined)) => joined
                .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
                .map_err(DashboardError::Api),
            // The watchdog stopped the work at the deadline.
            Ok(Err(_)) | Err(_) => Err(timeout(false)),
        }
    }
}
/// A project by id, or else by slug, as its own row (see `product_row`).
pub fn resolve_product(db: &rusqlite::Connection, key: &str) -> ApiResult<Product> {
    let id = db
        .query_row("SELECT id FROM products WHERE id=?", [key], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(anyhow::Error::from)?;
    let id = match id {
        Some(id) => id,
        None => db
            .query_row("SELECT id FROM products WHERE slug=?", [key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(anyhow::Error::from)?
            .ok_or_else(ApiError::project_missing)?,
    };
    product_row(db, &id)
}
/// A project with its sources and sidebar links, as the API returns it.
pub fn product(db: &rusqlite::Connection, id: &str) -> ApiResult<Product> {
    let mut product = product_row(db, id)?;
    product.sources = crate::sources::list(db, id)?;
    product.dashboards = dashboard_links(db, id)?;
    product.views = crate::views::links(db, id)?;
    Ok(product)
}
/// A project's own row, without its sources and sidebar links, for paths that need only its
/// id, slug, name or retention, such as ingestion and dashboard runs.
pub fn product_row(db: &rusqlite::Connection, id: &str) -> ApiResult<Product> {
    db.query_row(
        "SELECT id,name,retention_days,created_at,website_url,favicon_version,slug FROM products WHERE id=?",
        [id],
        row_product,
    )
    .optional()
    .map_err(anyhow::Error::from)?
    .ok_or_else(ApiError::project_missing)
}
/// Fails with 404 unless project `id` exists.
pub fn require_product(db: &rusqlite::Connection, id: &str) -> ApiResult<()> {
    db.query_row("SELECT 1 FROM products WHERE id=?", [id], |_| Ok(()))
        .optional()
        .map_err(anyhow::Error::from)?
        .ok_or_else(ApiError::project_missing)
}
fn row_product(r: &rusqlite::Row<'_>) -> rusqlite::Result<Product> {
    Ok(Product {
        id: r.get(0)?,
        name: r.get(1)?,
        retention_days: r.get(2)?,
        created_at: r.get(3)?,
        sources: Vec::new(),
        dashboards: Vec::new(),
        views: Vec::new(),
        website_url: r.get(4)?,
        favicon_version: r.get(5)?,
        slug: r.get(6)?,
    })
}
pub fn products(db: &rusqlite::Connection) -> ApiResult<Vec<Product>> {
    let mut q = db
        .prepare("SELECT id,name,retention_days,created_at,website_url,favicon_version,slug FROM products ORDER BY created_at,id")
        .map_err(anyhow::Error::from)?;
    let mut products = q
        .query_map([], row_product)
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    for product in &mut products {
        product.sources = crate::sources::list(db, &product.id)?;
        product.dashboards = dashboard_links(db, &product.id)?;
        product.views = crate::views::links(db, &product.id)?;
    }
    Ok(products)
}
fn dashboard_links(
    db: &rusqlite::Connection,
    id: &str,
) -> ApiResult<Vec<crate::model::DashboardLink>> {
    let mut q = db
        .prepare("SELECT id,slug,name FROM dashboards WHERE product_id=? ORDER BY name COLLATE NOCASE,name,id")
        .map_err(anyhow::Error::from)?;
    let links = q
        .query_map([id], |r| {
            Ok(crate::model::DashboardLink {
                id: r.get(0)?,
                slug: r.get(1)?,
                name: r.get(2)?,
            })
        })
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(links)
}
pub fn project_slug(name: &str) -> String {
    let slug = name
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = slug.chars().take(64).collect::<String>();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "project".into()
    } else {
        slug.into()
    }
}

pub fn save_product(
    db: &rusqlite::Connection,
    id: Option<String>,
    input: ProductInput,
) -> ApiResult<Product> {
    input.validate()?;
    let previous = id.as_deref().map(|id| product(db, id)).transpose()?;
    let website = match input.website_url.as_deref() {
        Some(value) => crate::website::normalize(value)?,
        None => previous.as_ref().and_then(|p| p.website_url.clone()),
    };
    let id = id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let tx = db.unchecked_transaction().map_err(anyhow::Error::from)?;
    if previous.is_some() {
        tx.execute("UPDATE products SET name=?2,retention_days=?3,website_url=?4,favicon=CASE WHEN website_url IS ?4 THEN favicon ELSE NULL END,favicon_version=CASE WHEN website_url IS ?4 THEN favicon_version ELSE NULL END WHERE id=?1", params![id,input.name.trim(),input.retention_days,website]).map_err(anyhow::Error::from)?;
    } else {
        let base = project_slug(&input.name);
        let mut slug = base.clone();
        let mut suffix = 2;
        loop {
            // The unique index arbitrates concurrent creators. A conflict keeps
            // the transaction's write lock while we allocate the next suffix.
            let inserted = tx.execute("INSERT INTO products(id,name,retention_days,created_at,website_url,slug) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(slug) DO NOTHING", params![id,input.name.trim(),input.retention_days,chrono::Utc::now().to_rfc3339(),website,slug]).map_err(anyhow::Error::from)?;
            if inserted == 1 {
                break;
            }
            slug = format!("{base}-{suffix}");
            suffix += 1;
        }
    }
    tx.execute(
        "INSERT OR IGNORE INTO sources(id,product_id,name,created_at,slug) VALUES (?1,?1,'Events',?2,'events')",
        params![id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(anyhow::Error::from)?;
    tx.commit().map_err(anyhow::Error::from)?;
    product(db, &id)
}
pub fn create_key(
    db: &rusqlite::Connection,
    id: &str,
    label: &str,
    source_id: Option<&str>,
    allowed_origins: &[String],
) -> ApiResult<serde_json::Value> {
    require_product(db, id)?;
    let source_id = source_id.unwrap_or(id);
    crate::sources::get(db, id, source_id)?;
    if label.trim().is_empty() || label.len() > 80 {
        return Err(ApiError::bad("Key label must be 1–80 bytes"));
    }
    let allowed_origins = crate::origins::normalize(allowed_origins)?;
    let key = secret("pk_");
    let key_id = uuid::Uuid::now_v7().to_string();
    db.execute("INSERT INTO ingestion_keys(id,product_id,label,prefix,hash,created_at,source_id,allowed_origins) VALUES (?,?,?,?,?,?,?,?)",params![key_id,id,label.trim(),&key[..11],hash(&key),chrono::Utc::now().to_rfc3339(),source_id,serde_json::to_string(&allowed_origins).map_err(anyhow::Error::from)?]).map_err(anyhow::Error::from)?;
    Ok(
        serde_json::json!({"id":key_id,"key":key,"source_id":source_id,"allowed_origins":allowed_origins}),
    )
}
/// Replaces the origins of an active ingestion key and returns the normalized list.
pub fn update_key_origins(
    db: &rusqlite::Connection,
    id: &str,
    key: &str,
    allowed_origins: &[String],
) -> ApiResult<Vec<String>> {
    let allowed = crate::origins::normalize(allowed_origins)?;
    let changed = db
        .execute(
            "UPDATE ingestion_keys SET allowed_origins=? WHERE product_id=? AND id=? AND revoked=0",
            params![
                serde_json::to_string(&allowed).map_err(anyhow::Error::from)?,
                id,
                key
            ],
        )
        .map_err(anyhow::Error::from)?;
    if changed == 0 {
        return Err(ApiError::missing());
    }
    Ok(allowed)
}
pub fn revoke_key(db: &rusqlite::Connection, id: &str, key: &str) -> ApiResult<()> {
    let n = db
        .execute(
            "UPDATE ingestion_keys SET revoked=1 WHERE product_id=? AND id=?",
            [id, key],
        )
        .map_err(anyhow::Error::from)?;
    if n == 0 {
        return Err(ApiError::missing());
    }
    Ok(())
}
pub fn keys(db: &rusqlite::Connection, id: &str) -> ApiResult<Vec<KeyInfo>> {
    require_product(db, id)?;
    let mut q=db.prepare("SELECT id,label,prefix,created_at,revoked,source_id,allowed_origins FROM ingestion_keys WHERE product_id=? ORDER BY created_at").map_err(anyhow::Error::from)?;
    q.query_map([id], |r| {
        Ok(KeyInfo {
            id: r.get(0)?,
            label: r.get(1)?,
            prefix: r.get(2)?,
            created_at: r.get(3)?,
            revoked: r.get(4)?,
            source_id: r.get(5)?,
            allowed_origins: serde_json::from_str(&r.get::<_, String>(6)?).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
        })
    })
    .map_err(anyhow::Error::from)?
    .collect::<rusqlite::Result<_>>()
    .map_err(|e| anyhow::Error::from(e).into())
}
pub fn resolve_key(
    db: &rusqlite::Connection,
    key: &str,
    origin: Option<&str>,
) -> ApiResult<(Product, String)> {
    let resolved: Option<(String, String, String)> = db
        .query_row(
            "SELECT product_id,source_id,allowed_origins FROM ingestion_keys WHERE hash=? AND revoked=0",
            [hash(key)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    let (id, source_id, allowed) = resolved.ok_or_else(ApiError::unauthorized)?;
    let allowed: Vec<String> = serde_json::from_str(&allowed).map_err(anyhow::Error::from)?;
    crate::origins::check(&allowed, origin)?;
    crate::sources::get(db, &id, &source_id)?;
    Ok((product_row(db, &id)?, source_id))
}

pub fn cache_favicon(
    db: &rusqlite::Connection,
    id: &str,
    website: &str,
    bytes: &[u8],
) -> ApiResult<Product> {
    let version = format!("{:x}", Sha256::digest(bytes));
    db.execute(
        "UPDATE products SET favicon=?,favicon_version=? WHERE id=? AND website_url=?",
        params![bytes, version, id, website],
    )
    .map_err(anyhow::Error::from)?;
    product(db, id)
}

#[cfg(test)]
mod slug_tests {
    use super::*;
    fn input(name: &str) -> ProductInput {
        ProductInput {
            name: name.into(),
            website_url: None,
            retention_days: 365,
        }
    }
    #[test]
    fn slugs_are_unique_persistent_and_unchanged_by_rename() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), 2).unwrap();
        let db = store.sqlite().unwrap();
        let first = save_product(&db, None, input("Orbit Site")).unwrap();
        let second = save_product(&db, None, input("Orbit--Site")).unwrap();
        let third = save_product(&db, None, input("Orbit Site 2")).unwrap();
        assert_eq!(first.slug, "orbit-site");
        assert_eq!(second.slug, "orbit-site-2");
        assert_eq!(third.slug, "orbit-site-2-2");
        let key = create_key(&db, &first.id, "test", None, &[]).unwrap();
        let updated = save_product(&db, Some(first.id.clone()), input("Renamed")).unwrap();
        assert_eq!(updated.slug, first.slug);
        assert_eq!(updated.created_at, first.created_at);
        assert_eq!(
            resolve_key(&db, key["key"].as_str().unwrap(), None)
                .unwrap()
                .0
                .id,
            first.id
        );
        drop(db);
        drop(store);
        let reopened = Store::open(dir.path(), 2).unwrap();
        assert_eq!(
            product(&reopened.sqlite().unwrap(), &first.id)
                .unwrap()
                .slug,
            first.slug
        );
        assert_eq!(project_slug("東京 ✨"), "project");
    }
    #[test]
    fn version_five_migration_assigns_stable_slugs_without_losing_catalog_data() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT NOT NULL,retention_days INTEGER NOT NULL,created_at TEXT NOT NULL,website_url TEXT,favicon BLOB,favicon_version TEXT);
            CREATE TABLE sources(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL COLLATE NOCASE,created_at TEXT NOT NULL,icon TEXT,UNIQUE(product_id,name));
            INSERT INTO products VALUES ('1','Orbit',90,'2026-01-01',NULL,NULL,NULL),('2','Orbit',365,'2026-01-02','https://example.com',x'00','cached');
            INSERT INTO sources VALUES ('1','1','Events','2026-01-01',NULL),('2','2','Events','2026-01-02',NULL);
            PRAGMA user_version=5;").unwrap();
        crate::sources::migrate(&mut db).unwrap();
        crate::sources::migrate(&mut db).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        // Source slugs are unique per project, so both initial sources keep `events`.
        for id in ["1", "2"] {
            assert_eq!(crate::sources::list(&db, id).unwrap()[0].slug, "events");
        }
        let values: Vec<(String, i64, Option<String>)> = db
            .prepare("SELECT slug,retention_days,favicon_version FROM products ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            values,
            vec![
                ("orbit".into(), 90, None),
                ("orbit-2".into(), 365, Some("cached".into()))
            ]
        );
        assert!(
            db.execute("UPDATE products SET slug='orbit' WHERE id='2'", [])
                .is_err()
        );
    }
    #[test]
    fn concurrent_creators_reserve_distinct_slugs() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), 2).unwrap();
        let jobs: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    save_product(&store.sqlite().unwrap(), None, input("Same name"))
                        .unwrap()
                        .slug
                })
            })
            .collect();
        let slugs: std::collections::HashSet<_> =
            jobs.into_iter().map(|job| job.join().unwrap()).collect();
        assert_eq!(slugs.len(), 8);
    }
    #[test]
    fn ingestion_resolves_keys_without_loading_sidebar_links() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), 2).unwrap();
        let db = store.sqlite().unwrap();
        let shop = save_product(&db, None, input("Shop")).unwrap();
        let doc = serde_json::from_value(serde_json::json!({
            "version": 1, "name": "Board",
            "widgets": [{"id": "w", "title": "W", "view": {"type": "text", "markdown": "x"}}]
        }))
        .unwrap();
        crate::dashboards::storage::create(
            &db,
            &shop.id,
            &doc,
            crate::dashboards::storage::Origin::Api,
        )
        .unwrap();
        let key = create_key(&db, &shop.id, "test", None, &[]).unwrap();
        let full = product(&db, &shop.id).unwrap();
        assert_eq!((full.sources.len(), full.dashboards.len()), (1, 1));
        // Each ingestion request resolves its key: it needs the project's id and retention,
        // not the sources and sidebar links the dashboard shows.
        let (lean, source) = resolve_key(&db, key["key"].as_str().unwrap(), None).unwrap();
        assert_eq!(
            (lean.id.as_str(), lean.retention_days),
            (shop.id.as_str(), 365)
        );
        assert_eq!(source, shop.id);
        assert!(lean.sources.is_empty() && lean.dashboards.is_empty() && lean.views.is_empty());
        assert!(require_product(&db, &shop.id).is_ok());
        assert_eq!(require_product(&db, "missing").unwrap_err().0, 404);
    }
    #[test]
    fn resolve_product_takes_an_id_or_a_slug() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), 2).unwrap();
        let db = store.sqlite().unwrap();
        let shop = save_product(&db, None, input("Shop")).unwrap();
        assert_eq!(resolve_product(&db, &shop.id).unwrap().id, shop.id);
        assert_eq!(resolve_product(&db, "shop").unwrap().id, shop.id);
        assert_eq!(resolve_product(&db, "missing").unwrap_err().0, 404);
    }
}

#[cfg(test)]
mod widget_tests {
    use super::*;
    use crate::dashboards::error::DashboardError;
    use std::sync::mpsc;
    use tokio::time::Instant;

    fn open(queries: usize) -> (tempfile::TempDir, Arc<Store>, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), queries).unwrap();
        (dir, store, uuid::Uuid::now_v7().to_string())
    }
    async fn eventually(what: &str, check: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(3);
        while !check() {
            assert!(Instant::now() < until, "{what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    fn timed_out<T: std::fmt::Debug>(result: &Result<T, DashboardError>) -> bool {
        matches!(result, Err(DashboardError::Timeout { .. }))
    }

    #[tokio::test]
    async fn widget_query_interrupts_at_deadline_and_releases_slots() {
        let (_dir, store, product) = open(4);
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            store.widget_query(
                product,
                true,
                false,
                started + Duration::from_secs(1),
                |events, logs| {
                    assert!(logs.is_none());
                    events
                        .expect("an events connection")
                        .query_row(
                            "SELECT count(*) FROM range(10000000000) a, range(10) b",
                            [],
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(|e| anyhow::Error::from(e).into())
                },
            ),
        )
        .await
        .expect("the run returns at its deadline");
        assert!(timed_out(&result), "{result:?}");
        assert!(started.elapsed() >= Duration::from_secs(1));
        // Permits live in the blocking work, so they return once the interrupt ends it.
        eventually("query slots return", || {
            store.query_slots.available_permits() == 4
        })
        .await;
        eventually("the gate reopens", || {
            store.dashboard_event_gate.available_permits() == 3
        })
        .await;
    }

    #[tokio::test]
    async fn a_dropped_widget_query_still_interrupts_and_releases_slots() {
        let (_dir, store, product) = open(4);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        // A long deadline, so only the dropped caller can explain a prompt release.
        let run = store.widget_query(
            product,
            true,
            false,
            Instant::now() + Duration::from_secs(10),
            move |events, _| {
                let _ = started_tx.send(());
                events
                    .expect("an events connection")
                    .query_row(
                        "SELECT count(*) FROM range(10000000000) a, range(10) b",
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(|e| anyhow::Error::from(e).into())
            },
        );
        // Drive the run until its statement starts, then drop it, as an aborted request does.
        tokio::select! {
            _ = run => panic!("the cross join finished"),
            _ = started_rx => {}
        }
        assert_eq!(store.query_slots.available_permits(), 3);
        eventually("query slots return after the caller is dropped", || {
            store.query_slots.available_permits() == 4
        })
        .await;
        eventually("the gate reopens after the caller is dropped", || {
            store.dashboard_event_gate.available_permits() == 3
        })
        .await;
    }

    #[tokio::test]
    async fn dashboard_gate_leaves_one_event_and_one_log_slot() {
        let (_dir, store, product) = open(4);
        assert_eq!(store.dashboard_event_gate.available_permits(), 3);
        assert_eq!(store.dashboard_log_gate.available_permits(), 1);
        let deadline = Instant::now() + Duration::from_secs(10);
        let (started_tx, mut started) = tokio::sync::mpsc::unbounded_channel();
        // Each held run blocks until its release sender is dropped.
        let mut releases = Vec::new();
        let mut hold = |events: bool, logs: bool| {
            let (release, wait) = mpsc::channel::<()>();
            releases.push(release);
            let (store, product, started_tx) = (store.clone(), product.clone(), started_tx.clone());
            tokio::spawn(async move {
                store
                    .widget_query(product, events, logs, deadline, move |e, l| {
                        assert_eq!((e.is_some(), l.is_some()), (events, logs));
                        started_tx.send(()).unwrap();
                        let _ = wait.recv_timeout(Duration::from_secs(10));
                        Ok(())
                    })
                    .await
            })
        };
        let mut held: Vec<_> = (0..3).map(|_| hold(true, false)).collect();
        let mut begin = async || {
            tokio::time::timeout(Duration::from_secs(5), started.recv())
                .await
                .expect("a held run starts")
                .unwrap()
        };
        for _ in 0..3 {
            begin().await;
        }
        assert_eq!(store.query_slots.available_permits(), 1);
        // A fourth widget run waits at the gate until its deadline...
        let short = || Instant::now() + Duration::from_millis(200);
        let blocked = store
            .widget_query(product.clone(), true, false, short(), |_, _| Ok(()))
            .await;
        assert!(timed_out(&blocked), "{blocked:?}");
        // ...while interactive queries keep the last slot.
        let answer = store
            .query(product.clone(), |db| {
                db.query_row("SELECT 42", [], |r| r.get::<_, i64>(0))
                    .map_err(|e| anyhow::Error::from(e).into())
            })
            .await
            .unwrap();
        assert_eq!(answer, 42);
        assert!(store.query_slots.try_acquire().is_ok());

        held.push(hold(false, true));
        begin().await;
        assert_eq!(store.log_query_slots.available_permits(), 1);
        let blocked = store
            .widget_query(product.clone(), false, true, short(), |_, _| Ok(()))
            .await;
        assert!(timed_out(&blocked), "{blocked:?}");
        assert!(store.log_query_slots.try_acquire().is_ok());

        drop(releases);
        for run in held {
            run.await.unwrap().unwrap();
        }
        assert_eq!(store.query_slots.available_permits(), 4);
        assert_eq!(store.log_query_slots.available_permits(), 2);
        assert_eq!(store.dashboard_event_gate.available_permits(), 3);
        assert_eq!(store.dashboard_log_gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn runs_waiting_for_the_log_gate_hold_no_event_permits() {
        let (_dir, store, product) = open(4);
        let deadline = Instant::now() + Duration::from_secs(10);
        // A log-only run holds the one log gate permit.
        let (release, wait) = mpsc::channel::<()>();
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let held = {
            let (store, product) = (store.clone(), product.clone());
            tokio::spawn(async move {
                store
                    .widget_query(product, false, true, deadline, move |_, _| {
                        started_tx.send(()).unwrap();
                        let _ = wait.recv_timeout(Duration::from_secs(10));
                        Ok(())
                    })
                    .await
            })
        };
        started.await.unwrap();
        // As many widgets that read both signals as the event gate admits queue behind it.
        let mixed: Vec<_> = (0..3)
            .map(|_| {
                let (store, product) = (store.clone(), product.clone());
                tokio::spawn(async move {
                    store
                        .widget_query(product, true, true, deadline, |_, _| Ok(()))
                        .await
                })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(200)).await;
        // While they wait for logs, an events-only widget still runs.
        let events = store
            .widget_query(
                product.clone(),
                true,
                false,
                Instant::now() + Duration::from_millis(500),
                |_, _| Ok(()),
            )
            .await;
        assert!(events.is_ok(), "{events:?}");
        drop(release);
        held.await.unwrap().unwrap();
        for run in mixed {
            run.await.unwrap().unwrap();
        }
        assert_eq!(store.dashboard_event_gate.available_permits(), 3);
        assert_eq!(store.dashboard_log_gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn widget_query_deadline_covers_waiting_for_a_slot() {
        // With one slot, dashboards pass the gate and then share the slot with everyone else.
        let (_dir, store, product) = open(1);
        assert_eq!(store.dashboard_event_gate.available_permits(), 1);
        let interactive = store.query_slots.clone().try_acquire_owned().unwrap();
        let started = Instant::now();
        let result = store
            .widget_query(
                product.clone(),
                true,
                false,
                started + Duration::from_millis(300),
                |_, _| Ok(()),
            )
            .await;
        assert!(timed_out(&result), "{result:?}");
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert_eq!(store.dashboard_event_gate.available_permits(), 1);
        drop(interactive);
        let both = store
            .widget_query(
                product,
                true,
                true,
                Instant::now() + Duration::from_secs(5),
                |events, logs| {
                    let one = |db: &mut Connection| {
                        db.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                            .map_err(|e| ApiError::from(anyhow::Error::from(e)))
                    };
                    Ok(one(events.unwrap())? + one(logs.unwrap())?)
                },
            )
            .await
            .unwrap();
        assert_eq!(both, 2);
        assert_eq!(store.query_slots.available_permits(), 1);
        assert_eq!(store.log_query_slots.available_permits(), 2);
    }
}
