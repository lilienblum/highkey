pub mod keys;
pub mod model;
pub mod otlp;
pub mod query;
pub mod writer;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use serde::Deserialize;
use serde_json::Value;

pub async fn limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let otlp_request = request.uri().path().ends_with("/v1/logs");
    let protobuf = request
        .headers()
        .get("content-type")
        .is_some_and(|v| v.as_bytes().starts_with(b"application/x-protobuf"));
    let result = match state.log_ingest_slots.try_acquire() {
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
async fn authorize(state: &AppState, headers: &HeaderMap) -> ApiResult<(String, String, i64)> {
    let key = crate::bearer(headers)
        .ok_or_else(ApiError::unauthorized)?
        .to_owned();
    state.store.state(move |db| keys::resolve(db, &key)).await
}
async fn commit(
    state: &AppState,
    project: String,
    source: String,
    retention: i64,
    mut records: Vec<model::Log>,
) -> ApiResult<crate::model::Ack> {
    if records.is_empty() || records.len() > model::MAX_BATCH {
        return Err(ApiError::bad("Provide 1–100 logs per request"));
    }
    let now = chrono::Utc::now();
    for (index, log) in records.iter_mut().enumerate() {
        log.validate(now, retention)
            .map_err(|e| ApiError::bad(format!("logs[{index}]: {}", e.1)))?;
    }
    state.log_writer.ingest(project, source, records).await
}
pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<model::Payload>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<crate::model::Ack>> {
    let (project, source, retention) = authorize(&state, &headers).await?;
    let Json(payload) = payload.map_err(|e| ApiError(e.status(), e.body_text()))?;
    Ok(Json(
        commit(&state, project, source, retention, payload.records()).await?,
    ))
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
        let (project, source, retention) = authorize(&state, &headers).await?;
        let body = body.map_err(|e| ApiError(e.status(), e.body_text()))?;
        let records = tokio::task::spawn_blocking(move || otlp::decode(&headers, &body))
            .await
            .map_err(|e| ApiError::from(anyhow::anyhow!(e)))??;
        if !records.is_empty() {
            commit(&state, project, source, retention, records).await?;
        }
        Ok(())
    }
    .await;
    otlp::response(result, protobuf)
}
pub async fn query(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(query): Json<query::Query>,
) -> ApiResult<Json<Value>> {
    Ok(Json(query::run(state.store, id, query).await?))
}
pub async fn settings(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state.store.state(move |db| keys::settings(db, &id)).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    retention_days: i64,
}
pub async fn update_settings(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<Settings>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .store
            .state(move |db| keys::set_retention(db, &id, input.retention_days))
            .await?,
    ))
}
pub async fn list_keys(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Value>>> {
    Ok(Json(
        state.store.state(move |db| keys::list(db, &id)).await?,
    ))
}
pub async fn create_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<keys::KeyInput>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        state
            .store
            .state(move |db| keys::create(db, &id, input))
            .await?,
    ))
}
pub async fn revoke_key(
    State(state): State<AppState>,
    Path((id, key)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    state
        .store
        .state(move |db| keys::revoke(db, &id, &key))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
