//! One physical analytical database per product, with a bounded, pinned LRU cache.
use crate::error::{ApiError, ApiResult};
use anyhow::Result;
use duckdb::{Config, Connection, params};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
const MAX_OPEN: usize = 8;
/// Settings that keep queries inside the database, applied to every product database (and the
/// SQL parser) after its own settings. `max_expression_depth` is a per-connection setting, so
/// it is set GLOBAL to reach the cloned connections leases use; 250 bounds how deep DuckDB's
/// recursive parser and binder go (see `dashboards::sql::SQL_STACK_BYTES` and `MAX_TREE_DEPTH`).
/// `max_temp_directory_size` caps what one database spills to disk (an ORDER BY over a large
/// range spilled 570 MB in 4 s; DuckDB's default is 90% of the free disk).
/// `lock_configuration` comes last, so no query, dashboard SQL included, can change any setting
/// afterwards; nothing in the API sets one later.
pub const LOCKED_SETTINGS: &str = "SET GLOBAL max_expression_depth=250; SET enable_external_access=false; SET autoload_known_extensions=false; SET autoinstall_known_extensions=false; SET max_temp_directory_size='1GiB'; SET lock_configuration=true;";
/// The configuration every database the API opens starts with. DuckDB 2.0 starts 40
/// `async_threads` per instance by default, for remote file IO that `enable_external_access`
/// rules out here. Each is a thread with an 8 MiB stack, about 330 MiB of address space per
/// open database, which `RLIMIT_DATA` counts. Setting it at open means the threads are never
/// spawned; a SET afterwards starts them first. One stays, so no async task could wait for a
/// thread that does not exist.
pub fn database_config() -> duckdb::Result<Config> {
    Config::default().with("async_threads", "1")
}
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS events(product_id VARCHAR NOT NULL, event_id VARCHAR NOT NULL, name VARCHAR NOT NULL, source VARCHAR NOT NULL, event_time BIGINT NOT NULL, received_at BIGINT NOT NULL, actor_id VARCHAR, identity_kind VARCHAR, session_id VARCHAR, properties JSON NOT NULL, PRIMARY KEY(product_id,event_id));";
const LOG_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS logs(log_id VARCHAR PRIMARY KEY, source_id VARCHAR NOT NULL, timestamp BIGINT NOT NULL, received_at BIGINT NOT NULL, level VARCHAR NOT NULL, message VARCHAR NOT NULL, service VARCHAR NOT NULL, environment VARCHAR, trace_id VARCHAR, span_id VARCHAR, request_id VARCHAR, attributes JSON NOT NULL);";
enum DatabaseKind {
    Events,
    Logs,
}
struct Database {
    root: Mutex<Connection>,
}
struct Entry {
    database: Arc<Database>,
    used: Instant,
}
pub struct ProductDatabases {
    directory: PathBuf,
    cache: Mutex<HashMap<String, Entry>>,
    kind: DatabaseKind,
}
// Field order drops the clone before releasing the pin on its root instance.
pub struct Lease {
    pub connection: Connection,
    _pin: Arc<Database>,
}
impl ProductDatabases {
    pub fn new(directory: PathBuf) -> Result<Self> {
        Self::create(directory, DatabaseKind::Events)
    }
    pub fn for_logs(directory: PathBuf) -> Result<Self> {
        Self::create(directory, DatabaseKind::Logs)
    }
    fn create(directory: PathBuf, kind: DatabaseKind) -> Result<Self> {
        std::fs::create_dir_all(&directory)?;
        Ok(Self {
            directory,
            cache: Mutex::new(HashMap::new()),
            kind,
        })
    }
    pub fn path(&self, id: &str) -> Result<PathBuf> {
        let id = uuid::Uuid::parse_str(id)?;
        Ok(self.directory.join(format!("{id}.duckdb")))
    }
    pub fn connection(&self, id: &str) -> ApiResult<Lease> {
        let path = self.path(id)?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Database cache poisoned"))?;
        if !cache.contains_key(id) {
            let capacity = match self.kind {
                DatabaseKind::Events => MAX_OPEN,
                DatabaseKind::Logs => 4,
            };
            if cache.len() >= capacity {
                let victim = cache
                    .iter()
                    .filter(|(_, e)| Arc::strong_count(&e.database) == 1)
                    .min_by_key(|(_, e)| e.used)
                    .map(|(id, _)| id.clone())
                    .ok_or_else(ApiError::busy)?;
                cache.remove(&victim);
            }
            let db =
                Connection::open_with_flags(path, database_config().map_err(anyhow::Error::from)?)
                    .map_err(anyhow::Error::from)?;
            match self.kind {
                DatabaseKind::Events => {
                    db.execute_batch(&format!(
                        "SET threads=2; SET memory_limit='64MB'; {LOCKED_SETTINGS}"
                    ))
                    .map_err(anyhow::Error::from)?;
                    db.execute_batch(SCHEMA).map_err(anyhow::Error::from)?;
                    // IDs are UUID-validated by path(); existing rows belong to the initial source.
                    db.execute_batch(&format!("ALTER TABLE events ADD COLUMN IF NOT EXISTS source_id VARCHAR DEFAULT '{id}';")).map_err(anyhow::Error::from)?;
                }
                DatabaseKind::Logs => {
                    db.execute_batch(&format!(
                        "SET threads=1; SET memory_limit='32MB'; {LOCKED_SETTINGS}"
                    ))
                    .map_err(anyhow::Error::from)?;
                    db.execute_batch(LOG_SCHEMA).map_err(anyhow::Error::from)?;
                }
            }
            cache.insert(
                id.into(),
                Entry {
                    database: Arc::new(Database {
                        root: Mutex::new(db),
                    }),
                    used: Instant::now(),
                },
            );
        }
        let entry = cache.get_mut(id).expect("cached database");
        entry.used = Instant::now();
        let pin = entry.database.clone();
        let connection = pin
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("Database connection poisoned"))?
            .try_clone()
            .map_err(anyhow::Error::from)?;
        Ok(Lease {
            connection,
            _pin: pin,
        })
    }
    pub fn checkpoint(&self) -> Result<()> {
        let cache = self
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("Database cache poisoned"))?;
        for entry in cache.values() {
            entry
                .database
                .root
                .lock()
                .map_err(|_| anyhow::anyhow!("Database connection poisoned"))?
                .execute_batch("CHECKPOINT;")?;
        }
        Ok(())
    }
    /// Idempotent import from early MVP builds. Keep the original file as a backup.
    pub fn import_legacy(&self, path: &Path) -> Result<usize> {
        let legacy = Connection::open_with_flags(path, database_config()?)?;
        let ids = legacy
            .prepare("SELECT DISTINCT product_id FROM events")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        let mut imported = 0;
        for id in ids {
            let mut lease = self.connection(&id).map_err(|e| anyhow::anyhow!(e.1))?;
            let tx = lease.connection.transaction()?;
            tx.execute_batch(
                "CREATE TEMP TABLE migration_buffer AS SELECT * FROM events WHERE false;",
            )?;
            {
                let mut statement=legacy.prepare("SELECT product_id,event_id,name,source,event_time,received_at,actor_id,identity_kind,session_id,cast(properties AS VARCHAR) FROM events WHERE product_id=?")?;
                let mut rows = statement.query([&id])?;
                let mut appender = tx.appender("migration_buffer")?;
                while let Some(r) = rows.next()? {
                    appender.append_row(params![
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, String>(9)?,
                        id
                    ])?;
                }
                appender.flush()?;
            }
            imported += tx.execute(
                "INSERT INTO events SELECT * FROM migration_buffer ON CONFLICT DO NOTHING",
                [],
            )?;
            tx.execute_batch("DROP TABLE migration_buffer;")?;
            tx.commit()?;
        }
        Ok(imported)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_is_bounded_and_does_not_evict_active_connections() {
        let dir = tempfile::tempdir().unwrap();
        let db = ProductDatabases::new(dir.path().to_path_buf()).unwrap();
        let mut leases = Vec::new();
        for _ in 0..MAX_OPEN {
            leases.push(db.connection(&uuid::Uuid::new_v4().to_string()).unwrap());
        }
        assert!(db.connection(&uuid::Uuid::new_v4().to_string()).is_err());
        leases.pop();
        assert!(db.connection(&uuid::Uuid::new_v4().to_string()).is_ok());
        assert_eq!(db.cache.lock().unwrap().len(), MAX_OPEN);
    }
    #[test]
    fn legacy_import_is_idempotent_and_files_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.duckdb");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(SCHEMA).unwrap();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        for id in [&a, &b] {
            old.execute(
                "INSERT INTO events VALUES (?,'same','test','cli',1,2,NULL,NULL,NULL,'{\"n\":3}')",
                [id],
            )
            .unwrap();
        }
        drop(old);
        let db = ProductDatabases::new(dir.path().join("products")).unwrap();
        assert_eq!(db.import_legacy(&path).unwrap(), 2);
        assert_eq!(db.import_legacy(&path).unwrap(), 0);
        for id in [a, b] {
            let lease = db.connection(&id).unwrap();
            let count: i64 = lease
                .connection
                .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1);
            let stored: String = lease
                .connection
                .query_row("SELECT product_id FROM events", [], |r| r.get(0))
                .unwrap();
            assert_eq!(stored, id);
            assert!(db.path(&id).unwrap().exists());
        }
    }
}
