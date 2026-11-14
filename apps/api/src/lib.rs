pub mod changes;
pub mod dashboards;
pub mod error;
pub mod ingest;
pub mod logs;
pub mod model;
pub mod origins;
pub mod product_db;
pub mod query;
pub mod runtime;
pub mod sources;
pub mod store;
pub mod telemetry;
pub mod views;
pub mod website;
pub mod workspace;
use crate::{
    error::{ApiError, ApiResult},
    ingest::Writer,
    model::{IngestPayload, Product, ProductInput},
    store::Store,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub writer: Writer,
    pub changes: changes::Changes,
    pub log_writer: logs::writer::Writer,
    log_ingest_slots: Arc<tokio::sync::Semaphore>,
    ingest_slots: Arc<tokio::sync::Semaphore>,
    favicon_slots: Arc<tokio::sync::Semaphore>,
    /// DuckDB's parser for verifying dashboard SQL, shared by every request.
    pub sql_parser: Arc<dashboards::sql::Parser>,
    /// Extra origins allowed to call `/api/read` cross-origin (`*` allows all).
    pub cors_origins: Arc<Vec<String>>,
    /// Dashboard writes per project per minute; replace it to change the limit.
    pub write_limit: Arc<dashboards::limit::WriteLimit>,
}
pub struct Config {
    pub data_dir: PathBuf,
    pub query_concurrency: usize,
    pub queue_capacity: usize,
}
impl AppState {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        anyhow::ensure!(
            (1..=16).contains(&config.query_concurrency)
                && (1..=1024).contains(&config.queue_capacity),
            "query concurrency must be 1–16 and queue capacity 1–1024"
        );
        let store = Store::open(&config.data_dir, config.query_concurrency)?;
        let writer = Writer::start(store.clone(), config.queue_capacity);
        let log_writer = logs::writer::Writer::start(store.clone())?;
        Ok(Self {
            changes: store.changes.clone(),
            store,
            writer,
            log_writer,
            log_ingest_slots: Arc::new(tokio::sync::Semaphore::new(16)),
            ingest_slots: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
            favicon_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            sql_parser: Arc::new(dashboards::sql::Parser::open()?),
            cors_origins: Arc::default(),
            write_limit: Arc::default(),
        })
    }
}
pub fn router(state: AppState) -> Router {
    let admin = Router::new()
        .route("/api/products", get(list_products).post(create_product))
        .route("/api/products/{id}", patch(update_product))
        .route("/api/products/{id}/favicon", get(project_favicon))
        .route(
            "/api/products/{id}/sources",
            get(list_sources).post(create_source),
        )
        .route("/api/products/{id}/sources/{source}", patch(update_source))
        .route("/api/products/{id}/keys", get(list_keys).post(create_key))
        .route(
            "/api/products/{id}/keys/{key}",
            delete(revoke_key).patch(update_key_origins),
        )
        .route("/api/products/{id}/query", post(query_product))
        .route("/api/products/{id}/logs/query", post(logs::query))
        .route(
            "/api/products/{id}/logs/settings",
            get(logs::settings).patch(logs::update_settings),
        )
        .route(
            "/api/products/{id}/logs/keys",
            get(logs::list_keys).post(logs::create_key),
        )
        .route(
            "/api/products/{id}/logs/keys/{key}",
            delete(logs::revoke_key),
        )
        .route("/api/cleanup", post(run_cleanup))
        .merge(dashboards::routes::write_routes())
        .merge(views::write_routes())
        .route_layer(middleware::from_fn(management_request));
    let ingest = Router::new()
        .route("/api/ingest", post(ingest_events))
        .layer(middleware::from_fn_with_state(state.clone(), ingest_limit))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([axum::http::Method::POST])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
                .expose_headers([header::RETRY_AFTER]),
        );
    Router::new()
        .merge(
            Router::new()
                .route("/api/logs/ingest", post(logs::ingest))
                .route("/api/logs/v1/logs", post(logs::ingest_otlp))
                .layer(middleware::from_fn_with_state(state.clone(), logs::limit)),
        )
        .merge(admin)
        .merge(ingest)
        // Outside `admin`, so read routes need no X-Piko-Admin marker.
        .nest(
            "/api/read",
            dashboards::routes::read_router(state.clone())
                .layer(dashboards::routes::read_cors(state.cors_origins.clone())),
        )
        // The full MCP changes dashboards, so it sits where the management routes do, behind
        // Cloudflare Access. It is outside the `X-Piko-Admin` marker, which is for browsers:
        // the MCP refuses any request that carries a browser `Origin` itself.
        .nest_service("/api/mcp", dashboards::mcp::service(state.clone(), true))
        .route("/api/{*path}", get(|| async { ApiError::missing() }))
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
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(k),
            v.parse().expect("static header"),
        );
    }
    response
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
// This is a CSRF request marker, not authentication. Network/edge access controls are required.
async fn management_request(req: Request, next: Next) -> ApiResult<Response> {
    if req.method() != axum::http::Method::GET
        && req
            .headers()
            .get("x-piko-admin")
            .and_then(|v| v.to_str().ok())
            != Some("1")
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Management requests require X-Piko-Admin: 1".into(),
        ));
    }
    Ok(next.run(req).await)
}
async fn ingest_limit(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> ApiResult<Response> {
    let _permit = state
        .ingest_slots
        .try_acquire()
        .map_err(|_| ApiError::busy())?;
    tokio::time::timeout(Duration::from_secs(12), next.run(req))
        .await
        .map_err(|_| ApiError::busy())
}
async fn ingest_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<IngestPayload>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<model::Ack>> {
    let key = bearer(&headers)
        .ok_or_else(ApiError::unauthorized)?
        .to_string();
    let origin = if headers.get_all(header::ORIGIN).iter().count() == 1 {
        headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    } else {
        None
    };
    let (p, source_id) = state
        .store
        .state(move |db| store::resolve_key(db, &key, origin.as_deref()))
        .await?;
    let Json(payload) = payload.map_err(|e| ApiError(e.status(), e.body_text()))?;
    let mut events = payload.events();
    if events.is_empty() || events.len() > 100 {
        return Err(ApiError::bad("Provide 1–100 events per request"));
    }
    let now = chrono::Utc::now();
    for (i, event) in events.iter_mut().enumerate() {
        event
            .validate(now, p.retention_days)
            .map_err(|e| ApiError::bad(format!("events[{i}]: {}", e.1)))?;
    }
    Ok(Json(state.writer.ingest(p.id, source_id, events).await?))
}
pub(crate) async fn list_products(State(s): State<AppState>) -> ApiResult<Json<Vec<Product>>> {
    Ok(Json(s.store.state(store::products).await?))
}
async fn create_product(
    State(s): State<AppState>,
    Json(input): Json<ProductInput>,
) -> ApiResult<Json<Product>> {
    Ok(Json(workspace::create_project(&s, input).await?))
}
async fn update_product(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<ProductInput>,
) -> ApiResult<Json<Product>> {
    Ok(Json(workspace::update_project(&s, id, input).await?))
}
async fn project_favicon(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Response> {
    use rusqlite::OptionalExtension;
    let bytes = s
        .store
        .state(move |db| {
            db.query_row("SELECT favicon FROM products WHERE id=?", [id], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .optional()
            .map_err(anyhow::Error::from)?
            .flatten()
            .ok_or_else(ApiError::missing)
        })
        .await?;
    let kind = website::content_type(&bytes).ok_or_else(ApiError::missing)?;
    Ok((
        [
            ("content-type", kind),
            ("content-security-policy", "default-src 'none'; sandbox"),
        ],
        bytes,
    )
        .into_response())
}
async fn list_keys(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<model::KeyInfo>>> {
    Ok(Json(s.store.state(move |db| store::keys(db, &id)).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewKey {
    #[serde(default)]
    allowed_origins: Vec<String>,
    label: String,
    source_id: Option<String>,
}
async fn create_key(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<NewKey>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        workspace::create_key(&s, id, input.label, input.source_id, input.allowed_origins).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyOrigins {
    allowed_origins: Vec<String>,
}
async fn update_key_origins(
    State(s): State<AppState>,
    Path((id, key)): Path<(String, String)>,
    Json(input): Json<KeyOrigins>,
) -> ApiResult<StatusCode> {
    workspace::update_key_origins(&s, id, key, input.allowed_origins).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn revoke_key(
    State(s): State<AppState>,
    Path((id, key)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    workspace::revoke_key(&s, id, key).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(crate) async fn query_product(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(q): Json<query::Query>,
) -> ApiResult<Json<Value>> {
    q.validate()?;
    let lookup = id.clone();
    let source_id = q.source_id.clone();
    s.store
        .state(move |db| {
            let product = store::product(db, &lookup)?;
            if let Some(source_id) = source_id {
                sources::get(db, &lookup, &source_id)?;
            }
            Ok(product)
        })
        .await?;
    Ok(Json(
        s.store
            .query(id.clone(), move |db| query::run(db, &id, q))
            .await?,
    ))
}
async fn run_cleanup(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"removed":s.writer.cleanup().await?,"logs_removed":s.log_writer.cleanup().await?}),
    ))
}

async fn list_sources(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<model::Source>>> {
    Ok(Json(
        s.store
            .state(move |db| Ok(store::product(db, &id)?.sources))
            .await?,
    ))
}
async fn create_source(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<model::SourceInput>,
) -> ApiResult<Json<model::Source>> {
    Ok(Json(workspace::create_source(&s, id, input).await?))
}
async fn update_source(
    State(s): State<AppState>,
    Path((id, source)): Path<(String, String)>,
    Json(input): Json<model::SourceInput>,
) -> ApiResult<Json<model::Source>> {
    Ok(Json(workspace::update_source(&s, id, source, input).await?))
}
