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
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};

async fn commit(
    _state: &AppState,
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
    Err(ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "Log writes arrive in a later change".into(),
    ))
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
