//! Routes for dashboards. Everything under `/api/read` is non-mutating whatever its method,
//! so it carries no `X-Piko-Admin` guard and a read-only token can be scoped to the prefix.
use super::{
    error::DashboardError,
    run::{RunRequest, run_widget},
    spec,
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    routing::{get, post},
};
use serde_json::Value;

pub fn read_router() -> Router<AppState> {
    Router::new()
        .route("/products", get(crate::list_products))
        .route("/products/{project}/query", post(query))
        .route("/products/{project}/logs/query", post(logs_query))
        .route("/products/{project}/widgets/run", post(run))
        .route("/schemas/dashboard.v1.json", get(schema))
}

/// The id of the project named by id or slug.
async fn project_id(state: &AppState, project: String) -> ApiResult<String> {
    state
        .store
        .state(move |db| Ok(crate::store::resolve_product(db, &project)?.id))
        .await
}

async fn query(
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Json<crate::query::Query>,
) -> ApiResult<Json<Value>> {
    let id = project_id(&state, project).await?;
    crate::query_product(State(state), Path(id), body).await
}

async fn logs_query(
    State(state): State<AppState>,
    Path(project): Path<String>,
    body: Json<crate::logs::query::Query>,
) -> ApiResult<Json<Value>> {
    let id = project_id(&state, project).await?;
    crate::logs::query(State(state), Path(id), body).await
}

async fn run(
    State(state): State<AppState>,
    Path(project): Path<String>,
    request: Result<Json<RunRequest>, JsonRejection>,
) -> Result<Json<Value>, DashboardError> {
    let Json(request) = request.map_err(|e| ApiError(e.status(), e.body_text()))?;
    Ok(Json(run_widget(&state, &project, request).await?))
}

async fn schema() -> Json<Value> {
    Json(spec::schema())
}
