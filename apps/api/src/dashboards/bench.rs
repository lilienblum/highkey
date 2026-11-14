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

fn too_slow(path: String, message: String, hint: String) -> DashboardError {
    DashboardError::TooSlow(Report {
        errors: vec![Issue {
            path,
            message,
            hint: Some(hint),
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
    bench_within(state, product, doc, stored, TOTAL_BUDGET_MS).await
}

async fn bench_within(
    state: &AppState,
    product: &str,
    doc: &Document,
    stored: Option<&Document>,
    total_budget_ms: u64,
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
        let remaining = total_budget_ms.saturating_sub(spent);
        if remaining < MIN_BUDGET_MS {
            return Err(too_slow(
                path,
                format!(
                    "The save's combined benchmark budget ({} s) ran out before this widget",
                    TOTAL_BUDGET_MS / 1000
                ),
                "The save's combined benchmark budget (15 s) ran out at this widget; save fewer or lighter widgets at once".into(),
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
            // Waiting for a query slot is Piko's load, not the widget's cost.
            Err(DashboardError::Timeout { queued: true, .. }) => {
                return Err(DashboardError::Busy(Report {
                    errors: vec![Issue {
                        path,
                        message: "Piko was busy running other queries".into(),
                        hint: Some("Retry the save in a few seconds".into()),
                    }],
                    warnings: Vec::new(),
                }));
            }
            Err(DashboardError::Timeout { .. }) => {
                return Err(too_slow(
                    path,
                    format!("This widget did not finish within {budget} ms"),
                    slow_hint(widget, budget, remaining),
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
        let warnings: Vec<Issue> = result["warnings"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|w| Issue {
                path: w["path"].as_str().unwrap_or_default().to_string(),
                message: w["message"].as_str().unwrap_or_default().to_string(),
                hint: w["hint"].as_str().map(str::to_string),
            })
            .collect();
        let elapsed = result["elapsed_ms"].as_u64().unwrap_or(0);
        spent += elapsed;
        if elapsed > budget {
            return Err(too_slow(
                path,
                format!("This widget took {elapsed} ms, over its {budget} ms benchmark budget"),
                slow_hint(widget, budget, remaining),
            ));
        }
        // The run's own warnings (unknown event, clamped range, truncation) help the author too.
        for mut issue in warnings {
            issue.path = format!("{path}{}", issue.path);
            if !bench.warnings.iter().any(|w| w.path == issue.path) {
                bench.warnings.push(issue);
            }
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

/// The hint for a widget over budget: the brief's text for the plain 3 s case, otherwise what
/// actually set the budget.
fn slow_hint(widget: &Widget, budget: u64, remaining: u64) -> String {
    let own = widget
        .timeout_ms
        .unwrap_or(super::validate::Limits::DEFAULT_TIMEOUT_MS);
    if budget >= WIDGET_BUDGET_MS {
        HINT.into()
    } else if budget == remaining && remaining < own {
        "The save's combined benchmark budget (15 s) is nearly used up; save fewer or lighter widgets at once".into()
    } else {
        format!(
            "This widget's own timeout is {} s. Raise `timeout_ms` or narrow the query with $from/$to (or a widget range), filter by event or service, or avoid unbounded joins.",
            own as f64 / 1000.0
        )
    }
}

/// Whether the stored revision already holds exactly this widget (same id, same JSON).
fn unchanged(value: &Value, stored: Option<&Document>, widget: &Widget) -> bool {
    stored
        .and_then(|doc| doc.widgets.iter().find(|w| w.id == widget.id))
        .and_then(|w| serde_json::to_value(w).ok())
        .is_some_and(|old| &old == value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, Config};

    fn widget(timeout_ms: Option<u64>) -> Widget {
        serde_json::from_value(json!({
            "id": "w", "title": "W", "view": {"type": "stat"}, "timeout_ms": timeout_ms,
            "queries": {"q": {"signal": "events", "event": "x"}}
        }))
        .unwrap()
    }

    #[test]
    fn hints_name_what_set_the_budget() {
        assert_eq!(slow_hint(&widget(None), 3_000, 15_000), HINT);
        assert_eq!(slow_hint(&widget(Some(10_000)), 3_000, 15_000), HINT);
        let own = slow_hint(&widget(Some(1_000)), 1_000, 15_000);
        assert!(
            own.contains("own timeout is 1 s") && own.contains("`timeout_ms`"),
            "{own}"
        );
        let total = slow_hint(&widget(None), 2_000, 2_000);
        assert!(total.contains("combined benchmark budget"), "{total}");
    }

    #[tokio::test]
    async fn an_exhausted_total_budget_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(&Config {
            data_dir: dir.path().into(),
            query_concurrency: 2,
            queue_capacity: 4,
        })
        .unwrap();
        let doc: Document = serde_json::from_value(
            json!({"version": 1, "name": "N", "widgets": [serde_json::to_value(widget(None)).unwrap()]}),
        )
        .unwrap();
        let Err(DashboardError::TooSlow(report)) = bench_within(&state, "p", &doc, None, 0).await
        else {
            panic!("expected too_slow");
        };
        assert_eq!(report.errors[0].path, "/widgets/0");
        assert_eq!(
            report.errors[0].hint.as_deref(),
            Some(
                "The save's combined benchmark budget (15 s) ran out at this widget; save fewer or lighter widgets at once"
            )
        );
    }
}
