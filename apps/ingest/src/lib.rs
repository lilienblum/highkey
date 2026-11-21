//! Highkey's ingest app: it receives events and logs, checks their keys against the registry in
//! ClickHouse, and acknowledges each request only after ClickHouse has stored it. It keeps no
//! state of its own.
pub mod changes;
pub mod clickhouse;
pub mod config;
pub mod contract;
pub mod dedup;
pub mod error;
pub mod exclusions;
pub mod keys;
pub mod logs;
pub mod model;
pub mod origins;
pub mod tracker;
pub mod writer;

pub use config::{ClickHouseConfig, Config};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use clickhouse::ClickHouse;
use contract::ContractError;
use error::{ApiError, ApiResult};
use keys::{KeyKind, KeyRecord, Keys};
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tower_http::cors::{Any, CorsLayer};

/// How long `start` keeps retrying an unreachable ClickHouse before giving up.
const STARTUP_WAIT: Duration = Duration::from_secs(60);

type DaySalt = Arc<std::sync::Mutex<Option<(chrono::NaiveDate, String)>>>;

fn current_salt(state: &DaySalt) -> String {
    let mut slot = state.lock().expect("day salt");
    let now = chrono::Utc::now();
    let today = now.date_naive();
    if let Some((date, salt)) = slot.as_ref()
        && *date == today
    {
        return salt.clone();
    }
    let salt = uuid::Uuid::new_v4().to_string();
    *slot = Some((today, salt.clone()));
    // A quiet source must not leave yesterday's secret resident until its next request.
    let weak = Arc::downgrade(state);
    let midnight = today
        .succ_opt()
        .expect("next day")
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    tokio::spawn(async move {
        tokio::time::sleep((midnight - now).to_std().unwrap_or_default()).await;
        if let Some(state) = weak.upgrade() {
            let mut slot = state.lock().expect("day salt");
            if slot.as_ref().is_some_and(|(date, _)| *date == today) {
                *slot = None;
            }
        }
    });
    salt
}

#[derive(Clone)]
pub struct AppState {
    day_salt: DaySalt,
    pub gateway_secret: Option<Arc<str>>,
    pub trust_proxy_ip: bool,
    pub clickhouse: ClickHouse,
    pub keys: Keys,
    pub changes: changes::Changes,
    pub events: writer::Writer<model::Event>,
    pub logs: writer::Writer<logs::model::Log>,
    ingest_slots: Arc<tokio::sync::Semaphore>,
    log_slots: Arc<tokio::sync::Semaphore>,
    pub tracker_path: Option<Arc<PathBuf>>,
}

/// Checks ClickHouse and the schema contract, then returns the app's state. An unreachable
/// ClickHouse is retried for up to a minute; a wrong version or contract fails at once.
pub async fn start(config: Config) -> anyhow::Result<AppState> {
    anyhow::ensure!(
        (1..=1024).contains(&config.queue_capacity),
        "HIGHKEY_QUEUE_CAPACITY must be 1–1024"
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
    let changes = changes::Changes::default();
    Ok(AppState {
        day_salt: DaySalt::default(),
        gateway_secret: None,
        trust_proxy_ip: std::env::var("HIGHKEY_TRUST_PROXY_IP").as_deref() == Ok("1"),
        keys: Keys::new(clickhouse.clone()),
        events: writer::Writer::spawn(clickhouse.clone(), config.queue_capacity, changes.clone()),
        logs: writer::Writer::spawn(clickhouse.clone(), logs::LOG_QUEUE, changes.clone()),
        ingest_slots: Arc::new(tokio::sync::Semaphore::new(config.queue_capacity)),
        log_slots: Arc::new(tokio::sync::Semaphore::new(logs::LOG_SLOTS)),
        clickhouse,
        changes,
        tracker_path: config.tracker_path.map(Arc::new),
    })
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// The request's Origin, when it sent exactly one.
fn origin(headers: &HeaderMap) -> Option<&str> {
    if headers.get_all(header::ORIGIN).iter().count() == 1 {
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
    } else {
        None
    }
}

/// Resolves the bearer key for `kind` and applies its origin rules, before any payload work.
pub(crate) async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    kind: KeyKind,
) -> ApiResult<KeyRecord> {
    let key = bearer(headers).ok_or_else(ApiError::unauthorized)?;
    let record = state.keys.resolve(key, kind).await?;
    if record.server_key && headers.contains_key(header::ORIGIN) {
        return Err(ApiError::forbidden(
            "Server event keys cannot be used from a browser",
        ));
    }
    origins::check(&record.allowed_origins, origin(headers))?;
    Ok(record)
}

async fn ingest_events(
    State(state): State<AppState>,
    peer: Option<axum::Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    headers: HeaderMap,
    payload: Result<Json<model::IngestPayload>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<model::Ack>> {
    let record = authorize(&state, &headers, KeyKind::Events).await?;
    let Json(payload) = payload.map_err(|e| ApiError(e.status(), e.body_text()))?;
    let mut events = payload.events();
    if events.is_empty() || events.len() > 100 {
        return Err(ApiError::bad("Provide 1–100 events per request"));
    }
    let now = chrono::Utc::now();
    // Keep only the SDK's bounded media-type parameter, never a raw user agent.
    let sdk = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';').skip(1).find_map(|p| match p.trim() {
                "highkey-sdk=browser" => Some("browser"),
                "highkey-sdk=typescript" => Some("typescript"),
                "highkey-sdk=rust" => Some("rust"),
                _ => None,
            })
        })
        .unwrap_or("http");
    let gateway = headers.contains_key("x-highkey-forwarded");
    let trusted = state.trust_proxy_ip;
    let ip = if gateway {
        use hmac::{Hmac, Mac};
        (|| {
            let ip = headers.get("x-highkey-source-ip")?.to_str().ok()?;
            let proof = headers.get("x-highkey-source-proof")?.to_str().ok()?;
            if !trusted || proof.len() != 64 || !proof.is_ascii() {
                return None;
            }
            let mut bytes = [0; 32];
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = u8::from_str_radix(&proof[i * 2..i * 2 + 2], 16).ok()?;
            }
            let mut mac =
                Hmac::<sha2::Sha256>::new_from_slice(state.gateway_secret.as_ref()?.as_bytes())
                    .ok()?;
            mac.update(b"highkey-ip:");
            mac.update(ip.as_bytes());
            mac.verify_slice(&bytes).ok()?;
            ip.parse().ok()
        })()
    } else if trusted {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<std::net::IpAddr>().ok())
    } else {
        peer.map(|v| v.0.0.ip())
    };
    let request_context = Arc::new(model::RequestContext {
        ip: ip
            .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
            .map(|v| v.to_string())
            .unwrap_or_default(),
        ua: headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.get(..v.len().min(512)))
            .unwrap_or("")
            .to_owned(),
        site: origin(&headers)
            .and_then(|v| reqwest::Url::parse(v).ok())
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default(),
        web: sdk == "browser",
        fetch: headers.contains_key("sec-fetch-mode"),
    });
    let private = headers.get("dnt").is_some_and(|v| v == "1")
        || headers.get("sec-gpc").is_some_and(|v| v == "1");
    let day_salt = if sdk == "browser"
        && !private
        && record.visitor_mode == "cookieless"
        && !request_context.ip.is_empty()
        && !request_context.ua.is_empty()
    {
        Some(current_salt(&state.day_salt))
    } else {
        None
    };
    let excluded_network = record.exclusions.network(ip);
    for (i, event) in events.iter_mut().enumerate() {
        event.sdk = sdk;
        event.request_context = request_context.clone();
        if event.properties.contains_key("revenue")
            && !record.server_key
            && !record.allow_browser_revenue
        {
            return Err(ApiError::forbidden(
                "Revenue requires a server event key or the project's browser-revenue opt-in",
            ));
        }
        event
            .validate(now, i64::from(record.retention_days))
            .map_err(|e| ApiError::bad(format!("events[{i}]: {}", e.1)))?;
        if excluded_network || record.exclusions.matches(event) {
            event.excluded = true;
            continue;
        }
        if sdk == "browser"
            || (event.source == "browser"
                && headers.contains_key(header::ORIGIN)
                && !record.server_key)
        {
            if record.visitor_mode != "persistent" || private {
                event.actor_id = None;
                event.identity_kind = None;
                event.session_id = None;
            }
            if event.visit_nonce.is_some()
                && !event.backfill
                && let Some(salt) = &day_salt
            {
                event.day_salt = salt.clone();
            }
        }
    }
    Ok(Json(
        state
            .events
            .submit(
                record.product_id,
                record.source_id,
                record.retention_days,
                events,
            )
            .await?,
    ))
}

/// Bounds concurrent event uploads and their total time, before any body is read.
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

pub fn router(state: AppState) -> Router {
    let ingest = Router::new()
        .route("/api/ingest", post(ingest_events).get(visitor_policy))
        .layer(middleware::from_fn_with_state(state.clone(), ingest_limit))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([axum::http::Method::POST, axum::http::Method::GET])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
                .expose_headers([header::RETRY_AFTER]),
        );
    Router::new()
        .merge(ingest)
        .merge(
            Router::new()
                .route("/api/logs/ingest", post(logs::ingest))
                .route("/api/logs/v1/logs", post(logs::ingest_otlp))
                .layer(middleware::from_fn_with_state(state.clone(), logs::limit)),
        )
        .route("/tracker.js", get(tracker::tracker))
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}
async fn visitor_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    let record = authorize(&state, &headers, KeyKind::Events).await?;
    Ok(Json(json!({"visitor_mode":record.visitor_mode})))
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

#[cfg(test)]
mod salt_tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn idle_collectors_discard_the_day_key_without_another_request() {
        let state = DaySalt::default();
        let first = current_salt(&state);
        assert_eq!(first, current_salt(&state));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(86400)).await;
        tokio::task::yield_now().await;
        assert!(state.lock().unwrap().is_none());
        assert_ne!(first, current_salt(&state));
    }
}
