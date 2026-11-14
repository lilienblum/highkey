//! Parsing and rule checks for `piko.dashboard/v1` documents.
//!
//! `parse_*` reports shape errors (unknown fields, bad enum values) with JSON Pointer paths;
//! `check_*` reports every rule violation it finds instead of stopping at the first.
use super::{formula, spec::*};
use crate::{logs::model::LEVELS, model::valid_key};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

pub const MAX_DOCUMENT_BYTES: usize = 65_536;

/// The limits from the dashboards design, shared by validation and the MCP surface.
pub struct Limits;
impl Limits {
    pub const MAX_DASHBOARDS_PER_PROJECT: usize = 50;
    pub const MAX_DOCUMENT_BYTES: usize = MAX_DOCUMENT_BYTES;
    pub const MAX_WIDGETS: usize = 24;
    pub const MAX_QUERIES_PER_WIDGET: usize = 4;
    pub const MAX_SERIES_PER_WIDGET: usize = 4;
    pub const MAX_QUERY_RUNS_PER_WIDGET: usize = 8;
    pub const WARN_QUERY_RUNS_PER_WIDGET: usize = 4;
    pub const WARN_QUERY_RUNS_PER_DOCUMENT: usize = 40;
    pub const MAX_GROUPED_SERIES: usize = 6;
    pub const MIN_RANKING_LIMIT: u8 = 1;
    pub const MAX_RANKING_LIMIT: u8 = 50;
    pub const DEFAULT_RANKING_LIMIT: u8 = 10;
    pub const MAX_FILTERS: usize = 8;
    pub const MAX_EVENT_RANGE_DAYS: u64 = 366;
    pub const MAX_HOURLY_RANGE_DAYS: u64 = 31;
    pub const MAX_LOG_RANGE_DAYS: u64 = 31;
    pub const MIN_TIMEOUT_MS: u64 = 1_000;
    pub const MAX_TIMEOUT_MS: u64 = 10_000;
    pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;
    pub const MAX_REVISIONS: usize = 50;
    pub const MAX_EXPRESSION_CHARS: usize = 200;
    pub const MAX_EXPRESSION_DEPTH: usize = 16;
    pub const MAX_ID_LEN: usize = 40;
    pub const MAX_QUERY_ID_LEN: usize = 16;
    pub const MAX_NAME_CHARS: usize = 80;
    pub const MAX_DESCRIPTION_CHARS: usize = 280;
    pub const MAX_MARKDOWN_CHARS: usize = 2_000;
    pub const MAX_AFFIX_CHARS: usize = 8;
    pub const MAX_DECIMALS: u8 = 4;
    pub const SIZE_WIDTHS: [u8; 5] = [3, 4, 6, 8, 12];
    pub const SIZE_HEIGHTS: [u8; 3] = [1, 2, 3];
    pub const MAX_TEXT_FILTER_BYTES: usize = 128;
    pub const MAX_SEARCH_BYTES: usize = 512;
}

pub fn limits_json() -> Value {
    json!({
        "max_dashboards_per_project": Limits::MAX_DASHBOARDS_PER_PROJECT,
        "max_document_bytes": Limits::MAX_DOCUMENT_BYTES,
        "max_widgets": Limits::MAX_WIDGETS,
        "max_queries_per_widget": Limits::MAX_QUERIES_PER_WIDGET,
        "max_series_per_widget": Limits::MAX_SERIES_PER_WIDGET,
        "max_query_runs_per_widget": Limits::MAX_QUERY_RUNS_PER_WIDGET,
        "max_grouped_series": Limits::MAX_GROUPED_SERIES,
        "ranking_limit": {"min": Limits::MIN_RANKING_LIMIT, "max": Limits::MAX_RANKING_LIMIT, "default": Limits::DEFAULT_RANKING_LIMIT},
        "max_filters": Limits::MAX_FILTERS,
        "max_event_range_days": Limits::MAX_EVENT_RANGE_DAYS,
        "max_hourly_range_days": Limits::MAX_HOURLY_RANGE_DAYS,
        "max_log_range_days": Limits::MAX_LOG_RANGE_DAYS,
        "timeout_ms": {"min": Limits::MIN_TIMEOUT_MS, "max": Limits::MAX_TIMEOUT_MS, "default": Limits::DEFAULT_TIMEOUT_MS},
        "max_revisions": Limits::MAX_REVISIONS,
        "max_expression_chars": Limits::MAX_EXPRESSION_CHARS,
        "max_expression_depth": Limits::MAX_EXPRESSION_DEPTH,
        "id_pattern": "[a-z0-9-]{1,40}",
        "query_id_pattern": "[a-z][a-z0-9_]{0,15}",
        "name_chars": {"min": 1, "max": Limits::MAX_NAME_CHARS},
        "description_chars": {"max": Limits::MAX_DESCRIPTION_CHARS},
        "max_markdown_chars": Limits::MAX_MARKDOWN_CHARS,
        "max_affix_chars": Limits::MAX_AFFIX_CHARS,
        "decimals": {"min": 0, "max": Limits::MAX_DECIMALS},
        "range_pattern": "^\\d{1,3}(h|d)$",
        "size_widths": Limits::SIZE_WIDTHS,
        "size_heights": Limits::SIZE_HEIGHTS,
    })
}

#[derive(Debug, Default, Serialize)]
pub struct Issue {
    /// JSON Pointer into the document (or widget) the issue concerns.
    pub path: String,
    pub message: String,
    pub hint: Option<String>,
}
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}
impl Report {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }
    fn error(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(Issue {
            path: path.into(),
            message: message.into(),
            hint: None,
        });
    }
    fn error_hint(
        &mut self,
        path: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) {
        self.errors.push(Issue {
            path: path.into(),
            message: message.into(),
            hint: Some(hint.into()),
        });
    }
    fn warn(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.warnings.push(Issue {
            path: path.into(),
            message: message.into(),
            hint: None,
        });
    }
}

fn pointer(segments: &[String]) -> String {
    segments
        .iter()
        .map(|s| format!("/{}", s.replace('~', "~0").replace('/', "~1")))
        .collect()
}

/// Query specs are internally tagged, and serde buffers those, which hides the path of an error
/// inside them. Re-parse the variant on its own to recover the precise field path.
fn refine_query_error(value: &Value, segments: &[String]) -> Option<(Vec<String>, String)> {
    let [.., queries, _] = segments else {
        return None;
    };
    if queries != "queries" {
        return None;
    }
    let mut spec = value.pointer(&pointer(segments))?.clone();
    let signal = spec.as_object_mut()?.remove("signal")?;
    let result = match signal.as_str()? {
        "events" => serde_path_to_error::deserialize::<_, EventsQuery>(spec).err(),
        "logs" => serde_path_to_error::deserialize::<_, LogsQuery>(spec).err(),
        _ => None,
    }?;
    let mut full = segments.to_vec();
    full.extend(path_segments(result.path()));
    Some((full, result.inner().to_string()))
}

fn path_segments(path: &serde_path_to_error::Path) -> Vec<String> {
    use serde_path_to_error::Segment;
    path.iter()
        .filter_map(|segment| match segment {
            Segment::Seq { index } => Some(index.to_string()),
            Segment::Map { key } | Segment::Enum { variant: key } => Some(key.clone()),
            Segment::Unknown => None,
        })
        .collect()
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, Report> {
    serde_path_to_error::deserialize(value.clone()).map_err(|e| {
        let mut segments = path_segments(e.path());
        let mut message = e.inner().to_string();
        if let Some((full, inner)) = refine_query_error(&value, &segments) {
            (segments, message) = (full, inner);
        }
        let mut report = Report::default();
        report.error(pointer(&segments), message);
        report
    })
}
pub fn parse_document(value: Value) -> Result<Document, Report> {
    parse(value)
}
pub fn parse_widget(value: Value) -> Result<Widget, Report> {
    parse(value)
}

fn chars(s: &str) -> usize {
    s.chars().count()
}
fn text_len(r: &mut Report, path: String, s: &str, min: usize, max: usize, what: &str) {
    let n = chars(s);
    if n < min || n > max {
        r.error(path, format!("{what} must be {min}–{max} characters"));
    }
}

pub fn check_document(doc: &Document) -> Report {
    let mut r = Report::default();
    match serde_json::to_vec(doc) {
        Ok(bytes) if bytes.len() > MAX_DOCUMENT_BYTES => r.error(
            "",
            format!(
                "Document is {} bytes; the limit is {MAX_DOCUMENT_BYTES}",
                bytes.len()
            ),
        ),
        Ok(_) => {}
        Err(e) => r.error("", format!("Document does not serialize: {e}")),
    }
    if doc.version != 1 {
        r.error("/version", "Only version 1 is supported");
    }
    text_len(
        &mut r,
        "/name".into(),
        &doc.name,
        1,
        Limits::MAX_NAME_CHARS,
        "name",
    );
    if doc
        .description
        .as_ref()
        .is_some_and(|d| chars(d) > Limits::MAX_DESCRIPTION_CHARS)
    {
        r.error(
            "/description",
            format!(
                "description is limited to {} characters",
                Limits::MAX_DESCRIPTION_CHARS
            ),
        );
    }
    if doc.widgets.len() > Limits::MAX_WIDGETS {
        r.error(
            "/widgets",
            format!("A dashboard holds at most {} widgets", Limits::MAX_WIDGETS),
        );
    }
    let mut seen = HashSet::new();
    let mut runs = 0;
    for (i, widget) in doc.widgets.iter().enumerate() {
        if !seen.insert(widget.id.as_str()) {
            r.error(
                format!("/widgets/{i}/id"),
                format!("Duplicate widget id `{}`", widget.id),
            );
        }
        check_widget(widget, &format!("/widgets/{i}"), &mut r);
        runs += query_runs(widget);
    }
    if runs > Limits::WARN_QUERY_RUNS_PER_DOCUMENT {
        r.warn(
            "/widgets",
            format!(
                "The dashboard runs {runs} queries per refresh (more than {}); it may load slowly",
                Limits::WARN_QUERY_RUNS_PER_DOCUMENT
            ),
        );
    }
    r
}

fn query_runs(w: &Widget) -> usize {
    w.queries.len() * if w.view.compare.is_some() { 2 } else { 1 }
}

fn valid_widget_id(id: &str) -> bool {
    (1..=Limits::MAX_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn valid_query_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=Limits::MAX_QUERY_ID_LEN).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// Range override in hours: `^\d{1,3}(h|d)$`, non-zero.
pub(super) fn range_hours(s: &str) -> Option<u64> {
    let (digits, unit) = if let Some(d) = s.strip_suffix('h') {
        (d, "h")
    } else {
        (s.strip_suffix('d')?, "d")
    };
    if !(1..=3).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    match unit {
        "h" if n > 0 => Some(n),
        "d" if n > 0 => Some(n * 24),
        _ => None,
    }
}

pub fn check_widget(w: &Widget, base: &str, r: &mut Report) {
    if !valid_widget_id(&w.id) {
        r.error(format!("{base}/id"), "id must match [a-z0-9-]{1,40}");
    }
    text_len(
        r,
        format!("{base}/title"),
        &w.title,
        1,
        Limits::MAX_NAME_CHARS,
        "title",
    );
    if w.description
        .as_ref()
        .is_some_and(|d| chars(d) > Limits::MAX_DESCRIPTION_CHARS)
    {
        r.error(
            format!("{base}/description"),
            format!(
                "description is limited to {} characters",
                Limits::MAX_DESCRIPTION_CHARS
            ),
        );
    }
    if let Some(size) = w.size {
        if !Limits::SIZE_WIDTHS.contains(&size.w) {
            r.error(format!("{base}/size/w"), "w must be one of 3, 4, 6, 8, 12");
        }
        if !Limits::SIZE_HEIGHTS.contains(&size.h) {
            r.error(format!("{base}/size/h"), "h must be one of 1, 2, 3");
        }
    }
    if w.timeout_ms
        .is_some_and(|t| !(Limits::MIN_TIMEOUT_MS..=Limits::MAX_TIMEOUT_MS).contains(&t))
    {
        r.error(
            format!("{base}/timeout_ms"),
            "timeout_ms must be 1000–10000",
        );
    }
    let has_logs = w.queries.values().any(|q| matches!(q, QuerySpec::Logs(_)));
    let range = w.range.as_deref().map(|s| (s, range_hours(s)));
    if let Some((s, hours)) = range {
        match hours {
            None => r.error_hint(
                format!("{base}/range"),
                format!("Invalid range `{s}`"),
                "Use 1–3 digits and h or d, such as 24h or 30d",
            ),
            Some(h) if h > Limits::MAX_EVENT_RANGE_DAYS * 24 => {
                r.warn(
                    format!("{base}/range"),
                    "Ranges are limited to 366 days; this range will be clamped",
                );
            }
            Some(h) if has_logs && h > Limits::MAX_LOG_RANGE_DAYS * 24 => {
                r.warn(
                    format!("{base}/range"),
                    "Ranges with a logs query are limited to 31 days; this range will be clamped",
                );
            }
            _ => {}
        }
    }
    check_view(w, base, range.and_then(|(_, h)| h), r);
    for (id, query) in &w.queries {
        if !valid_query_id(id) {
            r.error(
                format!("{base}/queries/{id}"),
                "Query ids must match [a-z][a-z0-9_]{0,15}",
            );
        }
        check_query(query, &format!("{base}/queries/{id}"), r);
    }
    check_shape(w, base, r);
}

fn check_view(w: &Widget, base: &str, range: Option<u64>, r: &mut Report) {
    let v = &w.view;
    let vp = format!("{base}/view");
    if v.decimals.is_some_and(|d| d > Limits::MAX_DECIMALS) {
        r.error(format!("{vp}/decimals"), "decimals must be 0–4");
    }
    for (name, value) in [("prefix", &v.prefix), ("suffix", &v.suffix)] {
        if value
            .as_ref()
            .is_some_and(|s| chars(s) > Limits::MAX_AFFIX_CHARS)
        {
            r.error(
                format!("{vp}/{name}"),
                format!("{name} is limited to 8 characters"),
            );
        }
    }
    if let Some(bucket) = &v.bucket {
        if !["auto", "hour", "day", "week", "month"].contains(&bucket.as_str()) {
            r.error(
                format!("{vp}/bucket"),
                "bucket must be auto, hour, day, week or month",
            );
        } else if bucket == "hour" && range.is_some_and(|h| h > Limits::MAX_HOURLY_RANGE_DAYS * 24)
        {
            r.warn(
                format!("{vp}/bucket"),
                "Hourly buckets need a range of at most 31 days; the bucket falls back to auto",
            );
        }
    }
    if v.limit
        .is_some_and(|l| !(Limits::MIN_RANKING_LIMIT..=Limits::MAX_RANKING_LIMIT).contains(&l))
    {
        r.error(format!("{vp}/limit"), "limit must be 1–50");
    }
    match (&v.markdown, v.kind) {
        (Some(m), ViewKind::Text) if chars(m) > Limits::MAX_MARKDOWN_CHARS => {
            r.error(
                format!("{vp}/markdown"),
                "markdown is limited to 2000 characters",
            );
        }
        (None, ViewKind::Text) => r.error(format!("{vp}/markdown"), "Text widgets need markdown"),
        (Some(_), kind) if kind != ViewKind::Text => {
            r.error(
                format!("{vp}/markdown"),
                "markdown is only for text widgets",
            );
        }
        _ => {}
    }
}

fn group_by(q: &QuerySpec) -> Option<&str> {
    match q {
        QuerySpec::Events(q) => q.group_by.as_deref(),
        QuerySpec::Logs(q) => q.group_by.as_deref(),
    }
}

/// Rules that look across a widget's queries, series and view.
fn check_shape(w: &Widget, base: &str, r: &mut Report) {
    let kind = w.view.kind;
    let n = w.queries.len();
    let qpath = format!("{base}/queries");
    match kind {
        ViewKind::Text => {
            if n > 0 {
                r.error(&qpath, "Text widgets take no queries");
            }
            if w.series.is_some() {
                r.error(format!("{base}/series"), "Text widgets take no series");
            }
            return;
        }
        ViewKind::Events | ViewKind::Logs => {
            let (wanted, name) = if kind == ViewKind::Events {
                (true, "events")
            } else {
                (false, "logs")
            };
            if n != 1 {
                r.error(
                    &qpath,
                    format!("A {name} widget needs exactly one {name} query"),
                );
            }
            for (id, q) in &w.queries {
                if matches!(q, QuerySpec::Events(_)) != wanted {
                    r.error(
                        format!("{qpath}/{id}"),
                        format!("A {name} widget needs a {name} query"),
                    );
                }
                let (measure_is_count, group) = match q {
                    QuerySpec::Events(q) => (q.measure == EventMeasure::Count, &q.group_by),
                    QuerySpec::Logs(q) => (q.measure == LogMeasure::Count, &q.group_by),
                };
                if !measure_is_count {
                    r.error(
                        format!("{qpath}/{id}/measure"),
                        format!("A {name} widget lists rows and takes no measure"),
                    );
                }
                if group.is_some() {
                    r.error(
                        format!("{qpath}/{id}/group_by"),
                        format!("A {name} widget lists rows and takes no group_by"),
                    );
                }
            }
            if w.series.is_some() {
                r.error(
                    format!("{base}/series"),
                    format!("A {name} widget takes no series"),
                );
            }
            return;
        }
        _ => {}
    }
    if !(1..=Limits::MAX_QUERIES_PER_WIDGET).contains(&n) {
        r.error(&qpath, "A widget needs 1–4 queries");
    }
    let runs = query_runs(w);
    if runs > Limits::MAX_QUERY_RUNS_PER_WIDGET {
        r.error(
            &qpath,
            format!("{runs} query runs per refresh including the previous period; the limit is 8"),
        );
    } else if runs > Limits::WARN_QUERY_RUNS_PER_WIDGET {
        r.warn(&qpath, format!("{runs} query runs per refresh including the previous period; this widget may load slowly"));
    }

    // All queries share one group_by, or none has one.
    let mut queries = w.queries.iter();
    let first = queries.next().map(|(_, q)| group_by(q));
    if let Some(first) = first {
        for (id, q) in queries {
            if group_by(q) != first {
                r.error_hint(
                    format!("{qpath}/{id}/group_by"),
                    "Every query in a widget must share the same group_by",
                    "Give all queries the same group_by, or remove it from all of them",
                );
            }
        }
    }
    let grouped = first.flatten().is_some();
    if kind == ViewKind::Ranking {
        for (id, q) in &w.queries {
            if group_by(q).is_none() {
                r.error(
                    format!("{qpath}/{id}/group_by"),
                    "Ranking widgets need a group_by",
                );
            }
        }
    }

    // Series.
    let series = w.series_or_default();
    let spath = format!("{base}/series");
    if w.series.is_some() && !(1..=Limits::MAX_SERIES_PER_WIDGET).contains(&series.len()) {
        r.error(&spath, "A widget needs 1–4 series");
    }
    if grouped
        && matches!(kind, ViewKind::Line | ViewKind::Area | ViewKind::Bar)
        && series.len() > 1
    {
        let path = if w.series.is_some() {
            format!("{spath}/1")
        } else {
            qpath.clone()
        };
        r.error_hint(
            path,
            "A grouped time series allows only one series",
            "Remove the extra series, or remove group_by",
        );
    }
    let known: Vec<&str> = w.queries.keys().map(String::as_str).collect();
    let mut referenced = BTreeSet::new();
    let mut all_parsed = true;
    for (i, s) in series.iter().enumerate() {
        let sp = format!("{spath}/{i}");
        match formula::parse(&s.expr, &known) {
            Ok(expr) => referenced.extend(expr.references()),
            Err(e) => {
                all_parsed = false;
                let message = match e.message.split_once("; ") {
                    Some((head, tail)) => format!("{head} at column {}; {tail}", e.column),
                    None => format!("{} at column {}", e.message, e.column),
                };
                r.error(format!("{sp}/expr"), message);
            }
        }
        for (j, pair) in s.thresholds.windows(2).enumerate() {
            if pair[1].at <= pair[0].at {
                r.error(
                    format!("{sp}/thresholds/{}", j + 1),
                    "Thresholds must be in ascending order",
                );
            }
        }
    }
    if all_parsed {
        for id in w.queries.keys() {
            if !referenced.contains(id) {
                r.error_hint(
                    format!("{qpath}/{id}"),
                    format!("Query `{id}` is not used by any series"),
                    "Reference it in a series expression, or remove it",
                );
            }
        }
    }
}

fn nonempty(r: &mut Report, path: String, value: &Option<String>, max: usize) {
    if value
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.len() > max)
    {
        r.error(path, format!("Must be 1–{max} bytes"));
    }
}

fn check_query(q: &QuerySpec, p: &str, r: &mut Report) {
    match q {
        QuerySpec::Events(q) => check_events(q, p, r),
        QuerySpec::Logs(q) => check_logs(q, p, r),
    }
}

fn check_events(q: &EventsQuery, p: &str, r: &mut Report) {
    for (name, value) in [
        ("event", &q.event),
        ("source_id", &q.source_id),
        ("identity_kind", &q.identity_kind),
    ] {
        nonempty(
            r,
            format!("{p}/{name}"),
            value,
            Limits::MAX_TEXT_FILTER_BYTES,
        );
    }
    let numeric = !matches!(q.measure, EventMeasure::Count | EventMeasure::Actors);
    check_measure(numeric, q.property.as_deref(), "property", valid_key, p, r);
    if q.filters.len() > Limits::MAX_FILTERS {
        r.error(format!("{p}/filters"), "At most 8 filters per query");
    }
    for (i, f) in q.filters.iter().enumerate() {
        let fp = format!("{p}/filters/{i}");
        if !valid_key(&f.property) {
            r.error(format!("{fp}/property"), "Invalid property key");
        }
        if !["eq", "ne", "gt", "gte", "lt", "lte"].contains(&f.op.as_str()) {
            r.error(format!("{fp}/op"), "op must be eq, ne, gt, gte, lt or lte");
        } else if !f.value.is_number() {
            if !(f.value.is_string() || f.value.is_boolean()) {
                r.error(
                    format!("{fp}/value"),
                    "value must be a string, number or boolean",
                );
            } else if !["eq", "ne"].contains(&f.op.as_str()) {
                r.error(
                    format!("{fp}/value"),
                    "Ordered comparisons require a number",
                );
            }
        }
    }
    if let Some(g) = &q.group_by {
        let ok = ["name", "source", "source_id", "identity_kind"].contains(&g.as_str())
            || g.strip_prefix("property:").is_some_and(valid_key);
        if !ok {
            r.error_hint(
                format!("{p}/group_by"),
                format!("Invalid group_by `{g}`"),
                "Use name, source, source_id, identity_kind or property:<key>",
            );
        }
    }
}

fn check_logs(q: &LogsQuery, p: &str, r: &mut Report) {
    for (name, value) in [("level", &q.level), ("min_level", &q.min_level)] {
        if value
            .as_ref()
            .is_some_and(|l| !LEVELS.contains(&l.as_str()))
        {
            r.error_hint(
                format!("{p}/{name}"),
                "Unknown log level",
                LEVELS.join(", "),
            );
        }
    }
    if q.min_level.as_ref().is_some_and(|l| {
        LEVELS.contains(&l.as_str()) && !["warn", "error", "fatal"].contains(&l.as_str())
    }) {
        r.error(
            format!("{p}/min_level"),
            "min_level must be warn, error or fatal",
        );
    }
    if q.level.is_some() && q.min_level.is_some() {
        r.error(
            format!("{p}/min_level"),
            "Use either level or min_level, not both",
        );
    }
    for (name, value) in [
        ("service", &q.service),
        ("environment", &q.environment),
        ("source_id", &q.source_id),
    ] {
        nonempty(
            r,
            format!("{p}/{name}"),
            value,
            Limits::MAX_TEXT_FILTER_BYTES,
        );
    }
    if q.search
        .as_ref()
        .is_some_and(|s| s.len() > Limits::MAX_SEARCH_BYTES)
    {
        r.error(format!("{p}/search"), "search is limited to 512 bytes");
    }
    if q.filters.len() > Limits::MAX_FILTERS {
        r.error(format!("{p}/filters"), "At most 8 filters per query");
    }
    for (i, f) in q.filters.iter().enumerate() {
        let fp = format!("{p}/filters/{i}");
        if !attribute_key(&f.attribute) {
            r.error(format!("{fp}/attribute"), "attribute must be 1–128 bytes");
        }
        let scalar = match &f.value {
            Value::String(s) => s.len() <= Limits::MAX_SEARCH_BYTES,
            Value::Number(_) | Value::Bool(_) => true,
            _ => false,
        };
        if !scalar {
            r.error(
                format!("{fp}/value"),
                "value must be a string (≤512 bytes), number or boolean",
            );
        }
    }
    let numeric = q.measure != LogMeasure::Count;
    check_measure(
        numeric,
        q.attribute.as_deref(),
        "attribute",
        attribute_key,
        p,
        r,
    );
    if let Some(g) = &q.group_by {
        let ok = ["level", "service", "environment"].contains(&g.as_str())
            || g.strip_prefix("attribute:").is_some_and(attribute_key);
        if !ok {
            r.error_hint(
                format!("{p}/group_by"),
                format!("Invalid group_by `{g}`"),
                "Use level, service, environment or attribute:<key>",
            );
        }
    }
}

fn attribute_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128
}

/// Numeric measures need a valid property/attribute; the others must not carry one.
fn check_measure(
    numeric: bool,
    field: Option<&str>,
    name: &str,
    valid: fn(&str) -> bool,
    p: &str,
    r: &mut Report,
) {
    match (numeric, field) {
        (true, None) => r.error(
            format!("{p}/{name}"),
            format!("This measure needs a {name}"),
        ),
        (true, Some(f)) if !valid(f) => r.error(format!("{p}/{name}"), format!("Invalid {name}")),
        (false, Some(_)) => r.error(
            format!("{p}/{name}"),
            format!("{name} is only used by sum, avg, p50, p95, min and max"),
        ),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn doc(widgets: Value) -> Value {
        json!({"version":1,"name":"Checkout health","widgets":widgets})
    }
    fn line() -> Value {
        json!({"id":"error-rate","title":"Error rate","view":{"type":"line","unit":"percent"},
      "queries":{"errors":{"signal":"logs","min_level":"error"},"requests":{"signal":"events","event":"checkout_request"}},
      "series":[{"expr":"errors / requests * 100","color":"red","thresholds":[{"at":1,"color":"yellow"},{"at":5,"color":"red"}]}]})
    }
    fn errors(widgets: Value) -> Vec<String> {
        check_document(&parse_document(doc(widgets)).unwrap())
            .errors
            .into_iter()
            .map(|i| i.path)
            .collect()
    }

    #[test]
    fn spec_example_is_valid() {
        let d = parse_document(doc(json!([line()]))).unwrap();
        assert!(check_document(&d).errors.is_empty());
    }
    #[test]
    fn unknown_fields_and_bad_enums_have_pointer_paths() {
        let mut w = line();
        w["queries"]["errors"]["min_levle"] = json!("warn");
        assert_eq!(
            parse_document(doc(json!([w]))).unwrap_err().errors[0].path,
            "/widgets/0/queries/errors/min_levle"
        );
        let mut w = line();
        w["series"][0]["color"] = json!("orange");
        assert_eq!(
            parse_document(doc(json!([w]))).unwrap_err().errors[0].path,
            "/widgets/0/series/0/color"
        );
        let v2 =
            check_document(&parse_document(json!({"version":2,"name":"x","widgets":[]})).unwrap());
        assert_eq!(v2.errors[0].path, "/version");
    }
    #[test]
    fn rule_errors() {
        let cases: Vec<(Value, &str)> = vec![
            (
                json!({"id":"a","title":"t","view":{"type":"line"},"queries":{"a":{"signal":"events"},"b":{"signal":"events"}},"series":[{"expr":"a"}]}),
                "/widgets/0/queries/b",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"ranking"},"queries":{"a":{"signal":"events","group_by":"name"},"b":{"signal":"events","group_by":"source"}},"series":[{"expr":"a/b"}]}),
                "/widgets/0/queries/b/group_by",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"logs","level":"error","min_level":"warn"}}}),
                "/widgets/0/queries/a/min_level",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events","measure":"avg"}}}),
                "/widgets/0/queries/a/property",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"size":{"w":5,"h":1},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/size/w",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"timeout_ms":20000,"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/timeout_ms",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"line","markdown":"x"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/view/markdown",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"line"},"queries":{"a":{"signal":"events","group_by":"name"}},"series":[{"expr":"a"},{"expr":"a*2"}]}),
                "/widgets/0/series/1",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"range":"2w","queries":{"a":{"signal":"events"}}}),
                "/widgets/0/range",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events"}},"series":[{"expr":"a","thresholds":[{"at":5,"color":"red"},{"at":1,"color":"green"}]}]}),
                "/widgets/0/series/0/thresholds/1",
            ),
        ];
        for (w, path) in cases {
            let paths = errors(json!([w]));
            assert!(paths.iter().any(|p| p == path), "{path}: {paths:?}");
        }
    }
    #[test]
    fn more_rule_errors() {
        let cases: Vec<(Value, &str)> = vec![
            (
                json!({"id":"Bad_ID","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/id",
            ),
            (
                json!({"id":"a","title":"","view":{"type":"stat"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/title",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"A":{"signal":"events"}}}),
                "/widgets/0/queries/A",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"text"}}),
                "/widgets/0/view/markdown",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"text","markdown":"x"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/queries",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"}}),
                "/widgets/0/queries",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"events"},"queries":{"a":{"signal":"logs"}}}),
                "/widgets/0/queries/a",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"events"},"queries":{"a":{"signal":"events","measure":"sum","property":"x"}}}),
                "/widgets/0/queries/a/measure",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"logs"},"queries":{"a":{"signal":"logs","group_by":"level"}}}),
                "/widgets/0/queries/a/group_by",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"events"},"queries":{"a":{"signal":"events"}},"series":[{"expr":"a"}]}),
                "/widgets/0/series",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"ranking"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/queries/a/group_by",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"ranking","limit":51},"queries":{"a":{"signal":"events","group_by":"name"}}}),
                "/widgets/0/view/limit",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"line","bucket":"year"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/view/bucket",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"logs","level":"loud"}}}),
                "/widgets/0/queries/a/level",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"logs","min_level":"info"}}}),
                "/widgets/0/queries/a/min_level",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"ranking"},"queries":{"a":{"signal":"logs","group_by":"name"}}}),
                "/widgets/0/queries/a/group_by",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events"}},"series":[{"expr":"a +"}]}),
                "/widgets/0/series/0/expr",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat","decimals":5},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/view/decimals",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat","prefix":"123456789"},"queries":{"a":{"signal":"events"}}}),
                "/widgets/0/view/prefix",
            ),
            (
                json!({"id":"a","title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events","filters":[{"property":"bad key","op":"eq","value":1}]}}}),
                "/widgets/0/queries/a/filters/0/property",
            ),
        ];
        for (w, path) in cases {
            let paths = errors(json!([w]));
            assert!(paths.iter().any(|p| p == path), "{path}: {paths:?}");
        }
    }
    #[test]
    fn long_ranges_warn_and_malformed_ranges_never_panic() {
        let w = |range: &str, signal: Value, view: Value| json!({"id":"a","title":"t","view":view,"range":range,"queries":{"a":signal}});
        let events = || json!({"signal":"events"});
        let cases = vec![
            (
                w("400d", events(), json!({"type":"stat"})),
                "/widgets/0/range",
            ),
            (
                w("90d", json!({"signal":"logs"}), json!({"type":"stat"})),
                "/widgets/0/range",
            ),
            (
                w("100d", events(), json!({"type":"line","bucket":"hour"})),
                "/widgets/0/view/bucket",
            ),
        ];
        for (widget, path) in cases {
            let report = check_document(&parse_document(doc(json!([widget]))).unwrap());
            assert!(report.errors.is_empty(), "{:?}", report.errors);
            assert!(report.warnings.iter().any(|i| i.path == path), "{path}");
        }
        let bad = w("5é", events(), json!({"type":"stat"}));
        assert!(errors(json!([bad])).iter().any(|p| p == "/widgets/0/range"));
    }
    #[test]
    fn formula_errors_carry_the_column() {
        let mut w = line();
        w["series"][0]["expr"] = json!("erors / requests");
        let report = check_document(&parse_document(doc(json!([w]))).unwrap());
        let issue = report
            .errors
            .iter()
            .find(|i| i.path == "/widgets/0/series/0/expr")
            .unwrap();
        assert!(issue.message.contains("at column 1"), "{}", issue.message);
        assert!(issue.message.contains("did you mean `errors`"));
    }
    #[test]
    fn document_limits() {
        let w = |i: usize| json!({"id":format!("w{i}"),"title":"t","view":{"type":"stat"},"queries":{"a":{"signal":"events"}}});
        let report =
            check_document(&parse_document(doc(Value::Array((0..25).map(w).collect()))).unwrap());
        assert!(report.errors.iter().any(|i| i.path == "/widgets"));
        let dup = check_document(&parse_document(doc(json!([w(1), w(1)]))).unwrap());
        assert!(dup.errors.iter().any(|i| i.path == "/widgets/1/id"));
    }
    #[test]
    fn query_run_budget_counts_previous_period() {
        let mut w = line();
        w["view"]["compare"] = json!("previous_period");
        w["queries"]["c"] = json!({"signal":"events"});
        w["queries"]["d"] = json!({"signal":"events"});
        w["queries"]["e"] = json!({"signal":"events"});
        w["series"] = json!([{"expr":"errors+requests+c+d+e"}]);
        assert!(errors(json!([w])).iter().any(|p| p == "/widgets/0/queries"));
        let mut w = line();
        w["view"]["compare"] = json!("previous_period");
        w["queries"]["c"] = json!({"signal":"events"});
        w["series"] = json!([{"expr":"errors+requests+c"}]);
        let report = check_document(&parse_document(doc(json!([w]))).unwrap());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(
            report
                .warnings
                .iter()
                .any(|i| i.path == "/widgets/0/queries")
        );
    }
    #[test]
    fn invalid_group_by_keys_are_errors() {
        let w = json!({"id":"a","title":"t","view":{"type":"ranking"},"queries":{"a":{"signal":"events","group_by":"property:bad key"}}});
        assert!(
            errors(json!([w]))
                .iter()
                .any(|p| p == "/widgets/0/queries/a/group_by")
        );
        let w = json!({"id":"a","title":"t","view":{"type":"ranking"},"queries":{"a":{"signal":"logs","group_by":"attribute:route"}}});
        assert!(errors(json!([w])).is_empty());
    }
    #[test]
    fn document_size_limit_is_inclusive() {
        let mut d = parse_document(doc(json!([]))).unwrap();
        d.schema = Some(String::new());
        let overhead = serde_json::to_vec(&d).unwrap().len();
        d.schema = Some("x".repeat(MAX_DOCUMENT_BYTES - overhead));
        assert_eq!(serde_json::to_vec(&d).unwrap().len(), MAX_DOCUMENT_BYTES);
        assert!(check_document(&d).errors.is_empty());
        d.schema.as_mut().unwrap().push('x');
        assert!(check_document(&d).errors.iter().any(|i| i.path.is_empty()));
    }
    #[test]
    fn widget_parsing_and_limits_json() {
        let w = parse_widget(line()).unwrap();
        let mut report = Report::default();
        check_widget(&w, "", &mut report);
        assert!(report.is_ok());
        let mut bad = line();
        bad["id"] = json!(5);
        assert_eq!(parse_widget(bad).unwrap_err().errors[0].path, "/id");
        assert_eq!(limits_json()["max_widgets"], 24);
    }
    #[test]
    fn schema_is_draft_2020_and_names_colors() {
        let schema = crate::dashboards::spec::schema();
        assert_eq!(schema["$id"], "/api/read/schemas/dashboard.v1.json");
        assert!(schema["$schema"].as_str().unwrap().contains("2020-12"));
        let s = schema.to_string();
        assert!(s.contains("\"yellow\"") && !s.contains("\"orange\""));
    }
}
