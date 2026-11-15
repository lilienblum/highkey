//! Exact deduplication over a recent window. Retries arrive within seconds, so checking the
//! last day of received rows catches every real retry without scanning all history. Anything
//! older that slips through is merged away by `ReplacingMergeTree`, keeping the first copy.
use crate::clickhouse::{ChError, ClickHouse, array_param};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

pub const DEDUP_WINDOW: Duration = Duration::from_secs(86_400);

/// Which of `ids` the product already stored, among rows received since `since`.
pub async fn existing(
    ch: &ClickHouse,
    table: &str,
    id_column: &str,
    product: Uuid,
    ids: &[&str],
    since: DateTime<Utc>,
) -> Result<HashSet<String>, ChError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    #[derive(Deserialize)]
    struct Found {
        id: String,
    }
    let sql = format!(
        "SELECT DISTINCT {id_column} AS id FROM {table} WHERE product_id = {{product:UUID}} AND {id_column} IN {{ids:Array(String)}} AND received_at >= fromUnixTimestamp64Milli({{since:Int64}}, 'UTC')"
    );
    let rows = ch
        .select_json::<Found>(
            &sql,
            &[
                ("product", product.to_string()),
                ("ids", array_param(ids)),
                ("since", since.timestamp_millis().to_string()),
            ],
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.id).collect())
}
