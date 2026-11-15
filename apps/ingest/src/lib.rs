//! Piko's ingest app: it receives events and logs, checks their keys against the registry in
//! ClickHouse, and acknowledges each request only after ClickHouse has stored it. It keeps no
//! state of its own.
pub mod changes;
pub mod clickhouse;
pub mod config;
pub mod contract;
pub mod error;
pub mod logs;
pub mod model;
pub mod origins;
pub mod tracker;

pub use config::{ClickHouseConfig, Config};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use clickhouse::ClickHouse;
use contract::ContractError;
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tower_http::cors::{Any, CorsLayer};

/// How long `start` keeps retrying an unreachable ClickHouse before giving up.
const STARTUP_WAIT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AppState {
    pub clickhouse: ClickHouse,
    pub changes: changes::Changes,
    pub tracker_path: Option<Arc<PathBuf>>,
}

/// Checks ClickHouse and the schema contract, then returns the app's state. An unreachable
/// ClickHouse is retried for up to a minute; a wrong version or contract fails at once.
pub async fn start(config: Config) -> anyhow::Result<AppState> {
    anyhow::ensure!(
        (1..=1024).contains(&config.queue_capacity),
        "PIKO_QUEUE_CAPACITY must be 1–1024"
    );
    let clickhouse = ClickHouse::new(&config.clickhouse)?;
    let deadline = tokio::time::Instant::now() + STARTUP_WAIT;
    loop {
        match contract::check(&clickhouse).await {
            Ok(()) => break,
            Err(ContractError::Unreachable(message)) if tokio::time::Instant::now() < deadline => {
                tracing::warn!(%message, "Waiting for ClickHouse");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(AppState {
        clickhouse,
        changes: changes::Changes::default(),
        tracker_path: config.tracker_path.map(Arc::new),
    })
}

async fn not_yet() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error": "Not implemented"})),
    )
}

pub fn router(state: AppState) -> Router {
    let ingest = Router::new().route("/api/ingest", post(not_yet)).layer(
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([axum::http::Method::POST])
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
            .expose_headers([header::RETRY_AFTER]),
    );
    Router::new()
        .merge(ingest)
        .route("/api/logs/ingest", post(not_yet))
        .route("/api/logs/v1/logs", post(not_yet))
        .route("/tracker.js", get(tracker::tracker))
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    for (k, v) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
    ] {
        // The tracker sets its own cache lifetime.
        let name = axum::http::HeaderName::from_static(k);
        if !response.headers().contains_key(&name) {
            response
                .headers_mut()
                .insert(name, v.parse().expect("static header"));
        }
    }
    response
}
