//! Benchmarks widgets before a dashboard is saved, so a widget that would burn the CPU is
//! refused with an actionable error instead of being discovered on every page view.
//!
//! Each new or changed widget runs once through `run_widget` (so it passes the same gate,
//! verification and deadline as a page view) over the last 7 days ending now, or the widget's own
//! `range`. A bench is a real run: it reads, and writes nothing. It happens before the SQLite
//! write transaction, which is never held open meanwhile.
use super::{
    error::DashboardError,
    run::{RunRequest, run_widget},
    spec::{Document, Widget},
    validate::{Issue, Report},
};
use crate::AppState;
use chrono::{Duration, Utc};
use serde_json::{Value, json};

/// Longest a single widget may take while benchmarking (further capped by its `timeout_ms`).
pub const WIDGET_BUDGET_MS: u64 = 3_000;
/// Longest the benchmarks of one save may take in total.
pub const TOTAL_BUDGET_MS: u64 = 15_000;
/// A widget slower than this saves, with a warning.
pub const WARN_MS: u64 = 1_000;
/// The shortest `timeout_ms` a widget may carry, so the smallest budget that can be given.
const MIN_BUDGET_MS: u64 = 1_000;

const HINT: &str = "This widget took over 3 s on the last 7 days of data. Narrow it with $from/$to (or a widget range), filter by event or service, or avoid unbounded joins.";

pub struct Bench {
    /// `[{ widget, elapsed_ms }]` for each widget that ran.
    pub timings: Vec<Value>,
    pub warnings: Vec<Issue>,
}

fn too_slow(path: String, message: String) -> DashboardError {
    DashboardError::TooSlow(Report {
        errors: vec![Issue {
            path,
            message,
            hint: Some(HINT.into()),
        }],
        warnings: Vec::new(),
    })
}

/// Runs every widget of `doc` that is not identical to the same widget in `stored`.
pub async fn bench_document(
    state: &AppState,
    product: &str,
    doc: &Document,
    stored: Option<&Document>,
) -> Result<Bench, DashboardError> {
    let mut bench = Bench {
        timings: Vec::new(),
        warnings: Vec::new(),
    };
    let mut spent = 0u64;
    for (n, widget) in doc.widgets.iter().enumerate() {
        let value = serde_json::to_value(widget)?;
        if unchanged(&value, stored, widget) {
            continue;
        }
        let path = format!("/widgets/{n}");
        let remaining = TOTAL_BUDGET_MS.saturating_sub(spent);
        if remaining < MIN_BUDGET_MS {
            return Err(too_slow(
                path,
                format!(
                    "The widgets before this one used up the {} s benchmark budget for one save",
                    TOTAL_BUDGET_MS / 1000
                ),
            ));
        }
        let budget = widget
            .timeout_ms
            .unwrap_or(super::validate::Limits::DEFAULT_TIMEOUT_MS)
            .min(WIDGET_BUDGET_MS)
            .min(remaining);
        let mut run = value;
        run["timeout_ms"] = json!(budget);
        let now = Utc::now();
        let request = RunRequest {
            widget: run,
            from: now - Duration::days(7),
            to: now,
            bucket: None,
            source_id: None,
        };
        let result = match run_widget(state, product, request).await {
            Ok(result) => result,
            Err(DashboardError::Timeout { .. }) => {
                return Err(too_slow(
                    path,
                    format!("This widget did not finish within {} ms", budget),
                ));
            }
            // The run's own refusal, pointed at the widget inside the document.
            Err(DashboardError::Invalid(mut report)) => {
                for issue in report.errors.iter_mut().chain(report.warnings.iter_mut()) {
                    issue.path = format!("{path}{}", issue.path);
                }
                return Err(DashboardError::Invalid(report));
            }
            Err(e) => return Err(e),
        };
        let elapsed = result["elapsed_ms"].as_u64().unwrap_or(0);
        spent += elapsed;
        if elapsed > budget {
            return Err(too_slow(
                path,
                format!("This widget took {elapsed} ms, over its {budget} ms benchmark budget"),
            ));
        }
        if elapsed > WARN_MS {
            bench.warnings.push(Issue {
                path: path.clone(),
                message: format!("This widget took {elapsed} ms on the last 7 days of data"),
                hint: Some("Slow widgets make the dashboard slow to open.".into()),
            });
        }
        bench
            .timings
            .push(json!({"widget": widget.id, "elapsed_ms": elapsed}));
    }
    Ok(bench)
}

/// Whether the stored revision already holds exactly this widget (same id, same JSON).
fn unchanged(value: &Value, stored: Option<&Document>, widget: &Widget) -> bool {
    stored
        .and_then(|doc| doc.widgets.iter().find(|w| w.id == widget.id))
        .and_then(|w| serde_json::to_value(w).ok())
        .is_some_and(|old| &old == value)
}
