pub mod model;
pub mod otlp;

use crate::{
    AppState, authorize,
    error::{ApiError, ApiResult},
    keys::{KeyKind, KeyRecord},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Request, State},
    http::HeaderMap,
    middleware::Next,
    response::Response,
};

/// Concurrent log uploads, as before the split.
pub const LOG_SLOTS: usize = 16;
/// Log requests that may wait for a write.
pub const LOG_QUEUE: usize = 16;

/// Bounds concurrent log uploads and their total time, answering OTLP clients in their format.
pub async fn limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let otlp_request = request.uri().path().ends_with("/v1/logs");
    let protobuf = request
        .headers()
        .get("content-type")
        .is_some_and(|v| v.as_bytes().starts_with(b"application/x-protobuf"));
    let result = match state.log_slots.try_acquire() {
        Err(_) => Err(ApiError::busy()),
        Ok(_permit) => tokio::time::timeout(std::time::Duration::from_secs(12), next.run(request))
            .await
            .map_err(|_| ApiError::busy()),
    };
    match result {
        Ok(response) => response,
        Err(error) if otlp_request => otlp::response(Err(error), protobuf),
        Err(error) => axum::response::IntoResponse::into_response(error),
    }
}

async fn commit(
    state: &AppState,
    record: KeyRecord,
    mut records: Vec<model::Log>,
) -> ApiResult<crate::model::Ack> {
    if records.is_empty() || records.len() > model::MAX_BATCH {
        return Err(ApiError::bad("Provide 1–100 logs per request"));
    }
    let now = chrono::Utc::now();
    for (index, log) in records.iter_mut().enumerate() {
        log.validate(now, i64::from(record.retention_days))
            .map_err(|e| ApiError::bad(format!("logs[{index}]: {}", e.1)))?;
    }
    state
        .logs
        .submit(
            record.product_id,
            record.source_id,
            record.retention_days,
            records,
        )
        .await
}

pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<model::Payload>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<crate::model::Ack>> {
    let record = authorize(&state, &headers, KeyKind::Logs).await?;
    let Json(payload) = payload.map_err(|e| ApiError(e.status(), e.body_text()))?;
    Ok(Json(commit(&state, record, payload.records()).await?))
}

pub async fn ingest_otlp(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let protobuf = headers
        .get("content-type")
        .is_some_and(|v| v.as_bytes().starts_with(b"application/x-protobuf"));
    let result = async {
        let record = authorize(&state, &headers, KeyKind::Logs).await?;
        let body = body.map_err(|e| ApiError(e.status(), e.body_text()))?;
        let records = tokio::task::spawn_blocking(move || otlp::decode(&headers, &body))
            .await
            .map_err(|e| ApiError::from(anyhow::anyhow!(e)))??;
        if !records.is_empty() {
            commit(&state, record, records).await?;
        }
        Ok(())
    }
    .await;
    otlp::response(result, protobuf)
}
