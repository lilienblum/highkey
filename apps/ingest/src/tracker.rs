//! Serves the browser tracker. It lives here, not in the dashboard, so dashboard deploys
//! never take it offline.
use axum::{
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::AppState;

pub async fn tracker(State(state): State<AppState>) -> Response {
    let Some(path) = state.tracker_path.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(path).await {
        Ok(source) => (
            [
                (
                    header::CONTENT_TYPE,
                    "application/javascript; charset=utf-8",
                ),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            source,
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, path = %path.display(), "Cannot read the tracker");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
