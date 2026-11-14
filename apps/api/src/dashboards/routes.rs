//! Routes for dashboards. Everything under `/api/read` is non-mutating whatever its method,
//! so it carries no `X-Piko-Admin` guard and a read-only token can be scoped to the prefix.
use super::{
    bench::{Bench, bench_document},
    error::DashboardError,
    run::{RunRequest, run_widget},
    spec, sql,
    storage::{self, Origin, origin_from},
    validate::{Report, check_document, parse_document},
};
use crate::{
    AppState,
    changes::Signal,
    error::{ApiError, ApiResult},
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderName, Method, StatusCode, header},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};

pub fn read_router() -> Router<AppState> {
    Router::new()
        .route("/products", get(crate::list_products))
        .route("/products/{project}/query", post(query))
        .route("/products/{project}/logs/query", post(logs_query))
        .route("/products/{project}/widgets/run", post(run))
        .route("/products/{project}/catalog", get(catalog))
        .route("/products/{project}/dashboards", get(list))
        .route("/products/{project}/dashboards/validate", post(validate))
        .route("/products/{project}/dashboards/{key}", get(show))
        .route(
            "/products/{project}/dashboards/{key}/revisions",
            get(revisions),
        )
        .route("/schemas/dashboard.v1.json", get(schema))
}

/// CORS for `/api/read`: loopback origins, exact `extra` entries, or any origin when `extra`
/// holds `*`. The `null` origin is never allowed and credentials are never enabled.
pub fn read_cors(extra: Arc<Vec<String>>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            let Ok(origin) = origin.to_str() else {
                return false;
            };
            origin != "null"
                && (is_loopback(origin) || extra.iter().any(|e| e == "*" || e == origin))
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("cf-access-client-id"),
            HeaderName::from_static("cf-access-client-secret"),
        ])
}

/// `http(s)://localhost|127.0.0.1|[::1]` with an optional numeric port and nothing else.
fn is_loopback(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    let (host, port) = match rest.strip_prefix('[') {
        Some(inner) => match inner.split_once(']') {
            Some((addr, tail)) => (&rest[..addr.len() + 2], tail),
            None => return false,
        },
        None => match rest.find(':') {
            Some(at) => rest.split_at(at),
            None => (rest, ""),
        },
    };
    if !port.is_empty()
        && !port
            .strip_prefix(':')
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
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

async fn catalog(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(super::catalog::catalog(&state, &project).await?))
}

async fn schema() -> Json<Value> {
    Json(spec::schema())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    document: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    base_revision: i64,
    document: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Validate {
    document: Value,
}

type Body<T> = Result<Json<T>, JsonRejection>;
fn body<T>(body: Body<T>) -> Result<T, DashboardError> {
    body.map(|Json(v)| v)
        .map_err(|e| ApiError(e.status(), e.body_text()).into())
}
fn document(value: Value) -> Result<spec::Document, DashboardError> {
    parse_document(value).map_err(DashboardError::Invalid)
}
/// Refuses a document whose SQL fails verification, before anything is written. SQL is
/// described on the project's databases, so the project must exist first (`product` is its id).
async fn verify_sql(
    state: &AppState,
    product: &str,
    doc: &spec::Document,
) -> Result<(), DashboardError> {
    if !doc.widgets.iter().any(sql::has_sql) {
        return Ok(());
    }
    let mut report = check_document(doc);
    if !report.is_ok() {
        return Err(DashboardError::Invalid(report));
    }
    let id = product.to_string();
    state
        .store
        .state(move |db| crate::store::product(db, &id).map(|_| ()))
        .await?;
    sql::verify_document(state, product, doc, &mut report).await?;
    if report.is_ok() {
        Ok(())
    } else {
        Err(DashboardError::Invalid(report))
    }
}

/// Counts a write against the project's allowance of dashboard writes per minute.
fn throttle(state: &AppState, product: &str) -> Result<(), DashboardError> {
    state
        .write_limit
        .take(product)
        .map_err(|retry_after| DashboardError::RateLimited { retry_after })
}
/// The dashboard's current document, which unchanged widgets are compared with.
async fn current_document(
    state: &AppState,
    product: &str,
    key: &str,
) -> Result<spec::Document, DashboardError> {
    let (id, key) = (product.to_string(), key.to_string());
    let stored = state
        .store
        .state(move |db| Ok(storage::get(db, &id, &key)))
        .await??;
    Ok(stored.document)
}
/// The saved dashboard with the benchmark timings and any slow-widget warnings.
fn saved(stored: storage::Stored, bench: Bench) -> Value {
    let mut body = json!(stored);
    body["bench"] = json!(bench.timings);
    body["warnings"] = json!(bench.warnings);
    body
}

async fn list(
    State(state): State<AppState>,
    Path(project): Path<String>,
) -> Result<Json<Value>, DashboardError> {
    let summaries = state
        .store
        .state(move |db| {
            let id = crate::store::resolve_product(db, &project)?.id;
            Ok(storage::list(db, &id))
        })
        .await??;
    Ok(Json(json!(summaries)))
}
async fn show(
    State(state): State<AppState>,
    Path((project, key)): Path<(String, String)>,
) -> Result<Json<Value>, DashboardError> {
    let stored = state
        .store
        .state(move |db| {
            let id = crate::store::resolve_product(db, &project)?.id;
            Ok(storage::get(db, &id, &key))
        })
        .await??;
    Ok(Json(json!(stored)))
}
async fn revisions(
    State(state): State<AppState>,
    Path((project, key)): Path<(String, String)>,
) -> Result<Json<Value>, DashboardError> {
    let revisions = state
        .store
        .state(move |db| {
            let id = crate::store::resolve_product(db, &project)?.id;
            Ok(storage::revisions(db, &id, &key))
        })
        .await??;
    Ok(Json(json!(revisions)))
}
/// Errors fail the document; unknown event names and properties only warn, because the data
/// may arrive later.
async fn validate(
    State(state): State<AppState>,
    Path(project): Path<String>,
    request: Body<Validate>,
) -> Result<Json<Value>, DashboardError> {
    let Validate { document } = body(request)?;
    let catalog = super::catalog::catalog(&state, &project).await?;
    let mut report = match parse_document(document) {
        Ok(doc) => {
            let mut report = check_document(&doc);
            super::catalog::warn_unknown_document(&doc, &catalog, &mut report);
            let product = catalog["project"]["id"].as_str().unwrap_or_default();
            sql::verify_document(&state, product, &doc, &mut report).await?;
            report
        }
        Err(report) => report,
    };
    let Report { errors, warnings } = std::mem::take(&mut report);
    Ok(Json(
        json!({"valid": errors.is_empty(), "errors": errors, "warnings": warnings}),
    ))
}

pub fn write_routes() -> Router<AppState> {
    Router::new()
        .route("/api/products/{id}/dashboards", post(create))
        .route(
            "/api/products/{id}/dashboards/{key}",
            axum::routing::put(update).delete(remove),
        )
        .route(
            "/api/products/{id}/dashboards/{key}/revisions/{n}/restore",
            post(restore),
        )
}
async fn create(
    State(state): State<AppState>,
    Path(product): Path<String>,
    headers: HeaderMap,
    request: Body<Create>,
) -> Result<Json<Value>, DashboardError> {
    throttle(&state, &product)?;
    let doc = document(body(request)?.document)?;
    verify_sql(&state, &product, &doc).await?;
    let bench = bench_document(&state, &product, &doc, None).await?;
    let origin = origin_from(&headers);
    let id = product.clone();
    let stored = state
        .store
        .state(move |db| Ok(storage::create(db, &id, &doc, origin)))
        .await??;
    changed(&state, &product);
    Ok(Json(saved(stored, bench)))
}
async fn update(
    State(state): State<AppState>,
    Path((product, key)): Path<(String, String)>,
    headers: HeaderMap,
    request: Body<Update>,
) -> Result<Json<Value>, DashboardError> {
    let Update {
        base_revision,
        document: value,
    } = body(request)?;
    throttle(&state, &product)?;
    let doc = document(value)?;
    verify_sql(&state, &product, &doc).await?;
    let current = current_document(&state, &product, &key).await?;
    let bench = bench_document(&state, &product, &doc, Some(&current)).await?;
    let origin = origin_from(&headers);
    let id = product.clone();
    let stored = state
        .store
        .state(move |db| Ok(storage::update(db, &id, &key, base_revision, &doc, origin)))
        .await??;
    changed(&state, &product);
    Ok(Json(saved(stored, bench)))
}
async fn restore(
    State(state): State<AppState>,
    Path((product, key, n)): Path<(String, String, i64)>,
    headers: HeaderMap,
) -> Result<Json<Value>, DashboardError> {
    throttle(&state, &product)?;
    let origin: Origin = origin_from(&headers);
    let (id, revision_key) = (product.clone(), key.clone());
    let doc = state
        .store
        .state(move |db| Ok(storage::revision(db, &id, &revision_key, n)))
        .await??;
    verify_sql(&state, &product, &doc).await?;
    let current = current_document(&state, &product, &key).await?;
    let bench = bench_document(&state, &product, &doc, Some(&current)).await?;
    let id = product.clone();
    let stored = state
        .store
        .state(move |db| Ok(storage::restore(db, &id, &key, n, origin)))
        .await??;
    changed(&state, &product);
    Ok(Json(saved(stored, bench)))
}
async fn remove(
    State(state): State<AppState>,
    Path((product, key)): Path<(String, String)>,
) -> Result<StatusCode, DashboardError> {
    throttle(&state, &product)?;
    let id = product.clone();
    state
        .store
        .state(move |db| Ok(storage::delete(db, &id, &key)))
        .await??;
    changed(&state, &product);
    Ok(StatusCode::NO_CONTENT)
}

/// Called after every successful dashboard write. Clients refetch to learn the new revision.
pub fn changed(state: &AppState, product: &str) {
    state.store.changes.changed(product, Signal::Dashboards);
}
