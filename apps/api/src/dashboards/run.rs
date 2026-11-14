//! Widget runs: the effective window, series built from measured queries, and `run_widget`,
//! which measures them under the widget's deadline.
use super::{
    error::DashboardError,
    formula,
    metrics::{
        self, Bucket, GroupValue, Measured, Point, Shape, Window, log_measure_name, measure_name,
        missing_is_zero,
    },
    spec::{Color, Compare, Missing, QuerySpec, SqlDatabase, SqlQuery, ViewKind, Widget},
    sql::{self, MAX_SQL_ROWS, SqlParams, SqlResult},
    validate::{Issue, Limits, Report, check_widget, parse_widget, range_hours},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::http::StatusCode;
use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use duckdb::Connection;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

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

    let has_logs = widget.queries.values().any(QuerySpec::reads_logs);
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
        Some(QuerySpec::Sql(_)) | None => false,
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

/// Whether an absent bucket or group of `q` counts as zero rather than a gap.
fn fills_zero(q: &QuerySpec) -> bool {
    match q {
        QuerySpec::Events(q) => missing_is_zero(measure_name(&q.measure)),
        QuerySpec::Logs(q) => missing_is_zero(log_measure_name(&q.measure)),
        QuerySpec::Sql(q) => q.missing == Missing::Zero,
    }
}

fn fill(value: Option<f64>, zero: bool) -> Option<f64> {
    value.or(zero.then_some(0.0))
}

fn label_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Everything one evaluation pass reads: the widget's queries, and whether each fills absent
/// values with zero.
struct Run<'a> {
    zero: Vec<(&'a str, bool)>,
}

impl Run<'_> {
    fn zero(&self, id: &str) -> bool {
        self.zero.iter().any(|(q, zero)| *q == id && *zero)
    }

    fn eval(
        &self,
        expr: &formula::Expr,
        set: &IndexMap<String, Measured>,
        value: impl Fn(&Measured) -> Option<f64>,
    ) -> Option<f64> {
        expr.eval(&|id| {
            let measured = set.get(id)?;
            fill(value(measured), self.zero(id))
        })
    }

    fn totals(&self, expr: &formula::Expr, set: &IndexMap<String, Measured>) -> Option<f64> {
        self.eval(expr, set, |m| m.total)
    }

    /// The formula at every time any query has a point. Each query's points are indexed by
    /// time once, so a long series costs linear time, not one scan per point.
    fn points(&self, expr: &formula::Expr, set: &IndexMap<String, Measured>) -> Vec<Point> {
        let series: Vec<(&str, &[Point])> = set
            .iter()
            .map(|(id, m)| (id.as_str(), m.points.as_slice()))
            .collect();
        self.over_time(expr, &series)
    }

    /// `points` for one group of a grouped series. A query without that group has no points,
    /// which counts as zero or a gap like any absent bucket.
    fn group_points(
        &self,
        expr: &formula::Expr,
        set: &IndexMap<String, Measured>,
        label: &Value,
    ) -> Vec<Point> {
        let series: Vec<(&str, &[Point])> = set
            .iter()
            .map(|(id, m)| {
                let points = m.grouped.iter().find(|(l, _)| l == label);
                (id.as_str(), points.map_or(&[][..], |(_, p)| p.as_slice()))
            })
            .collect();
        self.over_time(expr, &series)
    }

    fn over_time(&self, expr: &formula::Expr, series: &[(&str, &[Point])]) -> Vec<Point> {
        let index: Vec<(&str, HashMap<i64, Option<f64>>)> = series
            .iter()
            .map(|(id, points)| {
                let mut at = HashMap::with_capacity(points.len());
                for p in *points {
                    at.entry(p.time).or_insert(p.value);
                }
                (*id, at)
            })
            .collect();
        let times: BTreeSet<i64> = index
            .iter()
            .flat_map(|(_, at)| at.keys().copied())
            .collect();
        times
            .into_iter()
            .map(|time| Point {
                time,
                value: expr.eval(&|id| {
                    let (_, at) = index.iter().find(|(q, _)| *q == id)?;
                    fill(at.get(&time).copied().flatten(), self.zero(id))
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
/// zero for count, actors and sum (and SQL with `missing: zero`), and stays a gap otherwise.
pub fn evaluate(
    widget: &Widget,
    current: &IndexMap<String, Measured>,
    previous: Option<&IndexMap<String, Measured>>,
) -> Vec<SeriesResult> {
    evaluate_as(widget, current, previous, grouped_time_series(widget))
}

/// `evaluate`, told whether the widget draws one series per group, which a grouped SQL query
/// decides by its columns.
pub fn evaluate_as(
    widget: &Widget,
    current: &IndexMap<String, Measured>,
    previous: Option<&IndexMap<String, Measured>>,
    grouped: bool,
) -> Vec<SeriesResult> {
    let run = Run {
        zero: widget
            .queries
            .iter()
            .map(|(id, q)| (id.as_str(), fills_zero(q)))
            .collect(),
    };
    let known: Vec<&str> = widget.queries.keys().map(String::as_str).collect();
    let first = widget.queries.keys().next().and_then(|id| current.get(id));
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

/// The leased connections one run measures on, with the scope every query shares. SQL that
/// fails while running is collected as issues at its `sql` path.
struct Measurer<'a> {
    product: &'a str,
    source: Option<&'a str>,
    events: Option<&'a mut Connection>,
    logs: Option<&'a mut Connection>,
    issues: Vec<Issue>,
    /// SQL queries whose result was cut, with the warning that says where.
    truncated: Vec<(String, String)>,
}

impl Measurer<'_> {
    fn connection<'c>(c: &'c mut Option<&mut Connection>) -> ApiResult<&'c mut Connection> {
        c.as_deref_mut()
            .ok_or_else(|| anyhow::anyhow!("The widget run has no connection for a query").into())
    }

    fn refuse(&mut self, id: &str, message: String, hint: &str) {
        let path = format!("/queries/{id}/sql");
        if !self.issues.iter().any(|i| i.path == path) {
            self.issues.push(Issue {
                path,
                message,
                hint: Some(hint.into()),
            });
        }
    }

    /// Runs one SQL query over `w`, or `None` when it failed (and was recorded as an issue).
    fn sql(&mut self, id: &str, q: &SqlQuery, w: &Window) -> ApiResult<Option<SqlResult>> {
        let params = SqlParams::new(w, self.source);
        let db = match q.database {
            SqlDatabase::Events => Self::connection(&mut self.events)?,
            SqlDatabase::Logs => Self::connection(&mut self.logs)?,
        };
        match sql::execute(db, &q.sql, &params, MAX_SQL_ROWS) {
            Ok(result) => {
                if let Some(warning) = result.warning()
                    && !self.truncated.iter().any(|(t, _)| t == id)
                {
                    self.truncated.push((id.to_string(), warning));
                }
                Ok(Some(result))
            }
            Err(ApiError(StatusCode::BAD_REQUEST, message)) => {
                let hint = "DuckDB stopped this query while running it; fix what the message names";
                self.refuse(id, message, hint);
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    fn one(&mut self, id: &str, q: &QuerySpec, w: &Window, shape: &Shape) -> ApiResult<Measured> {
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
            QuerySpec::Sql(q) => {
                let Some(result) = self.sql(id, q, w)? else {
                    return Ok(Measured::default());
                };
                match sql_measured(&result, q.missing, w, shape) {
                    Ok(measured) => Ok(measured),
                    Err(message) => {
                        let hint = "Aggregate to one row, as with count(*) or sum(...), or use a ranking or table view";
                        self.refuse(id, message, hint);
                        Ok(Measured::default())
                    }
                }
            }
        }
    }

    /// The columns and rows of a table view's one SQL query.
    fn table(&mut self, widget: &Widget, w: &Window) -> ApiResult<Option<(Value, Value)>> {
        let Some((id, QuerySpec::Sql(q))) = widget.queries.first() else {
            return Ok(None);
        };
        let Some(result) = self.sql(id, q, w)? else {
            return Ok(None);
        };
        let columns = result
            .columns
            .iter()
            .map(|(name, kind)| json!({"name": name, "type": kind}))
            .collect();
        Ok(Some((columns, json!(result.rows))))
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
            // A grouped SQL query picks its own six largest groups in one run.
            let measured = if matches!(first, QuerySpec::Sql(_)) {
                let shape = Shape::GroupedBuckets { labels: Vec::new() };
                self.one(first_id, first, w, &shape)?
            } else {
                let top = Shape::Groups {
                    limit: GROUPED_SERIES,
                    labels: None,
                };
                let labels = self.one(first_id, first, w, &top)?.groups;
                let shape = Shape::GroupedBuckets {
                    labels: labels.into_iter().map(|g| g.label).collect(),
                };
                self.one(first_id, first, w, &shape)?
            };
            let shape = Shape::GroupedBuckets {
                labels: measured.grouped.iter().map(|(l, _)| l.clone()).collect(),
            };
            out.insert(first_id.clone(), measured);
            shape
        } else {
            let measured = self.one(first_id, first, w, shape)?;
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
            out.insert(id.clone(), self.one(id, q, w, &rest)?);
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
            Some(QuerySpec::Sql(_)) | None => Ok(Vec::new()),
        }
    }
}

/// The start of every bucket in `w`, as the typed queries' bucket grid has them: from the
/// bucket holding `from` up to `to`, in UTC, with weeks starting on Monday.
fn bucket_starts(w: &Window) -> Vec<i64> {
    let from = w.from.naive_utc();
    let date = from.date();
    let first = match w.bucket {
        Bucket::Hour => date.and_hms_opt(from.hour(), 0, 0),
        Bucket::Day => date.and_hms_opt(0, 0, 0),
        Bucket::Week => (date - Duration::days(i64::from(date.weekday().num_days_from_monday())))
            .and_hms_opt(0, 0, 0),
        Bucket::Month => date.with_day(1).and_then(|d| d.and_hms_opt(0, 0, 0)),
    };
    let mut out = Vec::new();
    let mut at = first.map(|t| t.and_utc());
    while let Some(t) = at.filter(|t| *t < w.to) {
        out.push(t.timestamp_millis());
        at = match w.bucket {
            Bucket::Hour => Some(t + Duration::hours(1)),
            Bucket::Day => Some(t + Duration::days(1)),
            Bucket::Week => Some(t + Duration::days(7)),
            Bucket::Month => t.checked_add_months(chrono::Months::new(1)),
        };
    }
    out
}

/// A row of a time series: its bucket time and value.
type Sample = (i64, Option<f64>);

fn sum(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    values
        .flatten()
        .fold(None, |total, v| Some(total.unwrap_or(0.0) + v))
}

/// Points on the window's bucket grid: each bucket takes the summed value of the rows at its
/// time, an absent one counts as `missing`, and rows off the grid are kept where they are.
fn on_grid(rows: impl Iterator<Item = Sample>, grid: &[i64], missing: Missing) -> Vec<Point> {
    let mut points = std::collections::BTreeMap::new();
    for (time, value) in rows {
        let slot: &mut Option<Option<f64>> = points.entry(time).or_default();
        *slot = Some(sum([slot.flatten(), value].into_iter()));
    }
    let fill = (missing == Missing::Zero).then_some(0.0);
    for time in grid {
        points.entry(*time).or_insert(Some(fill));
    }
    points
        .into_iter()
        .map(|(time, value)| Point {
            time,
            value: value.flatten(),
        })
        .collect()
}

/// What an SQL result measures, by its columns: `value` is a total; `time` and `value` (with
/// an optional `group`) are a time series whose total is the sum of its points; `label` and
/// `value` are groups whose total is their sum. Columns were checked against the view.
fn sql_measured(
    result: &SqlResult,
    missing: Missing,
    w: &Window,
    shape: &Shape,
) -> Result<Measured, String> {
    let column = |name: &str| {
        result
            .columns
            .iter()
            .position(|(n, _)| n.eq_ignore_ascii_case(name))
    };
    let mut out = Measured::default();
    let Some(value) = column("value") else {
        return Ok(out);
    };
    // Exact decimals and integers beyond 2^53 arrive as strings.
    let number = |row: &[Value]| match &row[value] {
        Value::String(text) => text.parse::<f64>().ok().filter(|n| n.is_finite()),
        other => other.as_f64(),
    };
    if let Some(time) = column("time") {
        let grid = bucket_starts(w);
        let rows = || {
            result
                .rows
                .iter()
                .filter_map(|row| Some((row[time].as_i64()?, row)))
        };
        out.total = sum(rows().map(|(_, row)| number(row)));
        let Some(group) = column("group") else {
            out.points = on_grid(rows().map(|(t, row)| (t, number(row))), &grid, missing);
            return Ok(out);
        };
        let mut groups: Vec<(Value, Vec<Sample>)> = Vec::new();
        let mut index = HashMap::new();
        for (t, row) in rows() {
            let label = &row[group];
            let at = *index.entry(label.to_string()).or_insert_with(|| {
                groups.push((label.clone(), Vec::new()));
                groups.len() - 1
            });
            groups[at].1.push((t, number(row)));
        }
        // First in a widget, a grouped query draws its six largest groups by summed value.
        if matches!(shape, Shape::GroupedBuckets { labels } if labels.is_empty()) {
            let total = |points: &[Sample]| sum(points.iter().map(|(_, v)| *v));
            groups.sort_by(|a, b| {
                let (a, b) = (total(&a.1), total(&b.1));
                b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
            });
            groups.truncate(GROUPED_SERIES);
        }
        out.grouped = groups
            .into_iter()
            .map(|(label, points)| (label, on_grid(points.into_iter(), &grid, missing)))
            .collect();
        return Ok(out);
    }
    if let Some(label) = column("label") {
        let mut groups: Vec<GroupValue> = Vec::new();
        let mut index = HashMap::new();
        for row in &result.rows {
            let value = number(row);
            match index.get(&row[label].to_string()) {
                Some(&at) => {
                    let g: &mut GroupValue = &mut groups[at];
                    g.value = sum([g.value, value].into_iter());
                }
                None => {
                    index.insert(row[label].to_string(), groups.len());
                    groups.push(GroupValue {
                        label: row[label].clone(),
                        value,
                    });
                }
            }
        }
        out.total = sum(groups.iter().map(|g| g.value));
        // First in a ranking, the query's own order picks the rows.
        if let Shape::Groups {
            limit,
            labels: None,
        } = shape
        {
            groups.truncate(*limit);
        }
        out.groups = groups;
        return Ok(out);
    }
    match result.rows.as_slice() {
        [] => {}
        [row] => out.total = number(row),
        rows => {
            return Err(format!(
                "A query with only a value column must return one row; this one returned {}",
                rows.len()
            ));
        }
    }
    Ok(out)
}

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
    // Only a miss pays for the names the project does have, to suggest the nearest.
    let mut known: Option<Vec<String>> = None;
    for (id, name) in named {
        let found = statement
            .exists(duckdb::params![product, name])
            .map_err(anyhow::Error::from)?;
        if !found {
            if known.is_none() {
                known = Some(event_names(db, product)?);
            }
            unknown.push(super::catalog::unknown_event(
                format!("/queries/{id}/event"),
                name,
                known.iter().flatten().map(String::as_str),
            ));
        }
    }
    Ok(unknown)
}

/// Some of the event names the project has, for "did you mean" suggestions.
fn event_names(db: &Connection, product: &str) -> ApiResult<Vec<String>> {
    db.prepare("SELECT DISTINCT name FROM events WHERE product_id = ? ORDER BY name LIMIT 100")
        .map_err(anyhow::Error::from)?
        .query_map(duckdb::params![product], |r| r.get::<_, String>(0))
        .map_err(anyhow::Error::from)?
        .collect::<duckdb::Result<Vec<_>>>()
        .map_err(|e| anyhow::Error::from(e).into())
}

/// What one widget run produced inside its deadline.
#[derive(Default)]
struct Outcome {
    series: Vec<SeriesResult>,
    rows: Option<Value>,
    columns: Option<Value>,
    /// Warnings from the run itself, which win over validation warnings at the same path.
    ran: Vec<Issue>,
    /// Warnings from verifying the widget's SQL.
    verified: Vec<Issue>,
}

/// A `source_id` that is not one of the project's sources.
fn unknown_source() -> DashboardError {
    DashboardError::Detailed {
        status: StatusCode::NOT_FOUND,
        message: "Source not found".into(),
        code: "not_found",
        errors: vec![Issue {
            path: "/source_id".into(),
            message: "No source of this project has that id".into(),
            hint: Some(
                "Use a source id from the project's sources (describe_project or the catalog lists them), or omit source_id for all sources".into(),
            ),
        }],
    }
}

/// Validates and runs one widget for a project (by id or slug) and returns its series or rows.
///
/// The widget's `timeout_ms` (default 5,000) counts from the start of the request and covers
/// waiting for a query slot. The request's `source_id` scopes every query without its own.
/// SQL queries are verified again (all three steps) before they run.
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
                match crate::sources::get(db, &product.id, source) {
                    Ok(_) => {}
                    Err(ApiError(StatusCode::NOT_FOUND, _)) => return Ok(Err(unknown_source())),
                    Err(e) => return Err(e),
                }
            }
            Ok(Ok(product.id))
        })
        .await??;

    let effective = effective_window(&widget, request.from, request.to, request.bucket.as_deref());
    let events = widget.queries.values().any(QuerySpec::reads_events);
    let logs = widget.queries.values().any(QuerySpec::reads_logs);
    let kind = widget.view.kind;
    let list = matches!(kind, ViewKind::Events | ViewKind::Logs);

    let id = widget.id.clone();
    let window = effective.window.clone();
    let scope = (product.clone(), request.source_id);
    let parser = state.sql_parser.clone();
    // Event names to check for existence: at most one per query, so at most 4.
    let named: Vec<(String, String)> = widget
        .queries
        .iter()
        .filter_map(|(id, q)| match q {
            QuerySpec::Events(q) => q.event.clone().map(|name| (id.clone(), name)),
            _ => None,
        })
        .collect();
    let outcome = if events || logs {
        state
            .store
            .widget_query(product, events, logs, deadline, move |mut e, mut l| {
                let params = SqlParams::new(&window, scope.1.as_deref());
                let check = sql::verify_widget(
                    &parser,
                    &widget,
                    "",
                    e.as_deref_mut(),
                    l.as_deref_mut(),
                    &params,
                )?;
                if !check.errors.is_empty() {
                    return Ok(Err(Report {
                        errors: check.errors,
                        warnings: check.warnings,
                    }));
                }
                let sql_grouped = matches!(kind, ViewKind::Line | ViewKind::Area | ViewKind::Bar)
                    && widget
                        .queries
                        .first()
                        .is_some_and(|(id, q)| matches!(q, QuerySpec::Sql(_)) && check.grouped(id));
                let mut outcome = Outcome {
                    ran: match e.as_deref() {
                        Some(db) => unknown_events(db, &scope.0, &named)?,
                        None => Vec::new(),
                    },
                    verified: check.warnings,
                    ..Outcome::default()
                };
                let mut measurer = Measurer {
                    product: &scope.0,
                    source: scope.1.as_deref(),
                    events: e,
                    logs: l,
                    issues: Vec::new(),
                    truncated: Vec::new(),
                };
                if kind == ViewKind::Table {
                    if let Some((columns, rows)) = measurer.table(&widget, &window)? {
                        (outcome.columns, outcome.rows) = (Some(columns), Some(rows));
                    }
                } else if list {
                    outcome.rows = Some(json!(measurer.rows(&widget, &window)?));
                } else {
                    let (shape, grouped) = if sql_grouped {
                        (Shape::GroupedBuckets { labels: Vec::new() }, true)
                    } else {
                        shape_for(&widget)
                    };
                    // Grouped time series carry no previous period; rankings compare totals only.
                    let previous_shape = match (&widget.view.effective_compare(), grouped, &shape) {
                        (Some(Compare::PreviousPeriod), false, Shape::Buckets) => {
                            Some(Shape::Buckets)
                        }
                        (Some(Compare::PreviousPeriod), false, _) => Some(Shape::Total),
                        _ => None,
                    };
                    let current = measurer.all(&widget, &window, &shape, grouped)?;
                    let before = match &previous_shape {
                        Some(shape) => {
                            Some(measurer.all(&widget, &previous(&window), shape, false)?)
                        }
                        None => None,
                    };
                    outcome.series = evaluate_as(&widget, &current, before.as_ref(), grouped);
                }
                if !measurer.issues.is_empty() {
                    return Ok(Err(Report {
                        errors: measurer.issues,
                        warnings: Vec::new(),
                    }));
                }
                let truncated = measurer.truncated.into_iter().map(|(id, message)| Issue {
                    path: format!("/queries/{id}/sql"),
                    message,
                    hint: None,
                });
                outcome.ran = truncated.chain(outcome.ran).collect();
                Ok(Ok(outcome))
            })
            .await
            .map_err(|e| match e {
                // Report the widget's own budget, which is what its author set.
                DashboardError::Timeout { queued, .. } => DashboardError::Timeout {
                    after_ms: timeout_ms,
                    queued,
                },
                e => e,
            })?
            .map_err(|mut refused| {
                refused
                    .warnings
                    .extend(std::mem::take(&mut report.warnings));
                DashboardError::Invalid(refused)
            })?
    } else {
        // Text widgets read nothing.
        Outcome::default()
    };

    // The run's own warnings say what actually happened, so they replace validation warnings
    // at the same path.
    let mut warnings = effective.warnings;
    for issue in outcome
        .ran
        .into_iter()
        .chain(outcome.verified)
        .chain(report.warnings)
    {
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
        "series": outcome.series,
        "rows": outcome.rows,
        "columns": outcome.columns,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "warnings": warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::spec::{Better, Unit};
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
    fn compare_defaults_to_previous_period_for_stat_and_chart_views() {
        let compare = |view: Value| {
            widget(json!({
                "id": "w", "title": "W", "view": view,
                "queries": {"a": {"signal": "events", "event": "e"}}
            }))
            .view
            .effective_compare()
        };
        for kind in ["stat", "line", "area", "bar"] {
            assert_eq!(
                compare(json!({"type": kind})),
                Some(Compare::PreviousPeriod),
                "{kind}"
            );
            assert_eq!(compare(json!({"type": kind, "compare": "none"})), None);
        }
        assert_eq!(compare(json!({"type": "ranking"})), None);
        assert_eq!(
            compare(json!({"type": "ranking", "compare": "previous_period"})),
            Some(Compare::PreviousPeriod)
        );
    }

    #[test]
    fn compare_none_and_better_are_in_the_schema_and_validate() {
        let schema = super::super::spec::schema().to_string();
        assert!(schema.contains("\"none\""), "{schema}");
        assert!(schema.contains("\"better\""), "{schema}");
        let document = super::super::validate::parse_document(json!({
            "version": 1, "name": "N",
            "widgets": [{
                "id": "w", "title": "W",
                "view": {"type": "stat", "compare": "none", "better": "down"},
                "queries": {"a": {"signal": "events", "event": "e"}}
            }]
        }))
        .unwrap_or_else(|r| panic!("{:?}", r.errors));
        let report = super::super::validate::check_document(&document);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        let view = &document.widgets[0].view;
        assert_eq!(view.compare, Some(Compare::None));
        assert_eq!(view.better, Some(Better::Down));
        assert!(
            super::super::validate::parse_widget(json!({
                "id": "w", "title": "W", "view": {"type": "stat", "better": "sideways"},
                "queries": {"a": {"signal": "events", "event": "e"}}
            }))
            .is_err()
        );
    }

    #[test]
    fn better_defaults_to_down_for_durations_and_up_otherwise() {
        let view = |v: Value| {
            widget(json!({
                "id": "w", "title": "W", "view": v,
                "queries": {"a": {"signal": "events", "event": "e"}}
            }))
            .view
        };
        assert_eq!(
            view(json!({"type": "stat"})).effective_better(None),
            Better::Up
        );
        assert_eq!(
            view(json!({"type": "stat", "unit": "ms"})).effective_better(None),
            Better::Down
        );
        assert_eq!(
            view(json!({"type": "stat"})).effective_better(Some(Unit::Seconds)),
            Better::Down
        );
        assert_eq!(
            view(json!({"type": "stat", "unit": "ms", "better": "up"})).effective_better(None),
            Better::Up
        );
        assert_eq!(
            view(json!({"type": "stat", "better": "down"})).effective_better(Some(Unit::Percent)),
            Better::Down
        );
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
    fn sql_bucket_grid_matches_duckdb() {
        let db = duckdb::Connection::open_in_memory().unwrap();
        let windows = [
            ("2026-11-11T13:45:10Z", "2026-11-12T02:00:00Z", Bucket::Hour),
            ("2026-11-11T13:45:10Z", "2026-11-14T00:00:01Z", Bucket::Day),
            ("2026-08-03T00:00:00Z", "2026-11-14T09:30:00Z", Bucket::Week),
            ("2026-11-15T23:59:59Z", "2027-01-01T00:00:00Z", Bucket::Week),
            (
                "2025-11-30T10:00:00Z",
                "2026-11-14T00:00:00Z",
                Bucket::Month,
            ),
        ];
        for (from, to, bucket) in windows {
            let w = Window {
                from: from.parse().unwrap(),
                to: to.parse().unwrap(),
                bucket,
            };
            // The grid the typed queries build (see `metrics::bucket_points`).
            let b = bucket.as_str();
            let expected: Vec<i64> = db
                .prepare(&format!(
                    "SELECT epoch_ms(t) FROM generate_series(date_trunc('{b}', epoch_ms(?)),
                     epoch_ms(?) - INTERVAL '1 millisecond', INTERVAL '1 {b}') AS ticks(t)"
                ))
                .unwrap()
                .query_map(
                    duckdb::params![w.from.timestamp_millis(), w.to.timestamp_millis()],
                    |r| r.get(0),
                )
                .unwrap()
                .collect::<duckdb::Result<_>>()
                .unwrap();
            assert!(!expected.is_empty());
            assert_eq!(bucket_starts(&w), expected, "{from} {to} {b}");
        }
    }

    fn sql_result(columns: &[&str], rows: Vec<Value>) -> SqlResult {
        SqlResult {
            columns: columns
                .iter()
                .map(|c| (c.to_string(), "BIGINT".to_string()))
                .collect(),
            rows: rows
                .into_iter()
                .map(|r| r.as_array().unwrap().clone())
                .collect(),
            truncated: false,
            byte_limited: false,
        }
    }

    #[test]
    fn long_series_evaluate_in_linear_time() {
        // 10,000 off-grid SQL points per query once cost about 1e8 comparisons per formula,
        // which no deadline can interrupt.
        let n = 10_000;
        let queries: serde_json::Map<String, Value> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| (id.to_string(), json!({"signal": "events", "event": "x"})))
            .collect();
        let line = widget(json!({
            "id": "w", "title": "W", "view": {"type": "line"},
            "queries": queries, "series": [{"expr": "a + b + c + d"}]
        }));
        let points: Vec<Point> = (0..n)
            .map(|i| Point {
                time: i * 7 + 3,
                value: Some(1.0),
            })
            .collect();
        let set: IndexMap<String, Measured> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| {
                let measured = Measured {
                    points: points.clone(),
                    grouped: (0..6)
                        .map(|g| (json!(format!("g{g}")), points.clone()))
                        .collect(),
                    ..Measured::default()
                };
                (id.to_string(), measured)
            })
            .collect();
        let started = std::time::Instant::now();
        let series = evaluate(&line, &set, Some(&set));
        let points = series[0].points.as_ref().unwrap();
        assert_eq!(points.len(), n as usize);
        assert_eq!(points[n as usize - 1].value, Some(4.0));
        let grouped = evaluate_as(&line, &set, None, true);
        assert_eq!(grouped.len(), 6);
        assert_eq!(grouped[5].points.as_ref().unwrap()[0].value, Some(4.0));
        // Grouped rows with as many groups as rows.
        let rows = (0..n)
            .map(|i| json!([i * 7 + 3, format!("g{i}"), 1]))
            .collect();
        let result = sql_result(&["time", "group", "value"], rows);
        let w = Window {
            from: at("2026-11-10"),
            to: at("2026-11-13"),
            bucket: Bucket::Day,
        };
        let shape = Shape::GroupedBuckets { labels: Vec::new() };
        let m = sql_measured(&result, Missing::Null, &w, &shape).unwrap();
        assert_eq!(m.grouped.len(), GROUPED_SERIES);
        let rows = (0..n).map(|i| json!([format!("l{i}"), 1])).collect();
        let result = sql_result(&["label", "value"], rows);
        let ranking = Shape::Groups {
            limit: 10,
            labels: None,
        };
        let m = sql_measured(&result, Missing::Null, &w, &ranking).unwrap();
        assert_eq!(m.total, Some(n as f64));
        // Well under a second alone in a debug build, against about 40 s when quadratic; the
        // margin absorbs a loaded machine.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn sql_results_measure_by_their_columns() {
        let w = Window {
            from: at("2026-11-10"),
            to: at("2026-11-13"),
            bucket: Bucket::Day,
        };
        let day = |d: &str| at(d).timestamp_millis();
        // Rows at one time add up, rows off the grid stay, and absent buckets follow `missing`.
        let series = sql_result(
            &["time", "value"],
            vec![
                json!([day("2026-11-10"), 2]),
                json!([day("2026-11-10"), 3]),
                json!([day("2026-11-12") + 5, 1]),
                json!([null, 100]),
            ],
        );
        let m = sql_measured(&series, Missing::Zero, &w, &Shape::Buckets).unwrap();
        assert_eq!(m.total, Some(6.0));
        assert_eq!(
            m.points,
            pts(&[
                (day("2026-11-10"), Some(5.0)),
                (day("2026-11-11"), Some(0.0)),
                (day("2026-11-12"), Some(0.0)),
                (day("2026-11-12") + 5, Some(1.0)),
            ])
        );
        let m = sql_measured(&series, Missing::Null, &w, &Shape::Buckets).unwrap();
        assert_eq!(m.points[1].value, None);

        // First in a grouped widget, the six largest groups by summed value, largest first.
        let grouped = sql_result(
            &["time", "group", "value"],
            (0..8)
                .map(|g| json!([day("2026-11-11"), g, g]))
                .chain([json!([day("2026-11-12"), 0, 10])])
                .collect(),
        );
        let first = Shape::GroupedBuckets { labels: Vec::new() };
        let m = sql_measured(&grouped, Missing::Null, &w, &first).unwrap();
        let labels: Vec<Value> = m.grouped.iter().map(|(l, _)| l.clone()).collect();
        assert_eq!(labels, [0, 7, 6, 5, 4, 3].map(|g| json!(g)).to_vec());
        assert_eq!(m.total, Some(38.0));
        assert_eq!(m.grouped[0].1.len(), 3);
        let rest = Shape::GroupedBuckets {
            labels: vec![json!(1)],
        };
        assert_eq!(
            sql_measured(&grouped, Missing::Null, &w, &rest)
                .unwrap()
                .grouped
                .len(),
            8
        );

        // Rankings keep the query's order, add up repeated labels, and cut to the limit first.
        let ranking = sql_result(
            &["label", "value"],
            vec![
                json!(["b", 1]),
                json!(["a", 5]),
                json!(["b", 2]),
                json!([null, 1]),
            ],
        );
        let first = Shape::Groups {
            limit: 2,
            labels: None,
        };
        let m = sql_measured(&ranking, Missing::Null, &w, &first).unwrap();
        assert_eq!(m.groups, groups(&[(json!("b"), 3.0), (json!("a"), 5.0)]));
        assert_eq!(m.total, Some(9.0));

        // A lone value is the total; more than one row is refused.
        let value = |rows| sql_result(&["value"], rows);
        let m = sql_measured(&value(vec![json!([4])]), Missing::Null, &w, &Shape::Total).unwrap();
        assert_eq!(m.total, Some(4.0));
        let m = sql_measured(&value(vec![]), Missing::Null, &w, &Shape::Total).unwrap();
        assert_eq!(m.total, None);
        let error = sql_measured(
            &value(vec![json!([1]), json!([2])]),
            Missing::Null,
            &w,
            &Shape::Total,
        )
        .unwrap_err();
        assert!(error.contains("one row"), "{error}");
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
