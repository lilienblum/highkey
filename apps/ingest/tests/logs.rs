mod common;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use common::{Kind, admin_query, clickhouse, config, post, seed_key};
use piko_ingest::{router, start};
use prost::Message;
use serde_json::{Value, json};
use tower::ServiceExt;

fn log(id: &str) -> Value {
    json!({"log_id":id,"service":"api","level":"info","message":"Request completed","attributes":{"status":200,"success":true,"code":"200","nested":{"array":[1,"two",false]}}})
}

async fn app() -> Router {
    router(start(config(&clickhouse().url)).await.unwrap())
}

/// A project with a log key, returning (product, key).
async fn project(retention: u16) -> (String, String) {
    let product = uuid::Uuid::new_v4().to_string();
    let key = seed_key(Kind::Logs, &product, &product, &[], retention, false).await;
    (product, key)
}

async fn stored(product: &str) -> Vec<Value> {
    admin_query(&format!(
        "SELECT log_id, level, message, service, environment, trace_id, span_id, request_id, attributes, toUnixTimestamp64Milli(timestamp) AS ms, toUnixTimestamp(expires_at) AS expires_s FROM piko.logs FINAL WHERE product_id = '{product}' ORDER BY log_id"
    ))
    .await
}

async fn ingest(app: &Router, key: &str, body: Value) -> (u16, Value) {
    let reply = post(app, "/api/logs/ingest", Some(key), None, &body).await;
    (reply.status, reply.json())
}

#[tokio::test]
async fn logs_and_events_dedupe_independently() {
    let app = app().await;
    let (a, ka) = project(365).await;
    let (b, kb) = project(365).await;
    for key in [&ka, &kb] {
        let (status, ack) = ingest(
            &app,
            key,
            json!({"logs":[log("same"),{"log_id":"same","service":"other","message":"Second payload"}]}),
        )
        .await;
        assert_eq!(status, 200, "{ack}");
        assert_eq!(ack, json!({"accepted":1,"duplicates":1}));
    }
    assert_eq!(
        ingest(&app, &ka, log("same")).await.1,
        json!({"accepted":0,"duplicates":1})
    );
    let rows = stored(&a).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["message"], "Request completed");
    assert_eq!(rows[0]["attributes"]["status"], 200);
    assert_eq!(
        rows[0]["attributes"]["nested"]["array"],
        json!([1, "two", false])
    );
    assert_eq!(stored(&b).await.len(), 1);
    // An event with the same id is a different signal.
    let events = seed_key(Kind::Events, &a, &a, &[], 30, false).await;
    let reply = post(
        &app,
        "/api/ingest",
        Some(&events),
        None,
        &json!({"event_id":"same","name":"x","source":"cli"}),
    )
    .await;
    assert_eq!(reply.json()["accepted"], 1);
}

#[tokio::test]
async fn log_keys_are_scoped_revocable_and_separate_from_event_keys() {
    let app = app().await;
    let (a, key) = project(7).await;
    let (b, _) = project(7).await;
    assert_eq!(ingest(&app, &key, log("scoped")).await.0, 200);
    assert_eq!(stored(&a).await.len(), 1);
    assert!(stored(&b).await.is_empty());
    let events = seed_key(Kind::Events, &a, &a, &[], 30, false).await;
    assert_eq!(ingest(&app, &events, log("wrong-key")).await.0, 401);
}

#[tokio::test]
async fn validation_is_atomic_and_search_preserves_scalar_types() {
    let app = app().await;
    let (a, key) = project(365).await;
    for invalid in [
        json!({"log_id":"bad","service":"api","message":"oops","level":"unknown"}),
        json!({"log_id":"bad","service":"api","message":"x".repeat(16385)}),
        json!({"log_id":"bad","service":"api","message":"oops","trace_id":"00000000000000000000000000000000"}),
    ] {
        assert_eq!(
            ingest(&app, &key, json!({"logs":[log("valid"),invalid]}))
                .await
                .0,
            400
        );
    }
    assert!(stored(&a).await.is_empty());
    let mut second = log("second");
    second["attributes"]["status"] = json!("200");
    second["message"] = json!("Literal 100%_done ' OR 1=1 --");
    assert_eq!(
        ingest(&app, &key, json!({"logs":[log("first"),second]}))
            .await
            .0,
        200
    );
    let rows = stored(&a).await;
    assert_eq!(rows[0]["attributes"]["status"], 200);
    assert_eq!(rows[1]["attributes"]["status"], "200");
    assert_eq!(rows[1]["message"], "Literal 100%_done ' OR 1=1 --");
}

#[tokio::test]
async fn otlp_json_protobuf_gzip_and_limits_follow_the_same_storage_contract() {
    use piko_ingest::logs::otlp::{
        AnyValue, ExportRequest, Record, ResourceLogs, ScopeLogs, ValueKind,
    };
    let app = app().await;
    let (a, key) = project(365).await;
    let payload = json!({"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"worker"}},{"key":"deployment.environment.name","value":{"stringValue":"production"}}]},"scopeLogs":[{"logRecords":[{"severityNumber":17,"body":{"stringValue":"Job failed"},"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","attributes":[{"key":"attempt","value":{"intValue":"2"}},{"key":"retryable","value":{"boolValue":true}}]}]}]}]});
    let reply = post(&app, "/api/logs/v1/logs", Some(&key), None, &payload).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.json(), json!({}));
    let rows = stored(&a).await;
    assert_eq!(rows[0]["service"], "worker");
    assert_eq!(rows[0]["level"], "error");
    assert_eq!(rows[0]["environment"], "production");
    assert_eq!(rows[0]["trace_id"], "0123456789abcdef0123456789abcdef");
    assert_eq!(rows[0]["span_id"], "0123456789abcdef");
    assert_eq!(rows[0]["attributes"]["attempt"], 2);
    assert_eq!(rows[0]["attributes"]["retryable"], true);
    let proto = ExportRequest {
        resource_logs: vec![ResourceLogs {
            resource: None,
            scope_logs: vec![ScopeLogs {
                log_records: vec![Record {
                    body: Some(AnyValue {
                        value: Some(ValueKind::StringValue("Proto record".into())),
                    }),
                    severity_number: 9,
                    ..Default::default()
                }],
            }],
        }],
    }
    .encode_to_vec();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &proto).unwrap();
    let compressed = encoder.finish().unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/logs/v1/logs")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/x-protobuf")
                .header("content-encoding", "gzip")
                .body(Body::from(compressed))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/x-protobuf");
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(stored(&a).await.len(), 2);
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/logs/ingest")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(" ".repeat(262145)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
}

#[test]
fn otlp_records_without_uid_get_time_ordered_ids() {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    let record =
        json!({"timeUnixNano":"1767225600000000000","body":{"stringValue":"Same instant"}});
    let payload = json!({"resourceLogs":[{"scopeLogs":[{"logRecords":[record, record]}]}]});
    let logs = piko_ingest::logs::otlp::decode(&headers, payload.to_string().as_bytes()).unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].timestamp, logs[1].timestamp);
    for log in &logs {
        assert_eq!(
            uuid::Uuid::parse_str(&log.log_id)
                .unwrap()
                .get_version_num(),
            7
        );
    }
    // UUIDv7 ids sort by creation, so the batch order survives an id sort.
    assert!(logs[0].log_id < logs[1].log_id);
}

#[test]
fn json_logs_without_id_get_time_ordered_ids() {
    let log = json!({"timestamp":"2026-01-01T00:00:00Z","service":"api","message":"Same instant"});
    let logs =
        serde_json::from_value::<piko_ingest::logs::model::Payload>(json!({"logs":[log, log]}))
            .unwrap()
            .records();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].timestamp, logs[1].timestamp);
    for log in &logs {
        assert_eq!(
            uuid::Uuid::parse_str(&log.log_id)
                .unwrap()
                .get_version_num(),
            7
        );
    }
    assert!(logs[0].log_id < logs[1].log_id);
}

#[tokio::test]
async fn log_retention_comes_from_the_log_key() {
    let app = app().await;
    let (_, short) = project(1).await;
    let (id, week) = project(7).await;
    let mut old = log("old");
    let time = chrono::Utc::now() - chrono::Duration::days(2);
    old["timestamp"] = json!(time.to_rfc3339());
    assert_eq!(ingest(&app, &short, old.clone()).await.0, 400);
    assert_eq!(ingest(&app, &week, old).await.0, 200);
    let rows = stored(&id).await;
    assert_eq!(rows[0]["ms"].as_i64().unwrap(), time.timestamp_millis());
    assert_eq!(
        rows[0]["expires_s"].as_i64().unwrap(),
        (time + chrono::Duration::days(7)).timestamp()
    );
}
