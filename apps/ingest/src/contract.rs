//! What the ingest app needs from ClickHouse: a recent enough server, and a schema whose
//! contract version is at least the one this build writes. Newer contracts are accepted,
//! because migrations only ever add (expand, then contract in a later release).
use crate::clickhouse::{ChError, ClickHouse};
use serde::Deserialize;

/// The contract this build reads and writes.
pub const CONTRACT_VERSION: u32 = 5;
/// The oldest ClickHouse server accepted, as (major, minor).
pub const MIN_CLICKHOUSE: (u32, u32) = (25, 8);

#[derive(Debug)]
pub enum ContractError {
    ServerTooOld { found: String, minimum: String },
    ContractTooOld { found: u32, required: u32 },
    Unreachable(String),
}

impl std::fmt::Display for ContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ServerTooOld { found, minimum } => write!(
                f,
                "ClickHouse {found} is too old; upgrade it to {minimum} or newer"
            ),
            Self::ContractTooOld { found, required } => write!(
                f,
                "The ClickHouse schema is at contract {found} but this ingest app needs {required}; run the dashboard's migrations (`bun run migrate`) first"
            ),
            Self::Unreachable(message) => write!(f, "Cannot check ClickHouse: {message}"),
        }
    }
}

impl std::error::Error for ContractError {}

fn version(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn unreachable(e: ChError) -> ContractError {
    ContractError::Unreachable(e.message)
}

pub async fn check(ch: &ClickHouse) -> Result<(), ContractError> {
    #[derive(Deserialize)]
    struct Server {
        version: String,
    }
    #[derive(Deserialize)]
    struct Contract {
        version: Option<u32>,
    }
    let server = ch
        .select_json::<Server>("SELECT version() AS version", &[])
        .await
        .map_err(unreachable)?;
    let found = server
        .into_iter()
        .next()
        .map(|s| s.version)
        .unwrap_or_default();
    if version(&found).is_none_or(|v| v < MIN_CLICKHOUSE) {
        return Err(ContractError::ServerTooOld {
            found,
            minimum: format!("{}.{}", MIN_CLICKHOUSE.0, MIN_CLICKHOUSE.1),
        });
    }
    let contract = ch
        .select_json::<Contract>(
            "SELECT max(version) AS version FROM highkey.ingest_contract",
            &[],
        )
        .await
        .map_err(|e| {
            // An unknown database or table means the migrations never ran.
            if matches!(e.code, Some(60) | Some(81)) {
                ContractError::ContractTooOld {
                    found: 0,
                    required: CONTRACT_VERSION,
                }
            } else {
                unreachable(e)
            }
        })?;
    let found = contract
        .into_iter()
        .next()
        .and_then(|c| c.version)
        .unwrap_or(0);
    if found < CONTRACT_VERSION {
        return Err(ContractError::ContractTooOld {
            found,
            required: CONTRACT_VERSION,
        });
    }
    Ok(())
}
