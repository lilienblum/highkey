//! Exact deduplication over a recent window. Retries arrive within seconds, so checking the
//! last day of received rows catches every real retry without scanning all history. Anything
//! older that slips through is merged away by `ReplacingMergeTree`, keeping the first copy.
use crate::clickhouse::{ChError, ClickHouse, array_param};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

pub const DEDUP_WINDOW: Duration = Duration::from_secs(86_400);

/// The most the encoded `ids` parameter of one lookup may take. Values travel in the URL, and the
/// HTTP client refuses a URL over 64 KiB, so a large batch is looked up in pieces, leaving room
/// for the rest of the query string.
const MAX_IDS_PARAM_BYTES: usize = 60_000;

/// How many bytes `id` adds to the encoded `ids` parameter: its quotes and comma, and the id,
/// where every byte but the few a form encoding leaves alone takes three.
fn encoded_len(id: &str) -> usize {
    9 + id
        .bytes()
        .map(|b| match b {
            b'\\' | b'\'' => 6,
            b if b.is_ascii_alphanumeric() || b"*-._".contains(&b) => 1,
            _ => 3,
        })
        .sum::<usize>()
}

/// Which of `ids` the product already stored, among rows received since `since`.
pub async fn existing(
    ch: &ClickHouse,
    table: &str,
    id_column: &str,
    product: Uuid,
    ids: &[&str],
    since: DateTime<Utc>,
) -> Result<HashSet<String>, ChError> {
    let mut found = HashSet::new();
    let mut start = 0;
    while start < ids.len() {
        let mut end = start;
        let mut bytes = 0;
        while end < ids.len()
            && (end == start || bytes + encoded_len(ids[end]) <= MAX_IDS_PARAM_BYTES)
        {
            bytes += encoded_len(ids[end]);
            end += 1;
        }
        found.extend(lookup(ch, table, id_column, product, &ids[start..end], since).await?);
        start = end;
    }
    Ok(found)
}

async fn lookup(
    ch: &ClickHouse,
    table: &str,
    id_column: &str,
    product: Uuid,
    ids: &[&str],
    since: DateTime<Utc>,
) -> Result<Vec<String>, ChError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoded_length_bounds_the_real_encoding() {
        for id in ["plain-id_1.2", "with/slash", "quote'and\\back", "ünïcode"] {
            let encoded: String =
                reqwest::Url::parse_with_params("http://x/", &[("p", array_param(&[id]))])
                    .unwrap()
                    .query()
                    .unwrap()
                    .trim_start_matches("p=")
                    .to_string();
            // The array's brackets are not counted per id; the comma is, though a lone id has none.
            assert!(encoded.len() - 6 + 3 <= encoded_len(id), "{id}: {encoded}");
        }
    }
}
