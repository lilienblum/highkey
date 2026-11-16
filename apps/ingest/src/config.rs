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

/// The ingest app's ClickHouse password: `PIKO_INGEST_CLICKHOUSE_PASSWORD`, the name the dashboard's
/// migrate job sets it from, so one secret store can hold it beside the dashboard's admin password,
/// else `PIKO_CLICKHOUSE_PASSWORD`.
pub fn ingest_password(lookup: impl Fn(&str) -> Option<String>) -> String {
    lookup("PIKO_INGEST_CLICKHOUSE_PASSWORD")
        .or_else(|| lookup("PIKO_CLICKHOUSE_PASSWORD"))
        .unwrap_or_default()
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            clickhouse: ClickHouseConfig {
                url: env::var("PIKO_CLICKHOUSE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8123".into()),
                user: env::var("PIKO_CLICKHOUSE_USER").unwrap_or_else(|_| "piko_ingest".into()),
                password: ingest_password(|name| env::var(name).ok()),
            },
            queue_capacity: env::var("PIKO_QUEUE_CAPACITY")
                .unwrap_or_else(|_| "64".into())
                .parse()?,
            tracker_path: env::var_os("PIKO_TRACKER_PATH").map(PathBuf::from),
        })
    }
}

#[cfg(test)]
mod password_tests {
    use super::ingest_password;

    #[test]
    fn the_ingest_password_has_its_own_name_and_falls_back_to_the_generic_one() {
        let both = |name: &str| match name {
            "PIKO_INGEST_CLICKHOUSE_PASSWORD" => Some("ingest".to_string()),
            "PIKO_CLICKHOUSE_PASSWORD" => Some("admin".to_string()),
            _ => None,
        };
        // A shared secret store holds the dashboard's admin password too; the ingest app's wins.
        assert_eq!(ingest_password(both), "ingest");
        let generic = |name: &str| (name == "PIKO_CLICKHOUSE_PASSWORD").then(|| "only".to_string());
        assert_eq!(ingest_password(generic), "only");
        assert_eq!(ingest_password(|_| None), "");
    }
}
