use crate::{
    error::{ApiError, ApiResult},
    store::Store,
};
use chrono::{DateTime, Utc};
use duckdb::{Connection, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub source_id: Option<String>,
    pub level: Option<String>,
    pub service: Option<String>,
    pub environment: Option<String>,
    pub search: Option<String>,
    pub trace_id: Option<String>,
    pub filters: Option<Vec<Filter>>,
    pub cursor: Option<Cursor>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub timestamp: i64,
    pub log_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub attribute: String,
    pub value: Value,
}
impl Query {
    fn validate(&self) -> ApiResult<()> {
        if self.to <= self.from || self.to - self.from > chrono::Duration::days(31) {
            return Err(ApiError::bad(
                "Log query range must be positive and at most 31 days",
            ));
        }
        if self
            .level
            .as_ref()
            .is_some_and(|s| !super::model::LEVELS.contains(&s.as_str()))
        {
            return Err(ApiError::bad("Invalid log level"));
        }
        for text in [&self.service, &self.environment, &self.trace_id] {
            if text.as_ref().is_some_and(|s| s.is_empty() || s.len() > 128) {
                return Err(ApiError::bad("Filter values require 1–128 bytes"));
            }
        }
        if self.search.as_ref().is_some_and(|s| s.len() > 512) {
            return Err(ApiError::bad("Search is limited to 512 bytes"));
        }
        if self.cursor.as_ref().is_some_and(|c| {
            !crate::model::valid_key(&c.log_id)
                || c.timestamp < self.from.timestamp_millis()
                || c.timestamp >= self.to.timestamp_millis()
        }) {
            return Err(ApiError::bad("Invalid log cursor"));
        }
        if self.filters.as_ref().is_some_and(|filters| {
            filters.len() > 8
                || filters.iter().any(|f| {
                    f.attribute.is_empty()
                        || f.attribute.len() > 128
                        || !matches!(
                            f.value,
                            Value::String(_) | Value::Number(_) | Value::Bool(_)
                        )
                        || f.value.as_str().is_some_and(|s| s.len() > 512)
                })
        }) {
            return Err(ApiError::bad(
                "Provide at most eight typed scalar attribute filters",
            ));
        }
        Ok(())
    }
}
pub async fn run(store: Arc<Store>, project: String, query: Query) -> ApiResult<Value> {
    query.validate()?;
    let id = project.clone();
    let source = query.source_id.clone();
    store
        .state(move |db| {
            crate::store::product(db, &id)?;
            if let Some(source) = source {
                crate::sources::get(db, &id, &source)?;
            }
            Ok(())
        })
        .await?;
    let permit = store
        .log_query_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::busy())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut lease = store.logs.connection(&project)?;
        execute(&mut lease.connection, query)
    })
    .await
    .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?
}
fn execute(db: &mut Connection, query: Query) -> ApiResult<Value> {
    let tx = db.transaction().map_err(anyhow::Error::from)?;
    let mut conditions = vec!["timestamp >= ?".to_string(), "timestamp < ?".to_string()];
    let mut values = vec![
        SqlValue::BigInt(query.from.timestamp_millis()),
        SqlValue::BigInt(query.to.timestamp_millis()),
    ];
    // Facets describe the whole window for this source, independent of the other filters, so
    // each selector can always offer the alternatives. Older (cursor) pages do not repeat them.
    let facets = if query.cursor.is_none() {
        let mut base = conditions.clone();
        let mut base_values = values.clone();
        if let Some(source) = &query.source_id {
            base.push("source_id = ?".into());
            base_values.push(SqlValue::Text(source.clone()));
        }
        facets(&tx, &base.join(" AND "), &base_values)?
    } else {
        Value::Null
    };
    for (column, value) in [
        ("source_id", &query.source_id),
        ("level", &query.level),
        ("service", &query.service),
        ("environment", &query.environment),
        ("trace_id", &query.trace_id),
    ] {
        if let Some(value) = value {
            conditions.push(format!("{column} = ?"));
            values.push(SqlValue::Text(value.clone()));
        }
    }
    if let Some(search) = query.search.as_ref().filter(|s| !s.is_empty()) {
        conditions.push("contains(lower(message), lower(?))".into());
        values.push(SqlValue::Text(search.clone()));
    }
    for filter in query.filters.as_deref().unwrap_or_default() {
        conditions.push("json_extract(attributes, ?) = ?::JSON".into());
        values.push(SqlValue::Text(format!(
            "/{}",
            filter.attribute.replace('~', "~0").replace('/', "~1")
        )));
        values.push(SqlValue::Text(filter.value.to_string()));
    }
    let where_sql = conditions.join(" AND ");
    let bucket = ((query.to - query.from).num_milliseconds() / 60).max(1);
    let mut series_values = vec![
        SqlValue::BigInt(query.from.timestamp_millis()),
        SqlValue::BigInt(bucket),
    ];
    series_values.extend(values.iter().cloned());
    let mut series = vec![json!({"time":0,"count":0,"errors":0}); 60];
    for (index, item) in series.iter_mut().enumerate() {
        item["time"] = json!(query.from.timestamp_millis() + index as i64 * bucket);
    }
    // Aggregate both summaries over one scan; derive the total from the complete histogram.
    let mut statement = tx
        .prepare(&format!(
            "
        WITH summary AS MATERIALIZED (
            SELECT least(59,floor((timestamp-?)/?)::INTEGER) AS bucket,
                service, count(*) AS count,
                count(*) FILTER (WHERE level IN ('error','fatal')) AS errors
            FROM logs WHERE {where_sql}
            GROUP BY GROUPING SETS ((bucket), (service))
        )
        SELECT bucket,service,count,errors FROM summary WHERE bucket IS NOT NULL
        UNION ALL
        (SELECT bucket,service,count,errors FROM summary WHERE bucket IS NULL
            ORDER BY count DESC,service LIMIT 50)
        ORDER BY bucket NULLS LAST,count DESC,service
    "
        ))
        .map_err(anyhow::Error::from)?;
    let mut total = 0_i64;
    let mut services = Vec::new();
    for row in statement
        .query_map(params_from_iter(series_values.iter()), |r| {
            Ok((
                r.get::<_, Option<usize>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(anyhow::Error::from)?
    {
        let (index, service, count, errors) = row.map_err(anyhow::Error::from)?;
        if let Some(index) = index {
            total += count;
            if let Some(item) = series.get_mut(index) {
                item["count"] = json!(count);
                item["errors"] = json!(errors);
            }
        } else if let Some(service) = service {
            services.push(json!({"name":service,"count":count}));
        }
    }
    drop(statement);
    if let Some(cursor) = &query.cursor {
        conditions.push("(timestamp < ? OR (timestamp = ? AND log_id < ?))".into());
        values.extend([
            SqlValue::BigInt(cursor.timestamp),
            SqlValue::BigInt(cursor.timestamp),
            SqlValue::Text(cursor.log_id.clone()),
        ]);
    }
    let mut statement = tx.prepare(&format!("SELECT log_id,source_id,timestamp,received_at,level,message,service,environment,trace_id,span_id,request_id,cast(attributes AS VARCHAR) FROM logs WHERE {} ORDER BY timestamp DESC,log_id DESC LIMIT 101", conditions.join(" AND "))).map_err(anyhow::Error::from)?;
    let mut logs: Vec<Value> = statement.query_map(params_from_iter(values.iter()), |r| {
        let attributes = r.get::<_,String>(11)?;
        Ok(json!({"log_id":r.get::<_,String>(0)?,"source_id":r.get::<_,String>(1)?,"timestamp":r.get::<_,i64>(2)?,"received_at":r.get::<_,i64>(3)?,"level":r.get::<_,String>(4)?,"message":r.get::<_,String>(5)?,"service":r.get::<_,String>(6)?,"environment":r.get::<_,Option<String>>(7)?,"trace_id":r.get::<_,Option<String>>(8)?,"span_id":r.get::<_,Option<String>>(9)?,"request_id":r.get::<_,Option<String>>(10)?,"attributes":serde_json::from_str::<Value>(&attributes).map_err(|_| duckdb::Error::InvalidQuery)?}))
    }).map_err(anyhow::Error::from)?.collect::<duckdb::Result<_>>().map_err(anyhow::Error::from)?;
    drop(statement);
    let more = logs.len() > 100;
    logs.truncate(100);
    let cursor = if more {
        logs.last()
            .map(|log| json!({"timestamp":log["timestamp"],"log_id":log["log_id"]}))
    } else {
        None
    };
    tx.commit().map_err(anyhow::Error::from)?;
    Ok(
        json!({"logs":logs,"next_cursor":cursor,"total":total,"series":series,"services":services,"facets":facets}),
    )
}

/// Known services and environments in the window, and top-level attribute keys with the scalar
/// type their values usually have. Attribute keys come from the newest 1,000 records so the cost
/// stays bounded while Follow refreshes.
fn facets(tx: &duckdb::Transaction, base: &str, values: &[SqlValue]) -> ApiResult<Value> {
    const LIMIT: usize = 50;
    let mut services = Vec::new();
    let mut environments = Vec::new();
    let mut statement = tx
        .prepare(&format!(
            "SELECT GROUPING_ID(service, environment) AS kind, service, environment, count(*) AS count
            FROM logs WHERE {base}
            GROUP BY GROUPING SETS ((service), (environment))
            ORDER BY kind, count DESC, service, environment"
        ))
        .map_err(anyhow::Error::from)?;
    for row in statement
        .query_map(params_from_iter(values.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(anyhow::Error::from)?
    {
        let (kind, service, environment, count) = row.map_err(anyhow::Error::from)?;
        match (kind, service, environment) {
            (1, Some(name), _) if services.len() < LIMIT => {
                services.push(json!({"name":name,"count":count}))
            }
            (2, _, Some(name)) if environments.len() < LIMIT => {
                environments.push(json!({"name":name,"count":count}))
            }
            _ => {}
        }
    }
    drop(statement);
    let mut statement = tx
        .prepare(&format!(
            "WITH recent AS (
                SELECT attributes FROM logs WHERE {base} ORDER BY timestamp DESC LIMIT 1000
            ),
            keyed AS (SELECT unnest(json_keys(attributes)) AS key, attributes FROM recent)
            SELECT key,
                json_type(json_extract(attributes, '/' || replace(replace(key, '~', '~0'), '/', '~1'))) AS kind,
                count(*) AS count
            FROM keyed GROUP BY key, kind"
        ))
        .map_err(anyhow::Error::from)?;
    let mut keys: std::collections::BTreeMap<String, (i64, i64, &'static str)> =
        std::collections::BTreeMap::new();
    for row in statement
        .query_map(params_from_iter(values.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(anyhow::Error::from)?
    {
        let (key, kind, count) = row.map_err(anyhow::Error::from)?;
        // Only scalar values support typed equality filters.
        let scalar = match kind.as_deref() {
            Some("VARCHAR") => "string",
            Some("BIGINT" | "UBIGINT" | "DOUBLE") => "number",
            Some("BOOLEAN") => "boolean",
            _ => "",
        };
        let entry = keys.entry(key).or_insert((0, 0, ""));
        entry.0 += count;
        if !scalar.is_empty() && count > entry.1 {
            entry.1 = count;
            entry.2 = scalar;
        }
    }
    let mut attributes: Vec<_> = keys
        .into_iter()
        .filter(|(_, (_, _, kind))| !kind.is_empty())
        .collect();
    attributes.sort_by(|a, b| b.1.0.cmp(&a.1.0).then_with(|| a.0.cmp(&b.0)));
    let attributes: Vec<Value> = attributes
        .into_iter()
        .take(100)
        .map(|(key, (count, _, kind))| json!({"key":key,"type":kind,"count":count}))
        .collect();
    Ok(json!({"services":services,"environments":environments,"attributes":attributes}))
}
