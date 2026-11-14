use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
pub type ApiResult<T> = Result<T, ApiError>;
impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    pub fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "Authentication required".into())
    }
    /// No capacity left. Its wording is for ingestion, where SDKs retry with the same event
    /// IDs so deduplication holds; dashboard, catalog and MCP callers get their own wording
    /// (see `DashboardError`).
    pub fn busy() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "Capacity exhausted; retry with the same event IDs".into(),
        )
    }
    /// A key, source or route that does not exist.
    pub fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "Product or key not found".into())
    }
    /// No project has that id (or slug).
    pub fn project_missing() -> Self {
        Self(StatusCode::NOT_FOUND, PROJECT_MISSING.into())
    }
}
/// The message of `ApiError::project_missing`.
pub const PROJECT_MISSING: &str = "Project not found";
/// Whether DuckDB stopped the query because it was interrupted, as a widget's deadline or an
/// aborted request does. That is expected, so it is not logged as an error.
fn interrupted(e: &anyhow::Error) -> bool {
    e.chain()
        .any(|cause| cause.to_string().starts_with("INTERRUPT Error"))
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        if interrupted(&e) {
            tracing::debug!(error = %e, "Query interrupted");
        } else {
            tracing::error!(error = %e, "Database operation failed");
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database operation failed".into(),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error": self.1}))).into_response();
        if self.0 == StatusCode::SERVICE_UNAVAILABLE || self.0 == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().expect("static header"));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    /// What `f` logs, at every level.
    fn logged(f: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn interrupted_queries_are_not_logged_as_errors() {
        // A widget's deadline interrupts its query; that is expected, not a failure.
        let db = duckdb::Connection::open_in_memory().unwrap();
        let handle = db.interrupt_handle();
        let done = Arc::new(AtomicBool::new(false));
        let stop = done.clone();
        let interrupter = std::thread::spawn(move || {
            // An interrupt that lands before the statement starts is cleared, so repeat it.
            while !stop.load(Ordering::SeqCst) {
                handle.interrupt();
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
        let error = db
            .query_row(
                "SELECT count(*) FROM range(10000000000) a, range(10) b",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_err();
        done.store(true, Ordering::SeqCst);
        interrupter.join().unwrap();
        let logs = logged(|| {
            let e = ApiError::from(anyhow::Error::from(error));
            assert_eq!(e.0, StatusCode::INTERNAL_SERVER_ERROR);
        });
        assert!(!logs.contains("ERROR"), "{logs}");
        assert!(logs.contains("Query interrupted"), "{logs}");
        // Other failures still log at ERROR.
        let logs = logged(|| {
            let _ = ApiError::from(anyhow::anyhow!("disk I/O error"));
        });
        assert!(
            logs.contains("ERROR") && logs.contains("disk I/O error"),
            "{logs}"
        );
    }

    #[test]
    fn ingestion_messages_stay_the_same() {
        // SDKs and collectors read these; dashboard paths word their own (see DashboardError).
        assert_eq!(
            ApiError::busy().1,
            "Capacity exhausted; retry with the same event IDs"
        );
        assert_eq!(ApiError::unauthorized().1, "Authentication required");
        assert_eq!(ApiError::project_missing().1, "Project not found");
    }
}
