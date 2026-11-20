//! Ingestion keys come from `highkey.ingest_keys`, which the dashboard mirrors from its own
//! store. Lookups are cached briefly: a found key for five seconds, a missing one for one, so
//! a revoked key stops working within five seconds and a new key works within one.
use crate::{
    clickhouse::ClickHouse,
    error::{ApiError, ApiResult},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const FOUND_TTL: Duration = Duration::from_secs(5);
pub const MISSING_TTL: Duration = Duration::from_secs(1);
pub const CAPACITY: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyKind {
    Events,
    Logs,
}

#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub product_id: Uuid,
    pub source_id: Uuid,
    pub allowed_origins: Vec<String>,
    pub retention_days: u16,
    pub server_key: bool,
    pub allow_browser_revenue: bool,
}

#[derive(Deserialize)]
struct Row {
    kind: KeyKind,
    product_id: Uuid,
    source_id: Uuid,
    allowed_origins: Vec<String>,
    retention_days: u16,
    revoked: u8,
    server_key: u8,
    allow_browser_revenue: u8,
}

struct Entry {
    at: Instant,
    found: Option<(KeyKind, KeyRecord)>,
}

impl Entry {
    fn fresh(&self, now: Instant) -> bool {
        let ttl = if self.found.is_some() {
            FOUND_TTL
        } else {
            MISSING_TTL
        };
        now.duration_since(self.at) < ttl
    }
}

#[derive(Clone)]
pub struct Keys {
    clickhouse: ClickHouse,
    cache: Arc<Mutex<HashMap<String, Entry>>>,
}

pub fn hash(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}

impl Keys {
    pub fn new(clickhouse: ClickHouse) -> Self {
        Self {
            clickhouse,
            cache: Arc::default(),
        }
    }

    async fn lookup(&self, hash: &str) -> ApiResult<Option<(KeyKind, KeyRecord)>> {
        let rows = self
            .clickhouse
            .select_json::<Row>(
                "SELECT k.kind AS kind, k.product_id AS product_id, k.source_id AS source_id, k.allowed_origins AS allowed_origins, k.retention_days AS retention_days, k.revoked AS revoked, ifNull(p.server_key, 0) AS server_key, ifNull(p.allow_browser_revenue, 0) AS allow_browser_revenue FROM highkey.ingest_keys k LEFT JOIN (SELECT * FROM highkey.ingest_key_policies WHERE hash = {hash:String}) p USING (hash, product_id) WHERE k.hash = {hash:String}",
                &[("hash", hash.to_string())],
            )
            .await?;
        Ok(rows.into_iter().find(|row| row.revoked == 0).map(|row| {
            (
                row.kind,
                KeyRecord {
                    product_id: row.product_id,
                    source_id: row.source_id,
                    allowed_origins: row.allowed_origins,
                    retention_days: row.retention_days,
                    server_key: row.server_key != 0,
                    allow_browser_revenue: row.allow_browser_revenue != 0,
                },
            )
        }))
    }

    /// The key's record, if it exists, is not revoked, and is a key of `kind`.
    pub async fn resolve(&self, bearer: &str, kind: KeyKind) -> ApiResult<KeyRecord> {
        let hash = hash(bearer);
        let now = Instant::now();
        let cached = {
            let cache = self.cache.lock().expect("key cache");
            cache
                .get(&hash)
                .filter(|entry| entry.fresh(now))
                .map(|entry| entry.found.clone())
        };
        let found = match cached {
            Some(found) => found,
            None => {
                let found = self.lookup(&hash).await?;
                let mut cache = self.cache.lock().expect("key cache");
                if cache.len() >= CAPACITY {
                    cache.retain(|_, entry| entry.fresh(now));
                    if cache.len() >= CAPACITY {
                        cache.clear();
                    }
                }
                cache.insert(
                    hash,
                    Entry {
                        at: Instant::now(),
                        found: found.clone(),
                    },
                );
                found
            }
        };
        match found {
            Some((found_kind, record))
                if found_kind == kind && (bearer.starts_with("sk_") == record.server_key) =>
            {
                Ok(record)
            }
            _ => Err(ApiError::unauthorized()),
        }
    }
}
