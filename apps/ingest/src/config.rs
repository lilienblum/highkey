use std::{env, path::PathBuf};

#[derive(Clone, Debug)]
pub struct ClickHouseConfig {
    pub url: String,
    pub user: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub clickhouse: ClickHouseConfig,
    /// Requests that may wait for a write, across all products (1–1024).
    pub queue_capacity: usize,
    /// The browser tracker served at `/tracker.js`, if any.
    pub tracker_path: Option<PathBuf>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            clickhouse: ClickHouseConfig {
                url: env::var("PIKO_CLICKHOUSE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8123".into()),
                user: env::var("PIKO_CLICKHOUSE_USER").unwrap_or_else(|_| "piko_ingest".into()),
                password: env::var("PIKO_CLICKHOUSE_PASSWORD").unwrap_or_default(),
            },
            queue_capacity: env::var("PIKO_QUEUE_CAPACITY")
                .unwrap_or_else(|_| "64".into())
                .parse()?,
            tracker_path: env::var_os("PIKO_TRACKER_PATH").map(PathBuf::from),
        })
    }
}
