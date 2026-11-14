//! What a project holds, in a form a dashboard author (or an agent) can build widgets from:
//! event names and property keys, log facets, sources, retention and the document limits.
//! Every scan is bounded, so the catalog stays cheap on large projects.
use super::{
    spec::{Document, QuerySpec, Widget},
    suggest::nearest,
    validate::{Issue, Report, limits_json},
};
use crate::{AppState, error::ApiResult, logs::model::LEVELS};
use chrono::{Duration, Utc};
use duckdb::{params, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Event names listed, and the number of distinct property keys.
const MAX_KEYS: usize = 100;
/// Newest events sampled for property keys.
const SAMPLE_EVENTS: usize = 1_000;
/// Window the log facets describe.
const LOG_DAYS: i64 = 31;

pub async fn catalog(state: &AppState, project: &str) -> ApiResult<Value> {
    let key = project.to_string();
    let (product, sources, logs_days) = state
        .store
        .state(move |db| {
            let product = crate::store::resolve_product(db, &key)?;
            let sources = crate::sources::list(db, &product.id)?;
            let logs_days = crate::logs::keys::retention(db, &product.id)?;
            Ok((product, sources, logs_days))
        })
        .await?;

    let cutoff = (Utc::now() - Duration::days(product.retention_days)).timestamp_millis();
    let id = product.id.clone();
    let (events, event_columns) = state
        .store
        .query(product.id.clone(), move |db| event_catalog(db, &id, cutoff))
        .await?;

    let store = state.store.clone();
    let id = product.id.clone();
    let permit = store
        .log_query_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| crate::error::ApiError::busy())?;
    let (logs, log_columns) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut lease = store.logs.connection(&id)?;
        log_catalog(&mut lease.connection)
    })
    .await
    .map_err(|e| crate::error::ApiError::from(anyhow::anyhow!(e)))??;

    Ok(json!({
        "project": {"id": product.id, "slug": product.slug, "name": product.name},
        "events": events,
        "logs": logs,
        "sources": sources.iter().map(|s| json!({"id": s.id, "name": s.name})).collect::<Vec<_>>(),
        "retention": {"events_days": product.retention_days, "logs_days": logs_days},
        "sql": {
            "events": event_columns,
            "all_events": event_columns,
            "logs": log_columns,
            "all_logs": log_columns,
            "tables": super::sql::TABLES
                .iter()
                .map(|(name, database, scoped, description)| json!({
                    "name": name,
                    "database": database.table(),
                    "scoped": scoped,
                    "description": description,
                }))
                .collect::<Vec<_>>(),
            "parameters": super::sql::PARAMETERS,
            "functions": super::sql::FUNCTIONS
                .iter()
                .map(|(name, call, description)| json!({
                    "name": name, "call": call, "description": description,
                }))
                .collect::<Vec<_>>(),
        },
        "limits": limits_json(),
    }))
}

/// The columns of `table` as SQL queries see them, as `{ name, type }`.
fn columns(tx: &duckdb::Transaction, table: &'static str) -> ApiResult<Vec<Value>> {
    tx.prepare(&format!(
        "SELECT name, type FROM pragma_table_info('{table}') ORDER BY cid"
    ))
    .map_err(anyhow::Error::from)?
    .query_map([], |r| {
        Ok(json!({"name": r.get::<_, String>(0)?, "type": r.get::<_, String>(1)?}))
    })
    .map_err(anyhow::Error::from)?
    .collect::<duckdb::Result<Vec<_>>>()
    .map_err(|e| anyhow::Error::from(e).into())
}

fn event_catalog(
    db: &mut duckdb::Connection,
    product: &str,
    cutoff: i64,
) -> ApiResult<(Value, Vec<Value>)> {
    let tx = db.transaction().map_err(anyhow::Error::from)?;
    let table = columns(&tx, "events")?;
    let names = tx
        .prepare(&format!(
            "SELECT DISTINCT name FROM events WHERE product_id = ? AND event_time >= ?
            ORDER BY name LIMIT {MAX_KEYS}"
        ))
        .map_err(anyhow::Error::from)?
        .query_map(params![product, cutoff], |r| r.get::<_, String>(0))
        .map_err(anyhow::Error::from)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;

    // The same approach as the log attribute facets, over the newest events only.
    let mut statement = tx
        .prepare(&format!(
            "WITH recent AS (
                SELECT properties FROM events WHERE product_id = ? AND event_time >= ?
                ORDER BY event_time DESC LIMIT {SAMPLE_EVENTS}
            ),
            keyed AS (SELECT unnest(json_keys(properties)) AS key, properties FROM recent)
            SELECT key,
                json_type(json_extract(properties, '/' || replace(replace(key, '~', '~0'), '/', '~1'))) AS kind,
                count(*) AS count
            FROM keyed GROUP BY key, kind"
        ))
        .map_err(anyhow::Error::from)?;
    // key -> (total, count of the leading scalar type, that type)
    let mut keys: BTreeMap<String, (i64, i64, &'static str)> = BTreeMap::new();
    for row in statement
        .query_map(params![product, cutoff], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(anyhow::Error::from)?
    {
        let (key, kind, count) = row.map_err(anyhow::Error::from)?;
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
    let mut keys: Vec<_> = keys
        .into_iter()
        .filter(|(_, (_, _, kind))| !kind.is_empty())
        .collect();
    keys.sort_by(|a, b| b.1.0.cmp(&a.1.0).then_with(|| a.0.cmp(&b.0)));
    let properties: Vec<Value> = keys
        .into_iter()
        .take(MAX_KEYS)
        .map(|(key, (count, _, kind))| json!({"key": key, "type": kind, "count": count}))
        .collect();
    Ok((json!({"names": names, "properties": properties}), table))
}

fn log_catalog(db: &mut duckdb::Connection) -> ApiResult<(Value, Vec<Value>)> {
    let tx = db.transaction().map_err(anyhow::Error::from)?;
    let table = columns(&tx, "logs")?;
    let base = "timestamp >= ?";
    let values = [SqlValue::BigInt(
        (Utc::now() - Duration::days(LOG_DAYS)).timestamp_millis(),
    )];
    let mut facets = crate::logs::query::facets(&tx, base, &values)?;
    let present = tx
        .prepare(&format!("SELECT DISTINCT level FROM logs WHERE {base}"))
        .map_err(anyhow::Error::from)?
        .query_map(params_from_iter(values.iter()), |r| r.get::<_, String>(0))
        .map_err(anyhow::Error::from)?
        .collect::<duckdb::Result<BTreeSet<_>>>()
        .map_err(anyhow::Error::from)?;
    // Least to most severe, as the log levels are ordered.
    let levels: Vec<&str> = LEVELS
        .iter()
        .copied()
        .filter(|l| present.contains(*l))
        .collect();
    facets["levels"] = json!(levels);
    Ok((facets, table))
}

fn issue(path: String, message: String, hint: &str) -> Issue {
    Issue {
        path,
        message,
        hint: Some(hint.into()),
    }
}

/// The warning for an event name that has no events behind it. `known` are the event names the
/// project does have, which the name is compared with for a "did you mean".
pub fn unknown_event<'a>(
    path: String,
    name: &str,
    known: impl IntoIterator<Item = &'a str>,
) -> Issue {
    issue(
        path,
        format!("No events named \"{name}\" have been received for this project"),
        &spelling(
            name,
            known,
            "Check the spelling against the catalog's events.names; the widget runs and stays empty until such events arrive",
        ),
    )
}

/// `hint`, led by "did you mean" when `name` is a near miss of one of `known`.
fn spelling<'a>(name: &str, known: impl IntoIterator<Item = &'a str>, hint: &str) -> String {
    match nearest(name, known) {
        Some(close) => format!("did you mean `{close}`? {hint}"),
        None => hint.to_string(),
    }
}

fn strings<'a>(catalog: &'a Value, pointer: &str, field: Option<&str>) -> BTreeSet<&'a str> {
    catalog
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| match field {
            Some(field) => v.get(field).and_then(Value::as_str),
            None => v.as_str(),
        })
        .collect()
}

/// Adds warnings, never errors, for event names and property keys that the catalog does not
/// list. A catalog list that reached its cap is incomplete, so it warns about nothing.
pub fn warn_unknown(widget: &Widget, base: &str, catalog: &Value, report: &mut Report) {
    let names = strings(catalog, "/events/names", None);
    let properties = strings(catalog, "/events/properties", Some("key"));
    let names_complete = names.len() < MAX_KEYS;
    let properties_complete = properties.len() < MAX_KEYS;
    let property = |report: &mut Report, path: String, key: &str| {
        if properties_complete && !properties.contains(key) {
            report.warnings.push(issue(
                path,
                format!("No recent events carry a property \"{key}\""),
                &spelling(
                    key,
                    properties.iter().copied(),
                    "Check the spelling against the catalog's events.properties (newest 1,000 events)",
                ),
            ));
        }
    };
    for (id, query) in &widget.queries {
        let QuerySpec::Events(q) = query else {
            continue;
        };
        let at = format!("{base}/queries/{id}");
        if let Some(name) = &q.event
            && names_complete
            && !names.contains(name.as_str())
        {
            report.warnings.push(unknown_event(
                format!("{at}/event"),
                name,
                names.iter().copied(),
            ));
        }
        if let Some(key) = &q.property {
            property(report, format!("{at}/property"), key);
        }
        if let Some(key) = q
            .group_by
            .as_deref()
            .and_then(|g| g.strip_prefix("property:"))
        {
            property(report, format!("{at}/group_by"), key);
        }
        for (i, filter) in q.filters.iter().enumerate() {
            property(
                report,
                format!("{at}/filters/{i}/property"),
                &filter.property,
            );
        }
    }
}

/// `warn_unknown` over every widget of a document.
pub fn warn_unknown_document(document: &Document, catalog: &Value, report: &mut Report) {
    for (i, widget) in document.widgets.iter().enumerate() {
        warn_unknown(widget, &format!("/widgets/{i}"), catalog, report);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn widget(queries: Value) -> Widget {
        super::super::validate::parse_widget(json!({
            "id": "w", "title": "W", "view": {"type": "stat"}, "queries": queries,
            "series": [{"expr": "a"}]
        }))
        .unwrap_or_else(|r| panic!("{:?}", r.errors))
    }

    #[test]
    fn warn_unknown_flags_missing_names_and_property_keys_only_as_warnings() {
        let catalog = json!({
            "events": {
                "names": ["checkout"],
                "properties": [{"key": "plan", "type": "string", "count": 2}]
            }
        });
        let w = widget(json!({
            "a": {
                "signal": "events", "event": "checkot", "measure": "sum", "property": "amout",
                "group_by": "property:plna",
                "filters": [{"property": "plan", "op": "eq", "value": "pro"},
                            {"property": "tier", "op": "eq", "value": "x"}]
            },
            "b": {"signal": "events", "event": "checkout"},
            "c": {"signal": "logs", "service": "nowhere"}
        }));
        let mut report = Report::default();
        warn_unknown(&w, "", &catalog, &mut report);
        assert!(report.errors.is_empty());
        let paths: Vec<_> = report.warnings.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/queries/a/event",
                "/queries/a/property",
                "/queries/a/group_by",
                "/queries/a/filters/1/property"
            ]
        );

        let mut report = Report::default();
        warn_unknown(&w, "/widgets/3", &catalog, &mut report);
        assert_eq!(report.warnings[0].path, "/widgets/3/queries/a/event");
    }

    #[test]
    fn unknown_names_and_properties_suggest_the_nearest_known_one() {
        let catalog = json!({
            "events": {
                "names": ["checkout", "signup"],
                "properties": [{"key": "plan", "type": "string", "count": 2}]
            }
        });
        let w = widget(json!({
            "a": {
                "signal": "events", "event": "checkot", "measure": "sum", "property": "amout",
                "filters": [{"property": "plna", "op": "eq", "value": "pro"}]
            },
            "b": {"signal": "events", "event": "unrelated-name"}
        }));
        let mut report = Report::default();
        warn_unknown(&w, "", &catalog, &mut report);
        let hint = |path: &str| {
            report
                .warnings
                .iter()
                .find(|i| i.path == path)
                .and_then(|i| i.hint.clone())
                .unwrap_or_default()
        };
        assert!(hint("/queries/a/event").starts_with("did you mean `checkout`? "));
        assert!(hint("/queries/a/filters/0/property").starts_with("did you mean `plan`? "));
        // Nothing close, nothing suggested.
        assert!(hint("/queries/b/event").starts_with("Check the spelling"));
        assert!(hint("/queries/a/property").starts_with("Check the spelling"));
    }

    #[test]
    fn warn_unknown_trusts_a_capped_list() {
        let names: Vec<String> = (0..MAX_KEYS).map(|i| format!("e{i}")).collect();
        let catalog = json!({"events": {"names": names, "properties": []}});
        let w = widget(json!({"a": {"signal": "events", "event": "later"}}));
        let mut report = Report::default();
        warn_unknown(&w, "", &catalog, &mut report);
        assert!(report.warnings.is_empty());
    }
}
