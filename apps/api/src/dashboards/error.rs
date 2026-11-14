//! Errors from dashboard reads, runs and writes, with typed JSON bodies.
use super::validate::{Issue, Report};
use crate::error::ApiError;
use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub enum DashboardError {
    Api(ApiError),
    Invalid(Report),
    /// A saved view document failed validation.
    InvalidView(Report),
    /// Any other typed failure, with issues that point at the argument at fault.
    Detailed {
        status: StatusCode,
        message: String,
        code: &'static str,
        errors: Vec<Issue>,
    },
    Conflict {
        revision: i64,
    },
    /// `queued`: the deadline passed while waiting for a gate or slot, before any work began.
    Timeout {
        after_ms: u64,
        queued: bool,
    },
    Limit(String),
    /// A widget failed its pre-save benchmark; the report points at `/widgets/N`.
    TooSlow(Report),
    /// Too many writes from one project; retry after this many seconds.
    RateLimited {
        retry_after: u64,
    },
    /// A save's benchmark could not get a query slot in time; retry shortly.
    Busy(Report),
}
impl From<ApiError> for DashboardError {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}
impl DashboardError {
    /// A 404 that names what was not found and what exists instead, so a caller can correct a
    /// misspelt slug. `what` is `Dashboard`, `View`, `Project` or `Revision`.
    pub fn not_found(what: &str, hint: Option<String>) -> Self {
        let path = what.to_lowercase();
        Self::Detailed {
            status: StatusCode::NOT_FOUND,
            message: format!("{what} not found"),
            code: "not_found",
            errors: vec![Issue {
                message: format!("No {path} matches that id or slug"),
                path,
                hint,
            }],
        }
    }

    /// The HTTP status, the JSON body and the seconds a client should wait before retrying.
    /// The HTTP responses and the MCP tool errors are both built from this, so they cannot
    /// disagree.
    pub fn into_parts(self) -> (StatusCode, Value, Option<u64>) {
        match self {
            Self::Api(ApiError(status, message)) => {
                let retry = (status == StatusCode::SERVICE_UNAVAILABLE
                    || status == StatusCode::TOO_MANY_REQUESTS)
                    .then_some(1);
                (status, json!({"error": message}), retry)
            }
            Self::Invalid(report) => (
                StatusCode::BAD_REQUEST,
                json!({
                    "error": "Invalid dashboard document",
                    "code": "invalid_document",
                    "errors": report.errors,
                    "warnings": report.warnings,
                }),
                None,
            ),
            Self::InvalidView(report) => (
                StatusCode::BAD_REQUEST,
                json!({
                    "error": "Invalid view document",
                    "code": "invalid_document",
                    "errors": report.errors,
                    "warnings": report.warnings,
                }),
                None,
            ),
            Self::Detailed {
                status,
                message,
                code,
                errors,
            } => (
                status,
                json!({"error": message, "code": code, "errors": errors}),
                None,
            ),
            Self::Conflict { revision } => (
                StatusCode::CONFLICT,
                json!({
                    "error": "This dashboard changed since you loaded it",
                    "code": "revision_conflict",
                    "revision": revision,
                }),
                None,
            ),
            // A timeout repeats on retry, so it carries no Retry-After for clients to loop on.
            Self::Timeout { after_ms, .. } => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": format!("Timed out after {} s", after_ms as f64 / 1000.0),
                    "code": "query_timeout",
                }),
                None,
            ),
            Self::Limit(message) => (
                StatusCode::BAD_REQUEST,
                json!({"error": message, "code": "limit"}),
                None,
            ),
            Self::TooSlow(report) => (
                StatusCode::BAD_REQUEST,
                json!({
                    "error": "A widget is too slow to save",
                    "code": "too_slow",
                    "errors": report.errors,
                    "warnings": report.warnings,
                }),
                None,
            ),
            Self::Busy(report) => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "error": "Piko was busy running other queries",
                    "code": "busy",
                    "errors": report.errors,
                    "warnings": report.warnings,
                }),
                Some(5),
            ),
            Self::RateLimited { retry_after } => (
                StatusCode::TOO_MANY_REQUESTS,
                json!({
                    "error": "Too many dashboard writes; slow down",
                    "code": "rate_limited",
                    "errors": [{
                        "path": "",
                        "message": "Too many dashboard writes for this project",
                        "hint": format!("Retry after {retry_after} s"),
                    }],
                }),
                Some(retry_after),
            ),
        }
    }
}

/// Bodies keep `error` for the message, like every other API error, and add a `code`.
impl IntoResponse for DashboardError {
    fn into_response(self) -> Response {
        let (status, body, retry_after) = self.into_parts();
        let mut response = (status, Json(body)).into_response();
        if let Some(seconds) = retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.into());
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboards::validate::Issue;
    use serde_json::{Value, json};

    async fn parts(error: DashboardError) -> (StatusCode, axum::http::HeaderMap, Value) {
        let response = error.into_response();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (
            status,
            headers,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn timeout_response_is_typed_and_not_retryable() {
        let (status, headers, body) = parts(DashboardError::Timeout {
            after_ms: 5000,
            queued: false,
        })
        .await;
        assert_eq!(status, 503);
        assert!(headers.get("retry-after").is_none());
        assert_eq!(
            body,
            json!({"error":"Timed out after 5 s","code":"query_timeout"})
        );
        let (_, _, body) = parts(DashboardError::Timeout {
            after_ms: 1500,
            queued: false,
        })
        .await;
        assert_eq!(body["error"], "Timed out after 1.5 s");
    }

    #[tokio::test]
    async fn conflict_and_invalid_bodies_carry_codes() {
        let (status, _, body) = parts(DashboardError::Conflict { revision: 7 }).await;
        assert_eq!(status, 409);
        assert_eq!(
            body,
            json!({"error":"This dashboard changed since you loaded it","code":"revision_conflict","revision":7})
        );

        let report = Report {
            errors: vec![Issue {
                path: "/widgets/0/series/0/expr".into(),
                message: "Unknown query `erors` at column 1".into(),
                hint: Some("Known queries: errors, requests".into()),
            }],
            warnings: vec![Issue {
                path: "/widgets/0/range".into(),
                message: "This range will be clamped".into(),
                hint: None,
            }],
        };
        let (status, _, body) = parts(DashboardError::Invalid(report)).await;
        assert_eq!(status, 400);
        assert_eq!(body["error"], "Invalid dashboard document");
        assert_eq!(body["code"], "invalid_document");
        assert_eq!(body["errors"][0]["path"], "/widgets/0/series/0/expr");
        assert_eq!(body["errors"][0]["hint"], "Known queries: errors, requests");
        assert_eq!(body["warnings"][0]["path"], "/widgets/0/range");

        let (status, _, body) = parts(DashboardError::Limit(
            "A project holds at most 50 dashboards".into(),
        ))
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            body,
            json!({"error":"A project holds at most 50 dashboards","code":"limit"})
        );
    }

    #[tokio::test]
    async fn api_errors_keep_their_shape_and_retry_hint() {
        let (status, headers, body) = parts(ApiError::busy().into()).await;
        assert_eq!(status, 503);
        assert_eq!(headers["retry-after"], "1");
        assert_eq!(
            body,
            json!({"error":"Capacity exhausted; retry with the same event IDs"})
        );
        let (status, _, body) = parts(ApiError::missing().into()).await;
        assert_eq!(status, 404);
        assert_eq!(body, json!({"error":"Product or key not found"}));
    }
}
