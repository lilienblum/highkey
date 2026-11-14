//! Measures behind dashboard widgets: events aggregates over a window.
use super::spec::{EventMeasure, EventsQuery};
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
        source_id: source.map(str::to_string).or_else(|| q.source_id.clone()),
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
}
