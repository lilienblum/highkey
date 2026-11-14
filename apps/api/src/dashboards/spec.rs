//! The `piko.dashboard/v1` document: serde types, defaults and the published JSON Schema.
use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SCHEMA_ID: &str = "/api/read/schemas/dashboard.v1.json";

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Document {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub widgets: Vec<Widget>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Widget {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub view: View,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub queries: IndexMap<String, QuerySpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<Vec<Series>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct View {
    #[serde(rename = "type")]
    pub kind: ViewKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sparkline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare: Option<Compare>,
    /// Which direction of change is good, so growth is coloured as an outcome. Absent means
    /// `down` for `ms` and `seconds` values and `up` otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub better: Option<Better>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stacked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ViewKind {
    Stat,
    Line,
    Area,
    Bar,
    Ranking,
    Events,
    Logs,
    Text,
    /// Arbitrary columns from one SQL query.
    Table,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Compare {
    PreviousPeriod,
    /// Opts out of the previous-period default.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Better {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Number,
    Percent,
    Ratio,
    Ms,
    Seconds,
    Bytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Yellow,
    Violet,
    Aqua,
    Green,
    Red,
    Neutral,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Size {
    pub w: u8,
    pub h: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Threshold {
    pub at: f64,
    pub color: Color,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Series {
    pub expr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<Unit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thresholds: Vec<Threshold>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "signal", rename_all = "lowercase")]
pub enum QuerySpec {
    Events(EventsQuery),
    Logs(LogsQuery),
    Sql(SqlQuery),
}

impl QuerySpec {
    /// Whether the query reads the logs database, which keeps the shorter log range.
    pub fn reads_logs(&self) -> bool {
        match self {
            Self::Logs(_) => true,
            Self::Sql(q) => q.database == SqlDatabase::Logs,
            Self::Events(_) => false,
        }
    }
    /// Whether the query reads the events database.
    pub fn reads_events(&self) -> bool {
        !self.reads_logs()
    }
}

/// A read-only DuckDB SELECT over one of the project's databases. Its result columns decide its
/// shape: `value`; `time` and `value` (plus an optional `group`); `label` and `value`; or any
/// columns for a table. `$from`, `$to`, `$bucket` and `$source` are bound by name.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqlQuery {
    pub database: SqlDatabase,
    pub sql: String,
    /// What an absent bucket or group counts as.
    #[serde(default)]
    pub missing: Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SqlDatabase {
    Events,
    Logs,
}
impl SqlDatabase {
    /// The one table each database holds. Inside SQL this name holds only the rows of the run's
    /// window and source (see `sql::scope`).
    pub fn table(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::Logs => "logs",
        }
    }
    /// The name SQL reads the whole table by, all history included.
    pub fn history(self) -> &'static str {
        match self {
            Self::Events => "all_events",
            Self::Logs => "all_logs",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Missing {
    #[default]
    Null,
    Zero,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum EventMeasure {
    #[default]
    Count,
    Actors,
    Sum,
    Avg,
    P50,
    P95,
    Min,
    Max,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LogMeasure {
    #[default]
    Count,
    Sum,
    Avg,
    P50,
    P95,
    Min,
    Max,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EventsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_kind: Option<String>,
    #[serde(default)]
    pub measure: EventMeasure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<crate::query::Filter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<LogFilter>,
    #[serde(default)]
    pub measure: LogMeasure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LogFilter {
    pub attribute: String,
    pub value: serde_json::Value,
}

/// The JSON Schema (draft 2020-12) published for `piko.dashboard/v1` documents.
pub fn schema() -> serde_json::Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(Document))
        .expect("the document schema serializes");
    schema["$id"] = SCHEMA_ID.into();
    schema
}

impl View {
    /// The good direction of change: written `better`, else down for durations, else up.
    /// `series_unit` is the first series' own unit, which wins over the view's.
    pub fn effective_better(&self, series_unit: Option<Unit>) -> Better {
        self.better.unwrap_or(match series_unit.or(self.unit) {
            Some(Unit::Ms | Unit::Seconds) => Better::Down,
            _ => Better::Up,
        })
    }

    /// The comparison this view runs. Stat views and the headline of line, area and bar views
    /// compare with the previous period unless they say `none`; other views only when asked.
    pub fn effective_compare(&self) -> Option<Compare> {
        match self.compare {
            Some(Compare::PreviousPeriod) => Some(Compare::PreviousPeriod),
            Some(Compare::None) => None,
            Option::None => matches!(
                self.kind,
                ViewKind::Stat | ViewKind::Line | ViewKind::Area | ViewKind::Bar
            )
            .then_some(Compare::PreviousPeriod),
        }
    }
}

impl Widget {
    /// Explicit series, or one series per query (in declaration order) when none are written.
    /// Events, logs, text and table views have no series.
    pub fn series_or_default(&self) -> Vec<Series> {
        if matches!(
            self.view.kind,
            ViewKind::Events | ViewKind::Logs | ViewKind::Text | ViewKind::Table
        ) {
            return Vec::new();
        }
        match &self.series {
            Some(series) => series.clone(),
            None => self
                .queries
                .keys()
                .map(|id| Series {
                    expr: id.clone(),
                    label: None,
                    color: None,
                    unit: None,
                    thresholds: Vec::new(),
                })
                .collect(),
        }
    }

    pub fn default_size(&self) -> Size {
        let (w, h) = match self.view.kind {
            ViewKind::Stat => (3, 1),
            ViewKind::Line | ViewKind::Area | ViewKind::Bar | ViewKind::Ranking => (6, 2),
            ViewKind::Events | ViewKind::Logs | ViewKind::Table => (12, 3),
            ViewKind::Text => (4, 1),
        };
        Size { w, h }
    }
}
