use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::clickhouse::ChError;

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
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self(StatusCode::FORBIDDEN, message.into())
    }
    /// No capacity left, or storage is briefly unavailable. SDKs retry with the same event IDs,
    /// so deduplication holds.
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
    pub fn database() -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database operation failed".into(),
        )
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "Database operation failed");
        Self::database()
    }
}
impl From<ChError> for ApiError {
    /// ClickHouse being unreachable, overloaded or slow is worth a retry; anything else it
    /// rejects is a bug in what the ingest app sent.
    fn from(e: ChError) -> Self {
        if e.transient {
            tracing::warn!(code = ?e.code, "ClickHouse unavailable");
            Self::busy()
        } else {
            tracing::error!(code = ?e.code, "Database operation failed");
            Self::database()
        }
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

    #[test]
    fn ingestion_messages_stay_the_same() {
        // SDKs and collectors read these.
        assert_eq!(
            ApiError::busy().1,
            "Capacity exhausted; retry with the same event IDs"
        );
        assert_eq!(ApiError::unauthorized().1, "Authentication required");
    }

    #[test]
    fn transient_clickhouse_errors_are_retryable() {
        let busy = ApiError::from(ChError::transient("connection refused"));
        assert_eq!(busy.0, StatusCode::SERVICE_UNAVAILABLE);
        let bad = ApiError::from(ChError {
            transient: false,
            code: Some(27),
            message: "Cannot parse input".into(),
        });
        assert_eq!(bad.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(bad.1, "Database operation failed");
    }
}
