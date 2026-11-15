mod common;
use common::{Kind, clickhouse, config, hash, post, seed_key, write_key};
use piko_ingest::{router, start};
use serde_json::{Value, json};
use std::time::Duration;

/// A body that passes authorization and then fails validation, so 400 proves the key worked.
fn empty_events() -> Value {
    json!({"events": []})
}

fn empty_logs() -> Value {
    json!({"logs": []})
}

async fn app() -> axum::Router {
    router(start(config(&clickhouse().url)).await.unwrap())
}

fn ids() -> (String, String) {
    (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    )
}

#[tokio::test]
async fn unknown_keys_are_401() {
    let app = app().await;
    let missing = post(&app, "/api/ingest", None, None, &empty_events()).await;
    assert_eq!(missing.status, 401);
    assert_eq!(missing.json()["error"], "Authentication required");
    let unknown = post(
        &app,
        "/api/ingest",
        Some("pk_unknown"),
        None,
        &empty_events(),
    )
    .await;
    assert_eq!(unknown.status, 401);
    let logs = post(
        &app,
        "/api/logs/ingest",
        Some("pl_unknown"),
        None,
        &empty_logs(),
    )
    .await;
    assert_eq!(logs.status, 401);
}

#[tokio::test]
async fn a_log_key_is_401_on_event_ingest_and_an_event_key_on_log_ingest() {
    let app = app().await;
    let (product, source) = ids();
    let events = seed_key(Kind::Events, &product, &source, &[], 30, false).await;
    let logs = seed_key(Kind::Logs, &product, &source, &[], 7, false).await;
    assert_eq!(
        post(&app, "/api/ingest", Some(&events), None, &empty_events())
            .await
            .status,
        400
    );
    assert_eq!(
        post(&app, "/api/logs/ingest", Some(&logs), None, &empty_logs())
            .await
            .status,
        400
    );
    assert_eq!(
        post(&app, "/api/ingest", Some(&logs), None, &empty_events())
            .await
            .status,
        401
    );
    assert_eq!(
        post(&app, "/api/logs/ingest", Some(&events), None, &empty_logs())
            .await
            .status,
        401
    );
}

#[tokio::test]
async fn revocation_takes_effect_within_the_cache_lifetime() {
    let app = app().await;
    let (product, source) = ids();
    let key = seed_key(Kind::Events, &product, &source, &[], 30, false).await;
    assert_eq!(
        post(&app, "/api/ingest", Some(&key), None, &empty_events())
            .await
            .status,
        400
    );
    write_key(Kind::Events, &hash(&key), &product, &source, &[], 30, true).await;
    // Still cached for up to five seconds.
    assert_eq!(
        post(&app, "/api/ingest", Some(&key), None, &empty_events())
            .await
            .status,
        400
    );
    tokio::time::sleep(Duration::from_millis(5_500)).await;
    assert_eq!(
        post(&app, "/api/ingest", Some(&key), None, &empty_events())
            .await
            .status,
        401
    );
}

#[tokio::test]
async fn a_key_created_after_a_miss_works_within_a_second() {
    let app = app().await;
    let (product, source) = ids();
    let secret = format!(
        "pk_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    assert_eq!(
        post(&app, "/api/ingest", Some(&secret), None, &empty_events())
            .await
            .status,
        401
    );
    write_key(
        Kind::Events,
        &hash(&secret),
        &product,
        &source,
        &[],
        30,
        false,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(
        post(&app, "/api/ingest", Some(&secret), None, &empty_events())
            .await
            .status,
        400
    );
}

#[tokio::test]
async fn restricted_origins_are_checked_before_the_payload() {
    let app = app().await;
    let (product, source) = ids();
    // The dashboard stores normalized origins.
    let key = seed_key(
        Kind::Events,
        &product,
        &source,
        &["https://example.com", "https://*.example.com"],
        30,
        false,
    )
    .await;
    for origin in [
        None,
        Some("null"),
        Some("https://evilexample.com"),
        Some("https://example.com.evil.test"),
        Some("http://app.example.com"),
        Some("https://app.example.com:444"),
    ] {
        let reply = post(&app, "/api/ingest", Some(&key), origin, &empty_events()).await;
        assert_eq!(reply.status, 403, "{origin:?}");
    }
    for origin in [
        "https://example.com",
        "https://app.example.com",
        "https://example.com:443",
    ] {
        let reply = post(
            &app,
            "/api/ingest",
            Some(&key),
            Some(origin),
            &empty_events(),
        )
        .await;
        assert_eq!(reply.status, 400, "{origin}");
    }
    // Two Origin headers count as none.
    let request = axum::http::Request::post("/api/ingest")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {key}"))
        .header("origin", "https://example.com")
        .header("origin", "https://example.com")
        .body(axum::body::Body::from(empty_events().to_string()))
        .unwrap();
    assert_eq!(common::send(&app, request).await.status, 403);
    // A key without rules accepts any origin.
    let open = seed_key(Kind::Events, &product, &source, &[], 30, false).await;
    assert_eq!(
        post(&app, "/api/ingest", Some(&open), None, &empty_events())
            .await
            .status,
        400
    );
}
