mod common;
use axum::Router;
use common::{
    ADMIN_PASSWORD, CutProxy, INGEST_PASSWORD, Kind, admin_query, clickhouse, config, get, post,
    seed_key,
};
use piko_ingest::{AppState, changes::Signal, router, start};
use serde_json::{Value, json};
use std::time::Duration;

fn event(id: &str, n: Value) -> Value {
    json!({"event_id":id,"name":"command_run","source":"cli","actor_id":"anonymous-install","identity_kind":"installation","properties":{"duration_ms":n,"success":true,"command":"build"}})
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn app_with(capacity: usize, url: &str) -> (Router, AppState) {
    let mut settings = config(url);
    settings.queue_capacity = capacity;
    let state = start(settings).await.unwrap();
    (router(state.clone()), state)
}

async fn app() -> (Router, AppState) {
    app_with(64, &clickhouse().url).await
}

/// A project with one source and an event key, returning (product, key).
async fn project(retention: u16) -> (String, String) {
    let product = uuid();
    let key = seed_key(Kind::Events, &product, &product, &[], retention, false).await;
    (product, key)
}

async fn stored(product: &str) -> Vec<Value> {
    admin_query(&format!(
        "SELECT event_id, name, source, toString(source_id) AS source_id, actor_id, identity_kind, session_id, properties, toUnixTimestamp64Milli(event_time) AS event_ms, toUnixTimestamp(expires_at) AS expires_s FROM piko.events FINAL WHERE product_id = '{product}' ORDER BY event_id"
    ))
    .await
}

/// The next change hint, failing the test instead of hanging when none arrives.
async fn recv(
    changes: &mut tokio::sync::broadcast::Receiver<(String, Signal)>,
) -> (String, Signal) {
    tokio::time::timeout(Duration::from_secs(10), changes.recv())
        .await
        .expect("a change hint within 10 s")
        .unwrap()
}

async fn ingest(app: &Router, key: &str, body: Value) -> common::Reply {
    let reply = post(
        app,
        "/api/ingest",
        Some(key),
        Some("https://website.example"),
        &body,
    )
    .await;
    assert_eq!(reply.headers["access-control-allow-origin"], "*");
    assert_eq!(
        reply.headers["access-control-expose-headers"],
        "retry-after"
    );
    if reply.status == 503 {
        assert_eq!(reply.headers["retry-after"], "1");
    }
    reply
}

#[tokio::test]
async fn durable_deduplicated_scoped_typed_queries() {
    let (app, _) = app().await;
    let (a, key_a) = project(30).await;
    let (b, key_b) = project(30).await;
    let batch = json!({"events":[event("one",json!(10)),event("two",json!(30)),event("text",json!("1000"))]});
    let ack = ingest(&app, &key_a, batch.clone()).await;
    assert_eq!(ack.status, 200, "{}", ack.text());
    assert_eq!(ack.json(), json!({"accepted": 3, "duplicates": 0}));
    assert_eq!(
        ingest(&app, &key_a, batch).await.json(),
        json!({"accepted": 0, "duplicates": 3})
    );
    assert_eq!(
        ingest(&app, &key_b, event("one", json!(90))).await.json()["accepted"],
        1
    );
    let rows = stored(&a).await;
    assert_eq!(rows.len(), 3);
    let one = rows.iter().find(|r| r["event_id"] == "one").unwrap();
    assert_eq!(one["properties"]["duration_ms"], 10);
    assert_eq!(one["properties"]["success"], true);
    let text = rows.iter().find(|r| r["event_id"] == "text").unwrap();
    assert_eq!(text["properties"]["duration_ms"], "1000");
    assert_eq!(stored(&b).await.len(), 1);
    let mut forged = event("forged", json!(1));
    forged["product_id"] = json!(b);
    assert_eq!(ingest(&app, &key_a, forged).await.status, 422);
}

#[tokio::test]
async fn invalid_batch_is_atomic_and_keys_are_revocable() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let mut invalid = event("invalid", json!(10));
    invalid["properties"]["nested"] = json!({"no":true});
    let reply = ingest(
        &app,
        &key,
        json!({"events":[event("valid",json!(1)),invalid]}),
    )
    .await;
    assert_eq!(reply.status, 400);
    assert!(
        reply.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("events[1]:")
    );
    assert!(stored(&id).await.is_empty());
}

#[tokio::test]
async fn retention_is_product_specific_and_uses_event_time() {
    let (app, _) = app().await;
    let (_, short) = project(1).await;
    let (long_id, long) = project(30).await;
    let mut old = event("old", json!(5));
    let time = chrono::Utc::now() - chrono::Duration::days(3);
    old["timestamp"] = json!(time.to_rfc3339());
    assert_eq!(ingest(&app, &short, old.clone()).await.status, 400);
    assert_eq!(ingest(&app, &long, old).await.status, 200);
    let rows = stored(&long_id).await;
    assert_eq!(
        rows[0]["event_ms"].as_i64().unwrap(),
        time.timestamp_millis()
    );
    let expires = (time + chrono::Duration::days(30)).timestamp();
    assert_eq!(rows[0]["expires_s"].as_u64().unwrap() as i64, expires);
}

#[tokio::test]
async fn concurrent_ingestion_queries_and_controlled_overload() {
    let (app, _) = app_with(1, &clickhouse().url).await;
    let (id, key) = project(30).await;
    let mut jobs = tokio::task::JoinSet::new();
    for i in 0..40 {
        let app = app.clone();
        let key = key.clone();
        jobs.spawn(async move {
            let reply = ingest(&app, &key, event(&format!("event-{i}"), json!(i))).await;
            (reply.status, reply.json())
        });
    }
    let (mut accepted, mut overloaded) = (0, 0);
    while let Some(result) = jobs.join_next().await {
        match result.unwrap() {
            (200, _) => accepted += 1,
            (503, body) => {
                assert_eq!(
                    body["error"],
                    "Capacity exhausted; retry with the same event IDs"
                );
                overloaded += 1;
            }
            (status, body) => panic!("Unexpected {status}: {body}"),
        }
    }
    assert!(accepted > 0 && overloaded > 0, "{accepted} {overloaded}");
    assert_eq!(stored(&id).await.len(), accepted);
}

#[tokio::test]
async fn visitor_and_installation_ids_do_not_collapse() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let mut web = event("web", json!(1));
    web["identity_kind"] = json!("visitor");
    web["source"] = json!("browser");
    web["session_id"] = json!("session");
    ingest(&app, &key, json!({"events":[web,event("cli",json!(2))]})).await;
    let rows = stored(&id).await;
    let kinds: Vec<_> = rows
        .iter()
        .map(|r| (r["identity_kind"].clone(), r["session_id"].clone()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (json!("installation"), Value::Null),
            (json!("visitor"), json!("session"))
        ]
    );
}

#[tokio::test]
async fn committed_changes_are_visible_scoped_and_skip_duplicate_retries() {
    let (app, state) = app().await;
    let (a, ka) = project(30).await;
    let (b, kb) = project(30).await;
    let mut changes = state.changes.subscribe();
    let request = {
        let (app, ka) = (app.clone(), ka.clone());
        tokio::spawn(async move { ingest(&app, &ka, event("one", json!(12))).await })
    };
    assert_eq!(recv(&mut changes).await, (a.clone(), Signal::Events));
    // Readable as soon as the signal arrives, independently of the acknowledgment.
    assert_eq!(stored(&a).await.len(), 1);
    let reply = request.await.unwrap();
    assert_eq!(reply.json()["accepted"], 1);
    assert_eq!(
        ingest(&app, &ka, event("one", json!(12))).await.json()["duplicates"],
        1
    );
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    assert_eq!(
        ingest(&app, &kb, event("one", json!(24))).await.json()["accepted"],
        1
    );
    assert_eq!(recv(&mut changes).await, (b.clone(), Signal::Events));
    let mut invalid = event("invalid", json!(12));
    invalid["properties"]["nested"] = json!({"invalid": true});
    assert_eq!(ingest(&app, &ka, invalid).await.status, 400);
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn unavailable_change_sink_does_not_change_ingestion_acknowledgments() {
    use piko_ingest::changes::ChangeDelivery;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    let sink = Router::new().route(
        "/changes",
        axum::routing::post(move || {
            let tx = tx.clone();
            async move {
                let _ = tx.send(()).await;
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, sink).await.unwrap() });
    let (app, state) = app().await;
    let (id, key) = project(30).await;
    let worker = state
        .changes
        .start_delivery(
            ChangeDelivery::new(
                &format!("http://{address}/changes"),
                "test-only-token".into(),
            )
            .unwrap(),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("the sink is called")
        .unwrap();
    let reply = ingest(&app, &key, event("committed", json!(42))).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["accepted"], 1);
    assert_eq!(stored(&id).await.len(), 1);
    worker.abort();
    server.abort();
}

#[tokio::test]
async fn multiple_sources_share_a_project_but_keys_and_filters_are_scoped() {
    let (app, _) = app().await;
    let product = uuid();
    let mobile = uuid();
    let original = seed_key(Kind::Events, &product, &product, &[], 30, false).await;
    let mobile_key = seed_key(Kind::Events, &product, &mobile, &[], 30, false).await;
    assert_eq!(
        ingest(&app, &original, event("cli-1", json!(10)))
            .await
            .json()["accepted"],
        1
    );
    assert_eq!(
        ingest(&app, &mobile_key, event("mobile-1", json!(20)))
            .await
            .json()["accepted"],
        1
    );
    // Sources share the project's deduplication namespace.
    assert_eq!(
        ingest(&app, &mobile_key, event("cli-1", json!(99)))
            .await
            .json()["duplicates"],
        1
    );
    let rows = stored(&product).await;
    let sources: Vec<_> = rows
        .iter()
        .map(|r| {
            (
                r["event_id"].as_str().unwrap(),
                r["source_id"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        sources,
        vec![("cli-1", product.as_str()), ("mobile-1", mobile.as_str())]
    );
}

#[tokio::test]
async fn duplicates_within_the_window_are_counted_and_not_stored() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let ack = ingest(
        &app,
        &key,
        json!({"events":[event("x",json!(1)),event("x",json!(2)),event("y",json!(3))]}),
    )
    .await;
    assert_eq!(ack.json(), json!({"accepted": 2, "duplicates": 1}));
    let rows = stored(&id).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0]["properties"]["duration_ms"], 1,
        "the first copy wins"
    );
}

#[tokio::test]
async fn a_duplicate_older_than_the_window_is_stored_and_a_merge_keeps_the_first() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let time = chrono::Utc::now() - chrono::Duration::hours(25);
    let at = time.format("%Y-%m-%d %H:%M:%S%.3f");
    admin_query(&format!(
        "INSERT INTO piko.events (product_id, source_id, event_id, name, source, event_time, received_at, properties, expires_at) VALUES ('{id}', '{id}', 'late', 'command_run', 'cli', '{at}', '{at}', '{{\"v\":1}}', now() + INTERVAL 30 DAY)"
    ))
    .await;
    let mut late = event("late", json!(2));
    late["timestamp"] = json!(time.to_rfc3339());
    late["properties"] = json!({"v": 2});
    assert_eq!(
        ingest(&app, &key, late).await.json(),
        json!({"accepted": 1, "duplicates": 0})
    );
    admin_query("OPTIMIZE TABLE piko.events FINAL").await;
    let rows = stored(&id).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["properties"]["v"], 1);
}

#[tokio::test]
async fn connection_loss_returns_503_and_recovers() {
    let proxy = CutProxy::start().await;
    let (app, _) = app_with(64, &proxy.url).await;
    let (id, key) = project(30).await;
    let first = json!({"events":[event("before",json!(1))]});
    assert_eq!(ingest(&app, &key, first).await.status, 200);
    let batch = json!({"events":[event("during",json!(2)),event("again",json!(3))]});
    proxy.cut();
    let reply = ingest(&app, &key, batch.clone()).await;
    assert_eq!(reply.status, 503, "{}", reply.text());
    assert_eq!(get(&app, "/health").await.status, 200);
    proxy.restore();
    assert_eq!(
        ingest(&app, &key, batch.clone()).await.json(),
        json!({"accepted": 2, "duplicates": 0})
    );
    assert_eq!(
        ingest(&app, &key, batch).await.json(),
        json!({"accepted": 0, "duplicates": 2})
    );
    assert_eq!(stored(&id).await.len(), 3);
}

#[tokio::test]
async fn acknowledged_events_survive_an_ingest_crash() {
    let (id, key) = project(30).await;
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_piko-ingest"))
        .env("PIKO_CLICKHOUSE_URL", &clickhouse().url)
        .env("PIKO_CLICKHOUSE_USER", "piko_ingest")
        .env("PIKO_CLICKHOUSE_PASSWORD", INGEST_PASSWORD)
        .env("PIKO_BIND", format!("127.0.0.1:{port}"))
        .env_remove("TAKO_DATA_DIR")
        .env_remove("TAKO_BUILD")
        .env_remove("TAKO_BOOTSTRAP_DATA")
        .spawn()
        .unwrap();
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = Kill(child);
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..200 {
        if client.get(format!("{base}/health")).send().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ready, "the ingest app started");
    let events: Vec<_> = (0..20)
        .map(|i| event(&format!("crash-{i}"), json!(i)))
        .collect();
    let response = client
        .post(format!("{base}/api/ingest"))
        .bearer_auth(&key)
        .json(&json!({ "events": events }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert_eq!(stored(&id).await.len(), 20);
    let _ = ADMIN_PASSWORD;
}

#[tokio::test]
async fn a_burst_of_small_requests_coalesces_into_few_parts() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(50));
    let mut jobs = tokio::task::JoinSet::new();
    for i in 0..2000 {
        let (app, key, semaphore) = (app.clone(), key.clone(), semaphore.clone());
        jobs.spawn(async move {
            let _permit = semaphore.acquire().await.unwrap();
            ingest(&app, &key, event(&format!("burst-{i}"), json!(i)))
                .await
                .status
        });
    }
    while let Some(status) = jobs.join_next().await {
        assert_eq!(status.unwrap(), 200);
    }
    let parts = admin_query(&format!(
        "SELECT uniqExact(_part) AS parts, count() AS rows FROM piko.events WHERE product_id = '{id}'"
    ))
    .await;
    assert_eq!(parts[0]["rows"], 2000);
    let parts = parts[0]["parts"].as_u64().unwrap();
    assert!(parts <= 50, "{parts} parts");
}

#[tokio::test]
async fn dotted_property_keys_round_trip() {
    let (app, _) = app().await;
    let (id, key) = project(30).await;
    let mut dotted = event("dotted", json!(1));
    dotted["properties"] = json!({"utm.source": "newsletter", "plan": "pro"});
    assert_eq!(ingest(&app, &key, dotted).await.status, 200);
    let rows = stored(&id).await;
    assert_eq!(
        rows[0]["properties"],
        json!({"utm.source": "newsletter", "plan": "pro"})
    );
}
