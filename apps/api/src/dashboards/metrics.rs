//! Measures behind dashboard widgets: events aggregates over a window.
use super::spec::{EventMeasure, EventsQuery, LogMeasure, LogsQuery};
use crate::logs::model::LEVELS;
use crate::{
    error::{ApiError, ApiResult},
    query::{Query, agg, property},
};
use chrono::{DateTime, Utc};
use duckdb::{Connection, Transaction, params_from_iter, types::Value as DbValue};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    Hour,
    Day,
    Week,
    Month,
}
impl Bucket {
    pub fn as_str(self) -> &'static str {
        match self {
            Bucket::Hour => "hour",
            Bucket::Day => "day",
            Bucket::Week => "week",
            Bucket::Month => "month",
        }
    }
    /// Same thresholds as the dashboard's `automaticBucket`.
    pub fn auto(span: chrono::Duration) -> Bucket {
        if span <= chrono::Duration::days(2) {
            Bucket::Hour
        } else if span <= chrono::Duration::days(31) {
            Bucket::Day
        } else if span <= chrono::Duration::days(180) {
            Bucket::Week
        } else {
            Bucket::Month
        }
    }
}

#[derive(Clone, Debug)]
pub struct Window {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub bucket: Bucket,
}

#[derive(Clone, Debug)]
pub enum Shape {
    Total,
    Buckets,
    Groups {
        limit: usize,
        labels: Option<Vec<Value>>,
    },
    GroupedBuckets {
        labels: Vec<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Point {
    pub time: i64,
    pub value: Option<f64>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GroupValue {
    pub label: Value,
    pub value: Option<f64>,
}
#[derive(Clone, Debug, Default)]
pub struct Measured {
    pub total: Option<f64>,
    pub points: Vec<Point>,
    pub groups: Vec<GroupValue>,
    pub grouped: Vec<(Value, Vec<Point>)>,
}

/// Empty buckets read as zero for counting measures and as gaps otherwise.
pub fn missing_is_zero(measure: &str) -> bool {
    ["count", "actors", "sum"].contains(&measure)
}

fn measure_name(m: &EventMeasure) -> &'static str {
    match m {
        EventMeasure::Count => "count",
        EventMeasure::Actors => "actors",
        EventMeasure::Sum => "sum",
        EventMeasure::Avg => "avg",
        EventMeasure::P50 => "p50",
        EventMeasure::P95 => "p95",
        EventMeasure::Min => "min",
        EventMeasure::Max => "max",
    }
}

fn build_query(
    q: &EventsQuery,
    source: Option<&str>,
    w: &Window,
    page_size: usize,
) -> ApiResult<Query> {
    let measure = measure_name(&q.measure);
    if measure != "count" && measure != "actors" {
        property(
            q.property
                .as_deref()
                .ok_or_else(|| ApiError::bad("Numeric measures need a property"))?,
        )?;
    }
    Ok(Query {
        from: w.from,
        to: w.to,
        bucket: w.bucket.as_str().into(),
        event: q.event.clone(),
        source: None,
        source_id: q.source_id.clone().or_else(|| source.map(str::to_string)),
        identity_kind: q.identity_kind.clone(),
        measure: measure.into(),
        property: q.property.clone(),
        group_by: q.group_by.clone(),
        filters: q.filters.clone(),
        page: 0,
        page_size,
    })
}

fn group_expr(q: &Query) -> ApiResult<String> {
    Ok(match q.group_by.as_deref().unwrap_or("name") {
        "name" => "to_json(name)".to_string(),
        "source" => "to_json(source)".to_string(),
        "source_id" => "to_json(source_id)".to_string(),
        "identity_kind" => "to_json(identity_kind)".to_string(),
        s if s.starts_with("property:") => property(&s[9..])?,
        _ => {
            return Err(ApiError::bad(
                "Group by name, source, source_id, identity_kind or property:<key>",
            ));
        }
    })
}

fn db_err(e: duckdb::Error) -> ApiError {
    anyhow::Error::from(e).into()
}

fn bucket_points(
    tx: &Transaction,
    q: &Query,
    measure: &str,
    pred: &str,
    values: &[DbValue],
) -> ApiResult<Vec<Point>> {
    // The bucket comes from `Bucket::as_str`, an allowlist.
    let bucket = &q.bucket;
    let missing = if missing_is_zero(&q.measure) {
        "0.0"
    } else {
        "NULL"
    };
    let mut stmt = tx
        .prepare(&format!(
            "WITH buckets AS (
                SELECT epoch_ms(t) AS time FROM generate_series(
                    date_trunc('{bucket}', epoch_ms(?)),
                    epoch_ms(?) - INTERVAL '1 millisecond',
                    INTERVAL '1 {bucket}'
                ) AS ticks(t)
             ), measured AS (
                SELECT epoch_ms(date_trunc('{bucket}', epoch_ms(event_time))) AS time,
                       cast({measure} AS DOUBLE) AS value
                FROM events WHERE {pred} GROUP BY time
             )
             SELECT buckets.time, CASE WHEN measured.time IS NULL THEN {missing} ELSE measured.value END
             FROM buckets LEFT JOIN measured USING (time) ORDER BY buckets.time"
        ))
        .map_err(db_err)?;
    let params = [
        DbValue::BigInt(q.from.timestamp_millis()),
        DbValue::BigInt(q.to.timestamp_millis()),
    ]
    .into_iter()
    .chain(values.iter().cloned());
    stmt.query_map(params_from_iter(params), |r| {
        Ok(Point {
            time: r.get(0)?,
            value: r.get(1)?,
        })
    })
    .map_err(db_err)?
    .collect::<duckdb::Result<Vec<_>>>()
    .map_err(db_err)
}

pub fn events(
    db: &mut Connection,
    product: &str,
    q: &EventsQuery,
    source: Option<&str>,
    w: &Window,
    shape: &Shape,
) -> ApiResult<Measured> {
    let query = build_query(q, source, w, 1)?;
    let (pred, values) = query.predicate(product)?;
    let measure = agg(&query);
    let tx = db.transaction().map_err(db_err)?;
    let total = tx
        .query_row(
            &format!("SELECT cast({measure} AS DOUBLE) FROM events WHERE {pred}"),
            params_from_iter(values.iter()),
            |r| r.get::<_, Option<f64>>(0),
        )
        .map_err(db_err)?;
    let mut out = Measured {
        total,
        ..Measured::default()
    };
    match shape {
        Shape::Total => {}
        Shape::Buckets => out.points = bucket_points(&tx, &query, &measure, &pred, &values)?,
        Shape::Groups { limit, labels } => {
            let group = group_expr(&query)?;
            let label = format!("coalesce(cast({group} AS VARCHAR), 'null')");
            let mut sql = format!(
                "SELECT {label} AS label, cast({measure} AS DOUBLE) AS value FROM events WHERE {pred}"
            );
            let mut params = values.clone();
            if let Some(labels) = labels {
                if labels.is_empty() {
                    return Ok(out);
                }
                let marks = vec!["?"; labels.len()].join(", ");
                sql += &format!(" AND {label} IN ({marks})");
                params.extend(labels.iter().map(|l| DbValue::Text(l.to_string())));
            }
            sql += &format!(" GROUP BY label ORDER BY value DESC NULLS LAST, label LIMIT {limit}");
            let mut stmt = tx.prepare(&sql).map_err(db_err)?;
            out.groups = stmt
                .query_map(params_from_iter(params.iter()), |r| {
                    let raw: String = r.get(0)?;
                    Ok(GroupValue {
                        label: serde_json::from_str(&raw).unwrap_or(Value::Null),
                        value: r.get(1)?,
                    })
                })
                .map_err(db_err)?
                .collect::<duckdb::Result<Vec<_>>>()
                .map_err(db_err)?;
        }
        Shape::GroupedBuckets { labels } => {
            let group = group_expr(&query)?;
            let label = format!("coalesce(cast({group} AS VARCHAR), 'null')");
            let narrowed = format!("{pred} AND {label} = ?");
            for l in labels {
                let mut params = values.clone();
                params.push(DbValue::Text(l.to_string()));
                let points = bucket_points(&tx, &query, &measure, &narrowed, &params)?;
                out.grouped.push((l.clone(), points));
            }
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(out)
}

/// Event rows in the `/query` JSON shape, newest first.
pub fn event_rows(
    db: &mut Connection,
    product: &str,
    q: &EventsQuery,
    source: Option<&str>,
    w: &Window,
    limit: usize,
) -> ApiResult<Vec<Value>> {
    let query = build_query(q, source, w, limit)?;
    let (pred, values) = query.predicate(product)?;
    let tx = db.transaction().map_err(db_err)?;
    let rows = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT event_id,name,source,event_time,received_at,actor_id,identity_kind,session_id,cast(properties AS VARCHAR),source_id FROM events WHERE {pred} ORDER BY event_time DESC,event_id DESC LIMIT {limit}"
            ))
            .map_err(db_err)?;
        stmt.query_map(params_from_iter(values.iter()), |r| {
            let props: String = r.get(8)?;
            Ok(json!({
                "source_id": r.get::<_, String>(9)?,
                "event_id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?,
                "timestamp": r.get::<_, i64>(3)?,
                "received_at": r.get::<_, i64>(4)?,
                "actor_id": r.get::<_, Option<String>>(5)?,
                "identity_kind": r.get::<_, Option<String>>(6)?,
                "session_id": r.get::<_, Option<String>>(7)?,
                "properties": serde_json::from_str::<Value>(&props).unwrap_or(Value::Null),
            }))
        })
        .map_err(db_err)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(db_err)?
    };
    tx.commit().map_err(db_err)?;
    Ok(rows)
}

fn log_measure_name(m: &LogMeasure) -> &'static str {
    match m {
        LogMeasure::Count => "count",
        LogMeasure::Sum => "sum",
        LogMeasure::Avg => "avg",
        LogMeasure::P50 => "p50",
        LogMeasure::P95 => "p95",
        LogMeasure::Min => "min",
        LogMeasure::Max => "max",
    }
}

/// A SQL fragment and the parameters its placeholders consume, in order.
struct Fragment {
    sql: String,
    params: Vec<DbValue>,
}

fn log_measure(q: &LogsQuery) -> ApiResult<(&'static str, Fragment)> {
    let name = log_measure_name(&q.measure);
    if name == "count" {
        return Ok((
            name,
            Fragment {
                sql: "count(*)".into(),
                params: vec![],
            },
        ));
    }
    let attribute = q
        .attribute
        .as_deref()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| ApiError::bad("Numeric measures need an attribute"))?;
    let pointer = crate::logs::query::attribute_pointer(attribute);
    let number = "CASE WHEN json_type(attributes, ?) IN ('BIGINT','UBIGINT','DOUBLE') THEN try_cast(json_extract(attributes, ?) AS DOUBLE) END";
    let sql = match name {
        "sum" | "avg" | "min" | "max" => format!("{name}({number})"),
        "p50" => format!("quantile_cont({number}, 0.5)"),
        _ => format!("quantile_cont({number}, 0.95)"),
    };
    Ok((
        name,
        Fragment {
            sql,
            params: vec![DbValue::Text(pointer.clone()), DbValue::Text(pointer)],
        },
    ))
}

fn log_group(q: &LogsQuery) -> ApiResult<Fragment> {
    let plain = |sql: &str| Fragment {
        sql: sql.into(),
        params: vec![],
    };
    Ok(match q.group_by.as_deref().unwrap_or("service") {
        "service" => plain("to_json(service)"),
        "level" => plain("to_json(level)"),
        "environment" => plain("to_json(environment)"),
        s if s.starts_with("attribute:") && s.len() > "attribute:".len() => Fragment {
            sql: "json_extract(attributes, ?)".into(),
            params: vec![DbValue::Text(crate::logs::query::attribute_pointer(
                &s["attribute:".len()..],
            ))],
        },
        _ => {
            return Err(ApiError::bad(
                "Group by service, level, environment or attribute:<key>",
            ));
        }
    })
}

/// The WHERE clause (window, source, filters) and its parameters for a logs widget query.
fn log_predicate(
    q: &LogsQuery,
    source: Option<&str>,
    w: &Window,
) -> ApiResult<(String, Vec<DbValue>)> {
    let mut conditions = vec!["timestamp >= ?".to_string(), "timestamp < ?".to_string()];
    let mut values = vec![
        DbValue::BigInt(w.from.timestamp_millis()),
        DbValue::BigInt(w.to.timestamp_millis()),
    ];
    let filters: Vec<(String, Value)> = q
        .filters
        .iter()
        .map(|f| (f.attribute.clone(), f.value.clone()))
        .collect();
    let (extra, extra_values) = crate::logs::query::conditions(
        q.source_id.as_deref().or(source),
        q.level.as_deref(),
        q.service.as_deref(),
        q.environment.as_deref(),
        None,
        q.search.as_deref(),
        &filters,
    );
    conditions.extend(extra);
    values.extend(extra_values);
    if let Some(min) = &q.min_level {
        let index = LEVELS
            .iter()
            .position(|l| l == min)
            .ok_or_else(|| ApiError::bad("Invalid log level"))?;
        let levels = &LEVELS[index..];
        conditions.push(format!("level IN ({})", vec!["?"; levels.len()].join(", ")));
        values.extend(levels.iter().map(|l| DbValue::Text((*l).into())));
    }
    Ok((conditions.join(" AND "), values))
}

fn log_bucket_points(
    tx: &Transaction,
    w: &Window,
    name: &str,
    measure: &Fragment,
    pred: &str,
    values: &[DbValue],
) -> ApiResult<Vec<Point>> {
    // The bucket comes from `Bucket::as_str`, an allowlist.
    let bucket = w.bucket.as_str();
    let missing = if missing_is_zero(name) { "0.0" } else { "NULL" };
    let mut stmt = tx
        .prepare(&format!(
            "WITH buckets AS (
                SELECT epoch_ms(t) AS time FROM generate_series(
                    date_trunc('{bucket}', epoch_ms(?)),
                    epoch_ms(?) - INTERVAL '1 millisecond',
                    INTERVAL '1 {bucket}'
                ) AS ticks(t)
             ), measured AS (
                SELECT epoch_ms(date_trunc('{bucket}', epoch_ms(timestamp))) AS time,
                       cast({} AS DOUBLE) AS value
                FROM logs WHERE {pred} GROUP BY time
             )
             SELECT buckets.time, CASE WHEN measured.time IS NULL THEN {missing} ELSE measured.value END
             FROM buckets LEFT JOIN measured USING (time) ORDER BY buckets.time",
            measure.sql
        ))
        .map_err(db_err)?;
    let params = [
        DbValue::BigInt(w.from.timestamp_millis()),
        DbValue::BigInt(w.to.timestamp_millis()),
    ]
    .into_iter()
    .chain(measure.params.iter().cloned())
    .chain(values.iter().cloned());
    stmt.query_map(params_from_iter(params), |r| {
        Ok(Point {
            time: r.get(0)?,
            value: r.get(1)?,
        })
    })
    .map_err(db_err)?
    .collect::<duckdb::Result<Vec<_>>>()
    .map_err(db_err)
}

pub fn logs(
    db: &mut Connection,
    q: &LogsQuery,
    source: Option<&str>,
    w: &Window,
    shape: &Shape,
) -> ApiResult<Measured> {
    let (name, measure) = log_measure(q)?;
    let (pred, values) = log_predicate(q, source, w)?;
    let tx = db.transaction().map_err(db_err)?;
    let total = tx
        .query_row(
            &format!(
                "SELECT cast({} AS DOUBLE) FROM logs WHERE {pred}",
                measure.sql
            ),
            params_from_iter(measure.params.iter().chain(values.iter())),
            |r| r.get::<_, Option<f64>>(0),
        )
        .map_err(db_err)?;
    let mut out = Measured {
        total,
        ..Measured::default()
    };
    match shape {
        Shape::Total => {}
        Shape::Buckets => out.points = log_bucket_points(&tx, w, name, &measure, &pred, &values)?,
        Shape::Groups { limit, labels } => {
            let group = log_group(q)?;
            let label = format!("coalesce(cast({} AS VARCHAR), 'null')", group.sql);
            let mut sql = format!(
                "SELECT {label} AS label, cast({} AS DOUBLE) AS value FROM logs WHERE {pred}",
                measure.sql
            );
            // Placeholders appear as: label, measure, predicate, then the label restriction.
            let mut params = group.params.clone();
            params.extend(measure.params.iter().cloned());
            params.extend(values.iter().cloned());
            if let Some(labels) = labels {
                if labels.is_empty() {
                    return Ok(out);
                }
                let marks = vec!["?"; labels.len()].join(", ");
                sql += &format!(" AND {label} IN ({marks})");
                params.extend(group.params.iter().cloned());
                params.extend(labels.iter().map(|l| DbValue::Text(l.to_string())));
            }
            sql += &format!(" GROUP BY label ORDER BY value DESC NULLS LAST, label LIMIT {limit}");
            let mut stmt = tx.prepare(&sql).map_err(db_err)?;
            out.groups = stmt
                .query_map(params_from_iter(params.iter()), |r| {
                    let raw: String = r.get(0)?;
                    Ok(GroupValue {
                        label: serde_json::from_str(&raw).unwrap_or(Value::Null),
                        value: r.get(1)?,
                    })
                })
                .map_err(db_err)?
                .collect::<duckdb::Result<Vec<_>>>()
                .map_err(db_err)?;
        }
        Shape::GroupedBuckets { labels } => {
            let group = log_group(q)?;
            let label = format!("coalesce(cast({} AS VARCHAR), 'null')", group.sql);
            let narrowed = format!("{pred} AND {label} = ?");
            for l in labels {
                let mut params = values.clone();
                params.extend(group.params.iter().cloned());
                params.push(DbValue::Text(l.to_string()));
                let points = log_bucket_points(&tx, w, name, &measure, &narrowed, &params)?;
                out.grouped.push((l.clone(), points));
            }
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(out)
}

/// Log rows in the `/logs/query` JSON shape, newest first.
pub fn log_rows(
    db: &mut Connection,
    q: &LogsQuery,
    source: Option<&str>,
    w: &Window,
    limit: usize,
) -> ApiResult<Vec<Value>> {
    let (pred, values) = log_predicate(q, source, w)?;
    let tx = db.transaction().map_err(db_err)?;
    let rows = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT log_id,source_id,timestamp,received_at,level,message,service,environment,trace_id,span_id,request_id,cast(attributes AS VARCHAR) FROM logs WHERE {pred} ORDER BY timestamp DESC,log_id DESC LIMIT {limit}"
            ))
            .map_err(db_err)?;
        stmt.query_map(params_from_iter(values.iter()), |r| {
            let attributes: String = r.get(11)?;
            Ok(json!({
                "log_id": r.get::<_, String>(0)?,
                "source_id": r.get::<_, String>(1)?,
                "timestamp": r.get::<_, i64>(2)?,
                "received_at": r.get::<_, i64>(3)?,
                "level": r.get::<_, String>(4)?,
                "message": r.get::<_, String>(5)?,
                "service": r.get::<_, String>(6)?,
                "environment": r.get::<_, Option<String>>(7)?,
                "trace_id": r.get::<_, Option<String>>(8)?,
                "span_id": r.get::<_, Option<String>>(9)?,
                "request_id": r.get::<_, Option<String>>(10)?,
                "attributes": serde_json::from_str::<Value>(&attributes).unwrap_or(Value::Null),
            }))
        })
        .map_err(db_err)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(db_err)?
    };
    tx.commit().map_err(db_err)?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::Filter;

    const S1: &str = "11111111-1111-1111-1111-111111111111";

    fn seed() -> (
        tempfile::TempDir,
        std::sync::Arc<crate::store::Store>,
        String,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path(), 2).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let db = store.analytics.connection(&id).unwrap();
        let rows = [
            ("2026-11-10T10:00:00Z", "/a", 10, Some(json!(1))),
            ("2026-11-10T11:00:00Z", "/a", 30, Some(json!("1"))),
            ("2026-11-12T09:00:00Z", "/a", 50, Some(Value::Null)),
            ("2026-11-12T10:00:00Z", "/b", 70, Some(json!(1))),
            ("2026-11-12T11:00:00Z", "/b", 90, None),
            ("2026-11-13T12:00:00Z", "/a", 20, Some(json!("1"))),
        ];
        for (i, (time, route, duration, plan)) in rows.into_iter().enumerate() {
            let t = DateTime::parse_from_rfc3339(time)
                .unwrap()
                .timestamp_millis();
            let mut props = json!({"route": route, "duration_ms": duration});
            if let Some(plan) = plan {
                props["plan"] = plan;
            }
            db.connection.execute(
                "INSERT INTO events(product_id,event_id,name,source,source_id,event_time,received_at,identity_kind,properties) VALUES (?,?,'checkout_request','web',?,?,?,'visitor',?)",
                duckdb::params![id, (i + 1).to_string(), S1, t, t, props.to_string()],
            ).unwrap();
        }
        (dir, store, id)
    }
    fn window() -> Window {
        Window {
            from: "2026-11-10T00:00:00Z".parse().unwrap(),
            to: "2026-11-14T00:00:00Z".parse().unwrap(),
            bucket: Bucket::Day,
        }
    }
    fn query(v: Value) -> EventsQuery {
        let mut base = json!({"event": "checkout_request"});
        base.as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }
    fn values(points: &[Point]) -> Vec<Option<f64>> {
        points.iter().map(|p| p.value).collect()
    }
    fn some(v: &[f64]) -> Vec<Option<f64>> {
        v.iter().map(|x| Some(*x)).collect()
    }

    #[test]
    fn totals_buckets_and_missing_values() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let m = events(
            &mut db.connection,
            &id,
            &query(json!({})),
            None,
            &window(),
            &Shape::Buckets,
        )
        .unwrap();
        assert_eq!(m.total, Some(6.0));
        assert_eq!(values(&m.points), some(&[2.0, 0.0, 3.0, 1.0]));
        let avg = query(json!({"measure": "avg", "property": "duration_ms"}));
        let m = events(
            &mut db.connection,
            &id,
            &avg,
            None,
            &window(),
            &Shape::Buckets,
        )
        .unwrap();
        assert_eq!(m.points[1].value, None);
        assert_eq!(m.points[0].value, Some(20.0));
    }
    #[test]
    fn groups_respect_limit_and_label_restriction() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let q = query(json!({"group_by": "property:route"}));
        let shape = Shape::Groups {
            limit: 1,
            labels: None,
        };
        let m = events(&mut db.connection, &id, &q, None, &window(), &shape).unwrap();
        assert_eq!(
            m.groups,
            vec![GroupValue {
                label: json!("/a"),
                value: Some(4.0)
            }]
        );
        let shape = Shape::Groups {
            limit: 10,
            labels: Some(vec![json!("/b")]),
        };
        let m = events(&mut db.connection, &id, &q, None, &window(), &shape).unwrap();
        assert_eq!(
            m.groups,
            vec![GroupValue {
                label: json!("/b"),
                value: Some(2.0)
            }]
        );
    }
    #[test]
    fn grouped_buckets_return_one_series_per_label() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let q = query(json!({"group_by": "property:route"}));
        let shape = Shape::GroupedBuckets {
            labels: vec![json!("/a"), json!("/b")],
        };
        let m = events(&mut db.connection, &id, &q, None, &window(), &shape).unwrap();
        assert_eq!(m.grouped.len(), 2);
        assert_eq!(m.grouped[0].0, json!("/a"));
        assert_eq!(values(&m.grouped[0].1), some(&[2.0, 0.0, 1.0, 1.0]));
        assert_eq!(m.grouped[1].0, json!("/b"));
        assert_eq!(values(&m.grouped[1].1), some(&[0.0, 0.0, 2.0, 0.0]));
    }
    #[test]
    fn group_labels_keep_json_types() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let q = query(json!({"group_by": "property:plan"}));
        let shape = Shape::Groups {
            limit: 10,
            labels: None,
        };
        let m = events(&mut db.connection, &id, &q, None, &window(), &shape).unwrap();
        assert_eq!(m.groups.len(), 3);
        for label in [json!(1), json!("1"), Value::Null] {
            let g = m.groups.iter().find(|g| g.label == label).unwrap();
            assert_eq!(g.value, Some(2.0), "{label}");
        }
    }
    #[test]
    fn source_and_filters_narrow() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let other = uuid::Uuid::new_v4().to_string();
        let m = events(
            &mut db.connection,
            &id,
            &query(json!({})),
            Some(&other),
            &window(),
            &Shape::Total,
        )
        .unwrap();
        assert_eq!(m.total, Some(0.0));
        let m = events(
            &mut db.connection,
            &id,
            &query(json!({})),
            Some(S1),
            &window(),
            &Shape::Total,
        )
        .unwrap();
        assert_eq!(m.total, Some(6.0));
        let mut q = query(json!({}));
        q.filters.push(Filter {
            property: "duration_ms".into(),
            op: "gt".into(),
            value: json!(20),
        });
        let m = events(&mut db.connection, &id, &q, None, &window(), &Shape::Total).unwrap();
        assert_eq!(m.total, Some(4.0));
    }
    #[test]
    fn pinned_source_wins_over_workspace_source() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let s2 = uuid::Uuid::new_v4().to_string();
        let pinned = query(json!({"source_id": S1}));
        let m = events(
            &mut db.connection,
            &id,
            &pinned,
            Some(&s2),
            &window(),
            &Shape::Total,
        )
        .unwrap();
        assert_eq!(m.total, Some(6.0));
        let m = events(
            &mut db.connection,
            &id,
            &query(json!({})),
            Some(&s2),
            &window(),
            &Shape::Total,
        )
        .unwrap();
        assert_eq!(m.total, Some(0.0));
        let rows = event_rows(&mut db.connection, &id, &pinned, Some(&s2), &window(), 10).unwrap();
        assert_eq!(rows.len(), 6);
    }
    #[test]
    fn min_and_max_measures() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        for (measure, expected) in [("min", 10.0), ("max", 90.0)] {
            let q = query(json!({"measure": measure, "property": "duration_ms"}));
            let m = events(
                &mut db.connection,
                &id,
                &q,
                None,
                &window(),
                &Shape::Buckets,
            )
            .unwrap();
            assert_eq!(m.total, Some(expected));
            assert_eq!(m.points[1].value, None);
        }
    }
    #[test]
    fn rows_are_newest_first_and_limited() {
        let (_d, store, id) = seed();
        let mut db = store.analytics.connection(&id).unwrap();
        let rows = event_rows(
            &mut db.connection,
            &id,
            &query(json!({})),
            None,
            &window(),
            2,
        )
        .unwrap();
        let ids: Vec<_> = rows
            .iter()
            .map(|r| r["event_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["6", "5"]);
        assert_eq!(rows[0]["properties"]["route"], "/a");
    }

    fn seed_logs() -> (
        tempfile::TempDir,
        std::sync::Arc<crate::store::Store>,
        String,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path(), 2).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let db = store.logs.connection(&id).unwrap();
        let rows = [
            (
                "2026-11-12T10:00:00Z",
                "info",
                "api",
                Some("production"),
                "GET /x ok",
                json!({"duration_ms":10,"route":"/x"}),
            ),
            (
                "2026-11-12T10:01:00Z",
                "warn",
                "api",
                Some("production"),
                "slow",
                json!({"duration_ms":20}),
            ),
            (
                "2026-11-12T10:02:00Z",
                "error",
                "checkout",
                Some("production"),
                "payment failed",
                json!({"duration_ms":30,"route":"/x"}),
            ),
            (
                "2026-11-12T10:03:00Z",
                "fatal",
                "checkout",
                None,
                "panic",
                json!({"duration_ms":"slow"}),
            ),
            (
                "2026-11-13T09:00:00Z",
                "error",
                "api",
                Some("staging"),
                "payment failed",
                json!({"duration_ms":50,"route":"/y"}),
            ),
        ];
        for (i, (time, level, service, env, message, attrs)) in rows.into_iter().enumerate() {
            let t = DateTime::parse_from_rfc3339(time)
                .unwrap()
                .timestamp_millis();
            db.connection.execute(
                "INSERT INTO logs(log_id,source_id,timestamp,received_at,level,message,service,environment,attributes) VALUES (?,?,?,?,?,?,?,?,?)",
                duckdb::params![(i + 1).to_string(), S1, t, t, level, message, service, env, attrs.to_string()],
            ).unwrap();
        }
        (dir, store, id)
    }
    fn log_query(v: Value) -> LogsQuery {
        serde_json::from_value(v).unwrap()
    }
    fn log_total(db: &mut Connection, q: Value) -> Option<f64> {
        logs(db, &log_query(q), None, &window(), &Shape::Total)
            .unwrap()
            .total
    }
    fn group_map(m: &Measured) -> Vec<(Value, Option<f64>)> {
        let mut v: Vec<_> = m
            .groups
            .iter()
            .map(|g| (g.label.clone(), g.value))
            .collect();
        v.sort_by_key(|(l, _)| l.to_string());
        v
    }

    #[test]
    fn min_level_includes_higher_levels() {
        let (_d, store, id) = seed_logs();
        let mut db = store.logs.connection(&id).unwrap();
        let db = &mut db.connection;
        assert_eq!(log_total(db, json!({"min_level": "error"})), Some(3.0));
        assert_eq!(log_total(db, json!({"min_level": "warn"})), Some(4.0));
        assert_eq!(log_total(db, json!({"level": "error"})), Some(2.0));
        assert_eq!(log_total(db, json!({})), Some(5.0));
    }
    #[test]
    fn numeric_attribute_measures() {
        let (_d, store, id) = seed_logs();
        let mut db = store.logs.connection(&id).unwrap();
        let db = &mut db.connection;
        for (measure, expected) in [("avg", 27.5), ("min", 10.0), ("max", 50.0), ("sum", 110.0)] {
            let q = json!({"measure": measure, "attribute": "duration_ms"});
            assert_eq!(log_total(db, q), Some(expected), "{measure}");
        }
        let q = log_query(json!({"measure": "avg", "attribute": "duration_ms"}));
        let m = logs(db, &q, None, &window(), &Shape::Buckets).unwrap();
        assert_eq!(m.points[2].value, Some(20.0));
        assert_eq!(m.points[0].value, None);
        let q = log_query(json!({}));
        let m = logs(db, &q, None, &window(), &Shape::Buckets).unwrap();
        assert_eq!(values(&m.points), some(&[0.0, 0.0, 4.0, 1.0]));
    }
    #[test]
    fn group_by_service_level_environment_and_attribute() {
        let (_d, store, id) = seed_logs();
        let mut db = store.logs.connection(&id).unwrap();
        let db = &mut db.connection;
        let shape = Shape::Groups {
            limit: 10,
            labels: None,
        };
        let run = |db: &mut Connection, by: &str| {
            let q = log_query(json!({"group_by": by}));
            group_map(&logs(db, &q, None, &window(), &shape).unwrap())
        };
        assert_eq!(
            run(db, "service"),
            vec![(json!("api"), Some(3.0)), (json!("checkout"), Some(2.0))]
        );
        assert_eq!(
            run(db, "environment"),
            vec![
                (json!("production"), Some(3.0)),
                (json!("staging"), Some(1.0)),
                (Value::Null, Some(1.0)),
            ]
        );
        assert_eq!(
            run(db, "level"),
            vec![
                (json!("error"), Some(2.0)),
                (json!("fatal"), Some(1.0)),
                (json!("info"), Some(1.0)),
                (json!("warn"), Some(1.0)),
            ]
        );
        assert_eq!(
            run(db, "attribute:route"),
            vec![
                (json!("/x"), Some(2.0)),
                (json!("/y"), Some(1.0)),
                (Value::Null, Some(2.0)),
            ]
        );
        let q = log_query(
            json!({"group_by": "attribute:route", "measure": "max", "attribute": "duration_ms"}),
        );
        let shape = Shape::Groups {
            limit: 10,
            labels: Some(vec![json!("/x")]),
        };
        let m = logs(db, &q, None, &window(), &shape).unwrap();
        assert_eq!(group_map(&m), vec![(json!("/x"), Some(30.0))]);
        let q = log_query(json!({"group_by": "service"}));
        let shape = Shape::GroupedBuckets {
            labels: vec![json!("checkout")],
        };
        let m = logs(db, &q, None, &window(), &shape).unwrap();
        assert_eq!(values(&m.grouped[0].1), some(&[0.0, 0.0, 2.0, 0.0]));
    }
    #[test]
    fn search_and_attribute_filters_narrow() {
        let (_d, store, id) = seed_logs();
        let mut db = store.logs.connection(&id).unwrap();
        let db = &mut db.connection;
        assert_eq!(log_total(db, json!({"search": "payment"})), Some(2.0));
        let q = json!({"filters": [{"attribute": "route", "value": "/x"}]});
        assert_eq!(log_total(db, q), Some(2.0));
    }
    #[test]
    fn pinned_source_wins_and_rows_are_newest_first() {
        let (_d, store, id) = seed_logs();
        let mut db = store.logs.connection(&id).unwrap();
        let db = &mut db.connection;
        let other = uuid::Uuid::new_v4().to_string();
        let q = log_query(json!({}));
        let m = logs(db, &q, Some(&other), &window(), &Shape::Total).unwrap();
        assert_eq!(m.total, Some(0.0));
        let pinned = log_query(json!({"source_id": S1}));
        let m = logs(db, &pinned, Some(&other), &window(), &Shape::Total).unwrap();
        assert_eq!(m.total, Some(5.0));
        let rows = log_rows(db, &pinned, Some(&other), &window(), 2).unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r["log_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["5", "4"]);
        assert_eq!(rows[0]["attributes"]["route"], "/y");
        assert_eq!(rows[1]["environment"], Value::Null);
    }
}
