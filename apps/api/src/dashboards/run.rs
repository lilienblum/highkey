//! Widget runs: the effective window, series built from measured queries, and `run_widget`,
//! which measures them under the widget's deadline.
use super::{
    error::DashboardError,
    formula,
    metrics::{
        self, Bucket, GroupValue, Measured, Point, Shape, Window, log_measure_name, measure_name,
        missing_is_zero,
    },
    spec::{Color, Compare, QuerySpec, ViewKind, Widget},
    validate::{Issue, Limits, Report, check_widget, parse_widget, range_hours},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use chrono::{DateTime, Duration, Utc};
use duckdb::Connection;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const LOG_RANGE_DAYS: i64 = 31;
const EVENT_RANGE_DAYS: i64 = 366;
const HOURLY_RANGE_DAYS: i64 = 31;
const GROUPED_SERIES: usize = 6;
const DEFAULT_RANKING_LIMIT: usize = 10;
const CYCLE: [Color; 3] = [Color::Yellow, Color::Violet, Color::Aqua];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub widget: Value,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub bucket: Option<String>,
    pub source_id: Option<String>,
}

#[derive(Debug)]
pub struct EffectiveWindow {
    pub window: Window,
    /// The range before clamping (after the widget's own `range` override).
    pub requested: (DateTime<Utc>, DateTime<Utc>),
    pub clamped: bool,
    pub warnings: Vec<Issue>,
}

fn warning(path: &str, message: String, hint: Option<&str>) -> Issue {
    Issue {
        path: path.into(),
        message,
        hint: hint.map(str::to_string),
    }
}

/// The window a widget runs over: the widget's range override, clamped to what every query
/// allows, with a bucket the clamped range permits. Clamping is never an error.
pub fn effective_window(
    widget: &Widget,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket: Option<&str>,
) -> EffectiveWindow {
    let mut from = from;
    if let Some(hours) = widget.range.as_deref().and_then(range_hours) {
        from = to - Duration::hours(hours as i64);
    }
    let requested = (from, to);
    let mut warnings = Vec::new();

    let has_logs = widget
        .queries
        .values()
        .any(|q| matches!(q, QuerySpec::Logs(_)));
    let days = if has_logs {
        LOG_RANGE_DAYS
    } else {
        EVENT_RANGE_DAYS
    };
    let clamped = to - from > Duration::days(days);
    if clamped {
        from = to - Duration::days(days);
        warnings.push(warning(
            "/range",
            format!("Newest {days} days"),
            Some("The range is longer than this widget's queries allow, so it shows the newest window."),
        ));
    }

    let span = to - from;
    let auto = Bucket::auto(span);
    let explicit = widget
        .view
        .bucket
        .as_deref()
        .filter(|b| *b != "auto")
        .or(bucket.filter(|b| *b != "auto"));
    let bucket = match explicit {
        Some("hour") if span > Duration::days(HOURLY_RANGE_DAYS) => {
            warnings.push(warning(
                "/view/bucket",
                format!(
                    "Bucket hour is not allowed for this range; using {}",
                    auto.as_str()
                ),
                None,
            ));
            auto
        }
        Some("hour") => Bucket::Hour,
        Some("day") => Bucket::Day,
        Some("week") => Bucket::Week,
        Some("month") => Bucket::Month,
        _ => auto,
    };
    EffectiveWindow {
        window: Window { from, to, bucket },
        requested,
        clamped,
        warnings,
    }
}

/// The equal-length span ending where `window` starts, with the same bucket.
pub fn previous(window: &Window) -> Window {
    let span = window.to - window.from;
    Window {
        from: window.from - span,
        to: window.from,
        bucket: window.bucket,
    }
}

#[derive(Debug, Serialize)]
pub struct SeriesResult {
    pub label: String,
    pub color: Color,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<Value>,
    pub total: Option<f64>,
    pub previous_total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<Point>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_points: Option<Vec<Point>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<GroupValue>>,
}

fn grouped_time_series(widget: &Widget) -> bool {
    let grouped = match widget.queries.values().next() {
        Some(QuerySpec::Events(q)) => q.group_by.is_some(),
        Some(QuerySpec::Logs(q)) => q.group_by.is_some(),
        None => false,
    };
    grouped
        && matches!(
            widget.view.kind,
            ViewKind::Line | ViewKind::Area | ViewKind::Bar
        )
}

/// How the first query is shaped, and whether the widget draws one series per group over time.
/// The caller measures every other query for the labels the first one returns.
pub fn shape_for(widget: &Widget) -> (Shape, bool) {
    if grouped_time_series(widget) {
        return (Shape::GroupedBuckets { labels: Vec::new() }, true);
    }
    let shape = match widget.view.kind {
        ViewKind::Ranking => Shape::Groups {
            limit: widget.view.limit.map_or(DEFAULT_RANKING_LIMIT, usize::from),
            labels: None,
        },
        ViewKind::Line | ViewKind::Area | ViewKind::Bar => Shape::Buckets,
        ViewKind::Stat if widget.view.sparkline == Some(true) => Shape::Buckets,
        _ => Shape::Total,
    };
    (shape, false)
}

fn measure_of(q: &QuerySpec) -> &'static str {
    match q {
        QuerySpec::Events(q) => measure_name(&q.measure),
        QuerySpec::Logs(q) => log_measure_name(&q.measure),
    }
}

fn fill(value: Option<f64>, measure: &str) -> Option<f64> {
    value.or(missing_is_zero(measure).then_some(0.0))
}

fn label_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Everything one evaluation pass reads: the widget's queries with their measures.
struct Run<'a> {
    measures: Vec<(&'a str, &'static str)>,
}

impl Run<'_> {
    fn measure(&self, id: &str) -> &'static str {
        self.measures
            .iter()
            .find(|(q, _)| *q == id)
            .map_or("", |(_, m)| m)
    }

    fn eval(
        &self,
        expr: &formula::Expr,
        set: &IndexMap<String, Measured>,
        value: impl Fn(&Measured) -> Option<f64>,
    ) -> Option<f64> {
        expr.eval(&|id| {
            let measured = set.get(id)?;
            fill(value(measured), self.measure(id))
        })
    }

    fn totals(&self, expr: &formula::Expr, set: &IndexMap<String, Measured>) -> Option<f64> {
        self.eval(expr, set, |m| m.total)
    }

    fn points(&self, expr: &formula::Expr, set: &IndexMap<String, Measured>) -> Vec<Point> {
        let times: BTreeSet<i64> = set
            .values()
            .flat_map(|m| m.points.iter().map(|p| p.time))
            .collect();
        times
            .into_iter()
            .map(|time| Point {
                time,
                value: self.eval(expr, set, |m| {
                    m.points
                        .iter()
                        .find(|p| p.time == time)
                        .and_then(|p| p.value)
                }),
            })
            .collect()
    }

    fn group_points(
        &self,
        expr: &formula::Expr,
        set: &IndexMap<String, Measured>,
        label: &Value,
    ) -> Vec<Point> {
        let series = |m: &Measured| {
            m.grouped
                .iter()
                .find(|(l, _)| l == label)
                .map(|(_, p)| p.clone())
        };
        let times: BTreeSet<i64> = set
            .values()
            .filter_map(series)
            .flat_map(|points| points.into_iter().map(|p| p.time))
            .collect();
        times
            .into_iter()
            .map(|time| Point {
                time,
                value: self.eval(expr, set, |m| {
                    series(m)?.into_iter().find(|p| p.time == time)?.value
                }),
            })
            .collect()
    }

    fn group_value(
        &self,
        expr: &formula::Expr,
        set: &IndexMap<String, Measured>,
        label: &Value,
    ) -> Option<f64> {
        self.eval(expr, set, |m| {
            m.groups.iter().find(|g| &g.label == label)?.value
        })
    }
}

/// Turns per-query measurements into the widget's series. A missing bucket or group counts as
/// zero for count, actors and sum, and stays a gap for every other measure.
pub fn evaluate(
    widget: &Widget,
    current: &IndexMap<String, Measured>,
    previous: Option<&IndexMap<String, Measured>>,
) -> Vec<SeriesResult> {
    let run = Run {
        measures: widget
            .queries
            .iter()
            .map(|(id, q)| (id.as_str(), measure_of(q)))
            .collect(),
    };
    let known: Vec<&str> = widget.queries.keys().map(String::as_str).collect();
    let first = widget.queries.keys().next().and_then(|id| current.get(id));
    let grouped = grouped_time_series(widget);
    let ranking = widget.view.kind == ViewKind::Ranking;
    let limit = widget.view.limit.map_or(DEFAULT_RANKING_LIMIT, usize::from);

    let mut out = Vec::new();
    for (index, series) in widget.series_or_default().iter().enumerate() {
        // Validation guarantees the expression parses; an unparsable one draws nothing.
        let Ok(expr) = formula::parse(&series.expr, &known) else {
            continue;
        };
        let label = series.label.clone().unwrap_or_else(|| series.expr.clone());
        let color = series.color.unwrap_or(CYCLE[index % CYCLE.len()]);
        let result = |label: String, color: Color| SeriesResult {
            label,
            color,
            group: None,
            total: None,
            previous_total: None,
            points: None,
            previous_points: None,
            groups: None,
        };

        if grouped {
            let labels: Vec<&Value> = first
                .map(|m| m.grouped.iter().map(|(l, _)| l).collect())
                .unwrap_or_default();
            for (i, group) in labels.into_iter().take(GROUPED_SERIES).enumerate() {
                let mut r = result(label_text(group), CYCLE[i % CYCLE.len()]);
                r.group = Some(group.clone());
                r.points = Some(run.group_points(&expr, current, group));
                out.push(r);
            }
            continue;
        }

        let mut r = result(label, color);
        r.total = run.totals(&expr, current);
        r.previous_total = previous.and_then(|p| run.totals(&expr, p));
        if ranking {
            let rows = first.map(|m| m.groups.as_slice()).unwrap_or_default();
            r.groups = Some(
                rows.iter()
                    .take(limit)
                    .map(|row| GroupValue {
                        label: row.label.clone(),
                        value: run.group_value(&expr, current, &row.label),
                    })
                    .collect(),
            );
        } else if current.values().any(|m| !m.points.is_empty()) {
            r.points = Some(run.points(&expr, current));
            r.previous_points = previous
                .filter(|p| p.values().any(|m| !m.points.is_empty()))
                .map(|p| run.points(&expr, p));
        }
        out.push(r);
    }
    out
}

const LIST_ROWS: usize = 50;
const BUCKETS: [&str; 5] = ["auto", "hour", "day", "week", "month"];

/// The leased connections one run measures on, with the scope every query shares.
struct Measurer<'a> {
    product: &'a str,
    source: Option<&'a str>,
    events: Option<&'a mut Connection>,
    logs: Option<&'a mut Connection>,
}

impl Measurer<'_> {
    fn connection<'c>(c: &'c mut Option<&mut Connection>) -> ApiResult<&'c mut Connection> {
        c.as_deref_mut()
            .ok_or_else(|| anyhow::anyhow!("The widget run has no connection for a query").into())
    }

    fn one(&mut self, q: &QuerySpec, w: &Window, shape: &Shape) -> ApiResult<Measured> {
        match q {
            QuerySpec::Events(q) => metrics::events(
                Self::connection(&mut self.events)?,
                self.product,
                q,
                self.source,
                w,
                shape,
            ),
            QuerySpec::Logs(q) => {
                metrics::logs(Self::connection(&mut self.logs)?, q, self.source, w, shape)
            }
        }
    }

    /// Every query over `w`. The first query picks the groups that the others are measured
    /// for: the top six for grouped time series, the ranking's rows for rankings.
    fn all(
        &mut self,
        widget: &Widget,
        w: &Window,
        shape: &Shape,
        grouped: bool,
    ) -> ApiResult<IndexMap<String, Measured>> {
        let mut queries = widget.queries.iter();
        let mut out = IndexMap::new();
        let Some((first_id, first)) = queries.next() else {
            return Ok(out);
        };
        let rest = if grouped {
            let top = Shape::Groups {
                limit: GROUPED_SERIES,
                labels: None,
            };
            let labels = self.one(first, w, &top)?.groups;
            let shape = Shape::GroupedBuckets {
                labels: labels.into_iter().map(|g| g.label).collect(),
            };
            out.insert(first_id.clone(), self.one(first, w, &shape)?);
            shape
        } else {
            let measured = self.one(first, w, shape)?;
            let rest = match shape {
                Shape::Groups {
                    limit,
                    labels: None,
                } => Shape::Groups {
                    limit: *limit,
                    labels: Some(measured.groups.iter().map(|g| g.label.clone()).collect()),
                },
                other => other.clone(),
            };
            out.insert(first_id.clone(), measured);
            rest
        };
        for (id, q) in queries {
            out.insert(id.clone(), self.one(q, w, &rest)?);
        }
        Ok(out)
    }

    /// Rows for an events or logs list view, newest first.
    fn rows(&mut self, widget: &Widget, w: &Window) -> ApiResult<Vec<Value>> {
        match widget.queries.values().next() {
            Some(QuerySpec::Events(q)) => metrics::event_rows(
                Self::connection(&mut self.events)?,
                self.product,
                q,
                self.source,
                w,
                LIST_ROWS,
            ),
            Some(QuerySpec::Logs(q)) => metrics::log_rows(
                Self::connection(&mut self.logs)?,
                q,
                self.source,
                w,
                LIST_ROWS,
            ),
            None => Ok(Vec::new()),
        }
    }
}

/// Validates and runs one widget for a project (by id or slug) and returns its series or rows.
///
/// The widget's `timeout_ms` (default 5,000) counts from the start of the request and covers
/// waiting for a query slot. The request's `source_id` scopes every query without its own.
/// Warnings for event names with no events at all. One `LIMIT 1` probe per named
/// query keeps this cheap; property keys are only checked against the catalog when validating.
fn unknown_events(
    db: &Connection,
    product: &str,
    named: &[(String, String)],
) -> ApiResult<Vec<Issue>> {
    let mut statement = db
        .prepare("SELECT 1 FROM events WHERE product_id = ? AND name = ? LIMIT 1")
        .map_err(anyhow::Error::from)?;
    let mut unknown = Vec::new();
    for (id, name) in named {
        let found = statement
            .exists(duckdb::params![product, name])
            .map_err(anyhow::Error::from)?;
        if !found {
            unknown.push(super::catalog::unknown_event(
                format!("/queries/{id}/event"),
                name,
            ));
        }
    }
    Ok(unknown)
}

pub async fn run_widget(
    state: &AppState,
    project: &str,
    request: RunRequest,
) -> Result<Value, DashboardError> {
    let started = tokio::time::Instant::now();
    let widget = parse_widget(request.widget).map_err(DashboardError::Invalid)?;
    let mut report = Report::default();
    check_widget(&widget, "", &mut report);
    if !report.is_ok() {
        return Err(DashboardError::Invalid(report));
    }
    if request.to <= request.from {
        return Err(ApiError::bad("`to` must be after `from`").into());
    }
    if request
        .bucket
        .as_deref()
        .is_some_and(|b| !BUCKETS.contains(&b))
    {
        return Err(ApiError::bad("bucket must be auto, hour, day, week or month").into());
    }
    let timeout_ms = widget.timeout_ms.unwrap_or(Limits::DEFAULT_TIMEOUT_MS);
    let deadline = started + std::time::Duration::from_millis(timeout_ms);

    let key = project.to_string();
    let source = request.source_id.clone();
    let product = state
        .store
        .state(move |db| {
            let product = crate::store::resolve_product(db, &key)?;
            if let Some(source) = &source {
                crate::sources::get(db, &product.id, source)?;
            }
            Ok(product.id)
        })
        .await?;

    let effective = effective_window(&widget, request.from, request.to, request.bucket.as_deref());
    let (shape, grouped) = shape_for(&widget);
    let events = widget
        .queries
        .values()
        .any(|q| matches!(q, QuerySpec::Events(_)));
    let logs = widget
        .queries
        .values()
        .any(|q| matches!(q, QuerySpec::Logs(_)));
    let list = matches!(widget.view.kind, ViewKind::Events | ViewKind::Logs);
    // Grouped time series carry no previous period; rankings compare totals only.
    let previous_shape = match (&widget.view.compare, grouped, &shape) {
        (Some(Compare::PreviousPeriod), false, Shape::Buckets) => Some(Shape::Buckets),
        (Some(Compare::PreviousPeriod), false, _) => Some(Shape::Total),
        _ => None,
    };

    let id = widget.id.clone();
    let window = effective.window.clone();
    let scope = (product.clone(), request.source_id);
    // Event names to check for existence: at most one per query, so at most 4.
    let named: Vec<(String, String)> = widget
        .queries
        .iter()
        .filter_map(|(id, q)| match q {
            QuerySpec::Events(q) => q.event.clone().map(|name| (id.clone(), name)),
            _ => None,
        })
        .collect();
    let (series, rows, unknown) = if events || logs {
        state
            .store
            .widget_query(product, events, logs, deadline, move |e, l| {
                let unknown = match e.as_deref() {
                    Some(db) => unknown_events(db, &scope.0, &named)?,
                    None => Vec::new(),
                };
                let mut measurer = Measurer {
                    product: &scope.0,
                    source: scope.1.as_deref(),
                    events: e,
                    logs: l,
                };
                if list {
                    return Ok((Vec::new(), Some(measurer.rows(&widget, &window)?), unknown));
                }
                let current = measurer.all(&widget, &window, &shape, grouped)?;
                let before = match &previous_shape {
                    Some(shape) => Some(measurer.all(&widget, &previous(&window), shape, false)?),
                    None => None,
                };
                Ok((evaluate(&widget, &current, before.as_ref()), None, unknown))
            })
            .await
            .map_err(|e| match e {
                // Report the widget's own budget, which is what its author set.
                DashboardError::Timeout { .. } => DashboardError::Timeout {
                    after_ms: timeout_ms,
                },
                e => e,
            })?
    } else {
        // Text widgets read nothing.
        (Vec::new(), None, Vec::new())
    };

    // The run's own warnings say what actually happened, so they replace validation warnings
    // at the same path.
    let mut warnings = effective.warnings;
    for issue in unknown {
        if !warnings.iter().any(|w| w.path == issue.path) {
            warnings.push(issue);
        }
    }
    for issue in report.warnings {
        if !warnings.iter().any(|w| w.path == issue.path) {
            warnings.push(issue);
        }
    }
    Ok(json!({
        "widget": id,
        "range": {
            "from": effective.window.from,
            "to": effective.window.to,
            "bucket": effective.window.bucket.as_str(),
            "clamped": effective.clamped,
            "requested_from": effective.requested.0,
            "requested_to": effective.requested.1,
        },
        "series": series,
        "rows": rows,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(day: &str) -> DateTime<Utc> {
        format!("{day}T00:00:00Z").parse().unwrap()
    }
    fn widget(v: Value) -> Widget {
        super::super::validate::parse_widget(v).unwrap_or_else(|r| panic!("{:?}", r.errors))
    }
    fn events_widget(view: Value, series: Value) -> Widget {
        let mut w = json!({
            "id": "w", "title": "W", "view": view,
            "queries": {
                "errors": {"signal": "events", "event": "err"},
                "requests": {"signal": "events", "event": "req"}
            },
            "series": series
        });
        if w["series"].is_null() {
            w.as_object_mut().unwrap().remove("series");
        }
        widget(w)
    }
    fn widget_with_logs() -> Widget {
        widget(json!({
            "id": "w", "title": "W", "view": {"type": "line"},
            "queries": {"a": {"signal": "logs", "min_level": "error"}}
        }))
    }
    fn widget_with_events() -> Widget {
        widget(json!({
            "id": "w", "title": "W", "view": {"type": "line"},
            "queries": {"a": {"signal": "events", "event": "req"}}
        }))
    }
    fn pts(v: &[(i64, Option<f64>)]) -> Vec<Point> {
        v.iter()
            .map(|(time, value)| Point {
                time: *time,
                value: *value,
            })
            .collect()
    }
    fn total(t: Option<f64>) -> Measured {
        Measured {
            total: t,
            ..Default::default()
        }
    }
    fn set(items: Vec<(&str, Measured)>) -> IndexMap<String, Measured> {
        items.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }
    fn groups(v: &[(Value, f64)]) -> Vec<GroupValue> {
        v.iter()
            .map(|(label, value)| GroupValue {
                label: label.clone(),
                value: Some(*value),
            })
            .collect()
    }
    fn ratio() -> &'static str {
        "errors / requests * 100"
    }

    #[test]
    fn ratio_total_uses_totals_not_bucket_average() {
        let w = events_widget(json!({"type": "stat"}), json!([{"expr": ratio()}]));
        let cur = set(vec![
            (
                "errors",
                Measured {
                    total: Some(20.0),
                    points: pts(&[(1, Some(1.0)), (2, Some(19.0))]),
                    ..Default::default()
                },
            ),
            (
                "requests",
                Measured {
                    total: Some(400.0),
                    points: pts(&[(1, Some(100.0)), (2, Some(300.0))]),
                    ..Default::default()
                },
            ),
        ]);
        let s = evaluate(&w, &cur, None);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].total, Some(5.0));
        assert_eq!(
            s[0].points.as_ref().unwrap(),
            &pts(&[(1, Some(1.0)), (2, Some(19.0 / 300.0 * 100.0))])
        );
    }

    #[test]
    fn buckets_align_by_time_and_missing_follow_measure() {
        let w = events_widget(json!({"type": "line"}), json!([{"expr": ratio()}]));
        let cur = set(vec![
            (
                "errors",
                Measured {
                    points: pts(&[(1, Some(1.0)), (2, Some(2.0))]),
                    ..Default::default()
                },
            ),
            (
                "requests",
                Measured {
                    points: pts(&[(1, Some(10.0))]),
                    ..Default::default()
                },
            ),
        ]);
        let s = evaluate(&w, &cur, None);
        // requests (count) is missing at time 2: 0, so the division is null.
        assert_eq!(
            s[0].points.as_ref().unwrap(),
            &pts(&[(1, Some(10.0)), (2, None)])
        );

        // For avg, a missing bucket stays null even in addition.
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "line"},
            "queries": {
                "a": {"signal": "events", "event": "e", "measure": "avg", "property": "p"},
                "b": {"signal": "events", "event": "e"}
            },
            "series": [{"expr": "a + b"}]
        }));
        let cur = set(vec![
            (
                "a",
                Measured {
                    points: pts(&[(1, Some(1.0))]),
                    ..Default::default()
                },
            ),
            (
                "b",
                Measured {
                    points: pts(&[(1, Some(2.0)), (2, Some(3.0))]),
                    ..Default::default()
                },
            ),
        ]);
        let s = evaluate(&w, &cur, None);
        assert_eq!(
            s[0].points.as_ref().unwrap(),
            &pts(&[(1, Some(3.0)), (2, None)])
        );
    }

    #[test]
    fn ranking_groups_follow_first_query_and_align_by_json_label() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "ranking"},
            "queries": {
                "a": {"signal": "events", "event": "e", "group_by": "property:plan"},
                "b": {"signal": "events", "event": "e", "measure": "avg", "property": "p", "group_by": "property:plan"}
            },
            "series": [{"expr": "a"}, {"expr": "a + b"}]
        }));
        let cur = set(vec![
            (
                "a",
                Measured {
                    total: Some(6.0),
                    groups: groups(&[(json!(1), 3.0), (json!("1"), 2.0), (Value::Null, 1.0)]),
                    ..Default::default()
                },
            ),
            (
                "b",
                Measured {
                    groups: groups(&[(json!("1"), 10.0)]),
                    ..Default::default()
                },
            ),
        ]);
        let s = evaluate(&w, &cur, None);
        let g = s[1].groups.as_ref().unwrap();
        assert_eq!(g.len(), 3);
        assert_eq!((g[0].label.clone(), g[0].value), (json!(1), None));
        assert_eq!((g[1].label.clone(), g[1].value), (json!("1"), Some(12.0)));
        assert_eq!((g[2].label.clone(), g[2].value), (Value::Null, None));
        assert_eq!(s[0].groups.as_ref().unwrap()[0].value, Some(3.0));
    }

    #[test]
    fn grouped_time_series_yield_one_series_per_group_with_cycle_colors() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "line"},
            "queries": {"a": {"signal": "events", "event": "e", "group_by": "property:plan"}},
            "series": [{"expr": "a", "color": "red"}]
        }));
        let labels = [json!("a"), json!(1), Value::Null, json!("d")];
        let cur = set(vec![(
            "a",
            Measured {
                grouped: labels
                    .iter()
                    .map(|l| (l.clone(), pts(&[(1, Some(1.0))])))
                    .collect(),
                ..Default::default()
            },
        )]);
        let s = evaluate(&w, &cur, None);
        assert_eq!(s.len(), 4);
        assert_eq!(
            s.iter().map(|r| r.color).collect::<Vec<_>>(),
            vec![Color::Yellow, Color::Violet, Color::Aqua, Color::Yellow]
        );
        assert_eq!(
            s.iter()
                .map(|r| r.group.clone().unwrap())
                .collect::<Vec<_>>(),
            labels.to_vec()
        );
        assert_eq!(
            s.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(),
            vec!["a", "1", "null", "d"]
        );
        assert_eq!(s[0].points.as_ref().unwrap(), &pts(&[(1, Some(1.0))]));
        let (shape, grouped) = shape_for(&w);
        assert!(grouped && matches!(shape, Shape::GroupedBuckets { .. }));
    }

    #[test]
    fn grouped_time_series_are_capped_at_six() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "bar"},
            "queries": {"a": {"signal": "events", "event": "e", "group_by": "name"}}
        }));
        let cur = set(vec![(
            "a",
            Measured {
                grouped: (0..9).map(|i| (json!(i), pts(&[(1, Some(1.0))]))).collect(),
                ..Default::default()
            },
        )]);
        assert_eq!(evaluate(&w, &cur, None).len(), 6);
    }

    #[test]
    fn default_series_and_labels() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "stat"},
            "queries": {
                "a": {"signal": "events", "event": "e"},
                "b": {"signal": "events", "event": "e"},
                "c": {"signal": "events", "event": "e"},
                "d": {"signal": "events", "event": "e"}
            }
        }));
        let cur = set(vec![
            ("a", total(Some(1.0))),
            ("b", total(Some(2.0))),
            ("c", total(Some(3.0))),
            ("d", total(Some(4.0))),
        ]);
        let s = evaluate(&w, &cur, None);
        assert_eq!(
            s.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c", "d"]
        );
        assert_eq!(
            s.iter().map(|r| r.color).collect::<Vec<_>>(),
            vec![Color::Yellow, Color::Violet, Color::Aqua, Color::Yellow]
        );
        assert_eq!(
            s.iter().map(|r| r.total).collect::<Vec<_>>(),
            vec![Some(1.0), Some(2.0), Some(3.0), Some(4.0)]
        );
    }

    #[test]
    fn explicit_label_and_color_win() {
        let w = events_widget(
            json!({"type": "stat"}),
            json!([{"expr": ratio(), "label": "Error rate", "color": "red"}]),
        );
        let s = evaluate(
            &w,
            &set(vec![
                ("errors", total(Some(1.0))),
                ("requests", total(Some(4.0))),
            ]),
            None,
        );
        assert_eq!(
            (s[0].label.as_str(), s[0].color, s[0].total),
            ("Error rate", Color::Red, Some(25.0))
        );
    }

    #[test]
    fn empty_project_gives_null_ratio_not_error() {
        let w = events_widget(json!({"type": "stat"}), json!([{"expr": ratio()}]));
        let s = evaluate(
            &w,
            &set(vec![
                ("errors", total(Some(0.0))),
                ("requests", total(Some(0.0))),
            ]),
            None,
        );
        assert_eq!(s[0].total, None);
        // metrics may also report no total at all for an empty count.
        let s = evaluate(
            &w,
            &set(vec![("errors", total(None)), ("requests", total(None))]),
            None,
        );
        assert_eq!(s[0].total, None);
    }

    #[test]
    fn previous_period_before_any_data_is_null_not_error() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "stat", "compare": "previous_period"},
            "queries": {
                "avg": {"signal": "events", "event": "e", "measure": "avg", "property": "p"},
                "n": {"signal": "events", "event": "e"}
            },
            "series": [{"expr": "avg"}, {"expr": "n"}]
        }));
        let cur = set(vec![("avg", total(Some(5.0))), ("n", total(Some(7.0)))]);
        let prev = set(vec![("avg", total(None)), ("n", total(None))]);
        let s = evaluate(&w, &cur, Some(&prev));
        assert_eq!((s[0].total, s[0].previous_total), (Some(5.0), None));
        assert_eq!((s[1].total, s[1].previous_total), (Some(7.0), Some(0.0)));
        assert_eq!(evaluate(&w, &cur, None)[1].previous_total, None);
    }

    #[test]
    fn previous_points_are_returned_for_time_series() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "line", "compare": "previous_period"},
            "queries": {"a": {"signal": "events", "event": "e"}}
        }));
        let cur = set(vec![(
            "a",
            Measured {
                total: Some(3.0),
                points: pts(&[(10, Some(3.0))]),
                ..Default::default()
            },
        )]);
        let prev = set(vec![(
            "a",
            Measured {
                total: Some(2.0),
                points: pts(&[(1, Some(2.0))]),
                ..Default::default()
            },
        )]);
        let s = evaluate(&w, &cur, Some(&prev));
        assert_eq!(
            s[0].previous_points.as_ref().unwrap(),
            &pts(&[(1, Some(2.0))])
        );
        assert_eq!(s[0].previous_total, Some(2.0));
    }

    #[test]
    fn ninety_days_with_logs_clamps_whole_widget() {
        let ew = effective_window(
            &widget_with_logs(),
            at("2026-08-16"),
            at("2026-11-14"),
            None,
        );
        assert!(ew.clamped);
        assert_eq!(ew.requested, (at("2026-08-16"), at("2026-11-14")));
        assert_eq!(ew.window.from, at("2026-10-14"));
        assert_eq!(ew.window.to, at("2026-11-14"));
        assert_eq!(ew.window.bucket, Bucket::Day);
        assert_eq!(ew.warnings[0].path, "/range");
        assert!(ew.warnings[0].message.contains("Newest 31 days"));
    }

    #[test]
    fn events_only_widget_clamps_at_366_days_and_explicit_hour_falls_back() {
        let ew = effective_window(
            &widget_with_events(),
            at("2025-10-10"),
            at("2026-11-14"),
            None,
        );
        assert!(ew.clamped);
        assert_eq!(ew.window.from, at("2025-11-13"));
        assert_eq!(ew.window.bucket, Bucket::Month);
        assert_eq!(ew.warnings[0].message, "Newest 366 days");

        let ew = effective_window(
            &widget_with_events(),
            at("2026-09-15"),
            at("2026-11-14"),
            Some("hour"),
        );
        assert!(!ew.clamped);
        assert_eq!(ew.window.bucket, Bucket::Week);
        assert_eq!(ew.warnings.len(), 1);
        assert_eq!(ew.warnings[0].path, "/view/bucket");
        assert_eq!(
            ew.warnings[0].message,
            "Bucket hour is not allowed for this range; using week"
        );

        let ew = effective_window(
            &widget_with_events(),
            at("2026-10-15"),
            at("2026-11-14"),
            Some("hour"),
        );
        assert_eq!(ew.window.bucket, Bucket::Hour);
        assert!(ew.warnings.is_empty());
    }

    #[test]
    fn view_bucket_beats_request_bucket() {
        let w = widget(json!({
            "id": "w", "title": "W", "view": {"type": "line", "bucket": "week"},
            "queries": {"a": {"signal": "events", "event": "e"}}
        }));
        let ew = effective_window(&w, at("2026-11-01"), at("2026-11-14"), Some("day"));
        assert_eq!(ew.window.bucket, Bucket::Week);
    }

    #[test]
    fn widget_range_override_replaces_workspace_range() {
        let w = widget(json!({
            "id": "w", "title": "W", "range": "24h", "view": {"type": "line"},
            "queries": {"a": {"signal": "events", "event": "e"}}
        }));
        let to: DateTime<Utc> = "2026-11-14T12:00:00Z".parse().unwrap();
        let ew = effective_window(&w, at("2026-08-16"), to, None);
        assert_eq!(ew.window.from, to - Duration::hours(24));
        assert_eq!(ew.window.to, to);
        assert_eq!(ew.window.bucket, Bucket::Hour);
        assert!(!ew.clamped);
    }

    #[test]
    fn previous_window_is_adjacent_and_equal_length() {
        let w = Window {
            from: at("2026-11-07"),
            to: at("2026-11-14"),
            bucket: Bucket::Day,
        };
        let p = previous(&w);
        assert_eq!(
            (p.from, p.to, p.bucket),
            (at("2026-10-31"), at("2026-11-07"), Bucket::Day)
        );
    }

    #[test]
    fn shapes_follow_the_view() {
        let first = |view: Value| shape_for(&events_widget(view, Value::Null)).0;
        assert!(matches!(first(json!({"type": "stat"})), Shape::Total));
        assert!(matches!(
            first(json!({"type": "stat", "sparkline": true})),
            Shape::Buckets
        ));
        assert!(matches!(first(json!({"type": "line"})), Shape::Buckets));
        assert!(matches!(
            first(json!({"type": "ranking"})),
            Shape::Groups {
                limit: 10,
                labels: None
            }
        ));
        assert!(matches!(
            first(json!({"type": "ranking", "limit": 3})),
            Shape::Groups { limit: 3, .. }
        ));
    }

    #[test]
    fn run_request_rejects_unknown_fields() {
        let ok =
            json!({"widget": {}, "from": "2026-11-01T00:00:00Z", "to": "2026-11-14T00:00:00Z"});
        assert!(serde_json::from_value::<RunRequest>(ok.clone()).is_ok());
        let mut bad = ok;
        bad["extra"] = json!(1);
        assert!(serde_json::from_value::<RunRequest>(bad).is_err());
    }
}
