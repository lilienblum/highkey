use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use piko::{AppState, Config, router};
use prost::Message;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Test {
    directory: tempfile::TempDir,
    state: AppState,
}
impl Test {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::open(&Config {
            data_dir: directory.path().into(),
            query_concurrency: 2,
            queue_capacity: 16,
        })
        .unwrap();
        Self { directory, state }
    }
    fn app(&self) -> Router {
        router(self.state.clone())
    }
    async fn call(
        &self,
        path: &str,
        method: &str,
        body: Value,
        key: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header("x-piko-admin", "1");
        if let Some(key) = key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        let response = self
            .app()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
    async fn project(&self, name: &str) -> Value {
        let (status, body) = self
            .call(
                "/api/products",
                "POST",
                json!({"name":name,"retention_days":365}),
                None,
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }
    async fn key(&self, project: &Value) -> String {
        let (status, body) = self
            .call(
                &format!(
                    "/api/products/{}/logs/keys",
                    project["id"].as_str().unwrap()
                ),
                "POST",
                json!({"label":"Test"}),
                None,
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body["key"].as_str().unwrap().into()
    }
    async fn query(&self, project: &Value, extra: Value) -> Value {
        let now = chrono::Utc::now();
        let mut body = json!({"from":(now-chrono::Duration::days(7)).to_rfc3339(),"to":(now+chrono::Duration::minutes(1)).to_rfc3339()});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, result) = self
            .call(
                &format!(
                    "/api/products/{}/logs/query",
                    project["id"].as_str().unwrap()
                ),
                "POST",
                body,
                None,
            )
            .await;
        assert_eq!(status, 200, "{result}");
        result
    }
    async fn close(self) {
        self.state.log_writer.stop().await;
        self.state.writer.stop().await;
    }
    async fn reopen(self) -> Self {
        self.state.log_writer.stop().await;
        self.state.writer.stop().await;
        let directory = self.directory;
        drop(self.state);
        let state = AppState::open(&Config {
            data_dir: directory.path().into(),
            query_concurrency: 2,
            queue_capacity: 16,
        })
        .unwrap();
        Self { directory, state }
    }
}
fn log(id: &str) -> Value {
    json!({"log_id":id,"service":"api","level":"info","message":"Request completed","attributes":{"status":200,"success":true,"code":"200","nested":{"array":[1,"two",false]}}})
}

#[tokio::test]
async fn project_files_committed_duplicates_and_analytics_are_independent() {
    let test = Test::new();
    let a = test.project("A").await;
    let b = test.project("B").await;
    let ka = test.key(&a).await;
    let kb = test.key(&b).await;
    for key in [&ka, &kb] {
        let (status,ack)=test.call("/api/logs/ingest","POST",json!({"logs":[log("same"),{ "log_id":"same","service":"other","message":"Second payload"}]}),Some(key)).await;
        assert_eq!(status, 200, "{ack}");
        assert_eq!(ack, json!({"accepted":1,"duplicates":1}));
    }
    let (_, ack) = test
        .call("/api/logs/ingest", "POST", log("same"), Some(&ka))
        .await;
    assert_eq!(ack, json!({"accepted":0,"duplicates":1}));
    let test = test.reopen().await;
    let result = test.query(&a, json!({})).await;
    assert_eq!(result["total"], 1);
    assert_eq!(result["logs"][0]["message"], "Request completed");
    assert_eq!(
        result["logs"][0]["attributes"]["nested"]["array"],
        json!([1, "two", false])
    );
    let id = a["id"].as_str().unwrap();
    let second = b["id"].as_str().unwrap();
    assert!(
        test.directory
            .path()
            .join(format!("logs/{id}.duckdb"))
            .exists()
    );
    assert!(
        test.directory
            .path()
            .join(format!("logs/{second}.duckdb"))
            .exists()
    );
    assert_ne!(
        test.state.store.analytics.path(id).unwrap(),
        test.state.store.logs.path(id).unwrap()
    );
    let analytics = test.state.store.analytics.connection(id).unwrap();
    assert_eq!(
        analytics
            .connection
            .query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(analytics);
    test.close().await;
}
#[tokio::test]
async fn log_keys_are_scoped_revocable_and_separate_from_event_keys() {
    let test = Test::new();
    let a = test.project("A").await;
    let b = test.project("B").await;
    let id = a["id"].as_str().unwrap();
    let other = b["id"].as_str().unwrap();
    let log_key = test.key(&a).await;
    let (_, event_key) = test
        .call(
            &format!("/api/products/{id}/keys"),
            "POST",
            json!({"label":"Public"}),
            None,
        )
        .await;
    assert_eq!(
        test.call(
            "/api/logs/ingest",
            "POST",
            log("x"),
            Some(event_key["key"].as_str().unwrap())
        )
        .await
        .0,
        401
    );
    assert_eq!(
        test.call(
            "/api/ingest",
            "POST",
            json!({"event_id":"x","source":"cli","name":"x"}),
            Some(&log_key)
        )
        .await
        .0,
        401
    );
    assert_eq!(
        test.call(
            &format!("/api/products/{id}/logs/keys"),
            "POST",
            json!({"label":"Foreign","source_id":other}),
            None
        )
        .await
        .0,
        404
    );
    let (_, keys) = test
        .call(
            &format!("/api/products/{id}/logs/keys"),
            "GET",
            Value::Null,
            None,
        )
        .await;
    assert!(keys[0].get("key").is_none());
    let key_id = keys[0]["id"].as_str().unwrap();
    assert_eq!(
        test.call(
            &format!("/api/products/{other}/logs/keys/{key_id}"),
            "DELETE",
            Value::Null,
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        test.call(
            &format!("/api/products/{id}/logs/keys/{key_id}"),
            "DELETE",
            Value::Null,
            None
        )
        .await
        .0,
        204
    );
    assert_eq!(
        test.call("/api/logs/ingest", "POST", log("x"), Some(&log_key))
            .await
            .0,
        401
    );
    let response = test
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/products/{id}/logs/keys"))
                .header("content-type", "application/json")
                .body(Body::from("{\"label\":\"No marker\"}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    test.close().await;
}
#[tokio::test]
async fn validation_is_atomic_and_search_preserves_scalar_types() {
    let test = Test::new();
    let a = test.project("A").await;
    let key = test.key(&a).await;
    for invalid in [
        json!({"log_id":"bad","service":"api","message":"oops","level":"unknown"}),
        json!({"log_id":"bad","service":"api","message":"x".repeat(16385)}),
        json!({"log_id":"bad","service":"api","message":"oops","trace_id":"00000000000000000000000000000000"}),
    ] {
        assert_eq!(
            test.call(
                "/api/logs/ingest",
                "POST",
                json!({"logs":[log("valid"),invalid]}),
                Some(&key)
            )
            .await
            .0,
            400
        );
    }
    assert_eq!(test.query(&a, json!({})).await["total"], 0);
    let mut second = log("second");
    second["attributes"]["status"] = json!("200");
    second["message"] = json!("Literal 100%_done ' OR 1=1 --");
    assert_eq!(
        test.call(
            "/api/logs/ingest",
            "POST",
            json!({"logs":[log("first"),second]}),
            Some(&key)
        )
        .await
        .0,
        200
    );
    for value in [json!(200), json!("200")] {
        assert_eq!(
            test.query(
                &a,
                json!({"filters":[{"attribute":"status","value":value}]})
            )
            .await["total"],
            1
        );
    }
    assert_eq!(
        test.query(
            &a,
            json!({"filters":[{"attribute":"success","value":"true"}]})
        )
        .await["total"],
        0
    );
    assert_eq!(
        test.query(&a, json!({"search":"100%_done ' OR 1=1 --"}))
            .await["total"],
        1
    );
    test.close().await;
}
#[tokio::test]
async fn cursor_pagination_is_stable_for_equal_timestamps() {
    let test = Test::new();
    let a = test.project("A").await;
    let key = test.key(&a).await;
    let timestamp = chrono::Utc::now().to_rfc3339();
    for start in [0, 100] {
        let records: Vec<_> = (start..(start + 100).min(150))
            .map(|i| {
                let mut record = log(&format!("id-{i:03}"));
                record["timestamp"] = json!(timestamp);
                record
            })
            .collect();
        assert_eq!(
            test.call(
                "/api/logs/ingest",
                "POST",
                json!({"logs":records}),
                Some(&key)
            )
            .await
            .0,
            200
        );
    }
    let first = test.query(&a, json!({})).await;
    assert_eq!(first["logs"].as_array().unwrap().len(), 100);
    assert_eq!(first["total"], 150);
    let next = test.query(&a, json!({"cursor":first["next_cursor"]})).await;
    assert_eq!(next["logs"].as_array().unwrap().len(), 50);
    assert!(next["next_cursor"].is_null());
    let ids: std::collections::HashSet<_> = first["logs"]
        .as_array()
        .unwrap()
        .iter()
        .chain(next["logs"].as_array().unwrap())
        .map(|r| r["log_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 150);
    assert_eq!(
        first["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["count"].as_i64().unwrap())
            .sum::<i64>(),
        150
    );
    test.close().await;
}
#[tokio::test]
async fn summaries_cover_all_buckets_and_rank_services_before_pagination() {
    let test = Test::new();
    let project = test.project("Summaries").await;
    let key = test.key(&project).await;
    let from =
        chrono::DateTime::from_timestamp_millis(chrono::Utc::now().timestamp_millis() - 3_600_000)
            .unwrap();
    let to = from + chrono::Duration::hours(1);
    for start in [0, 100, 200] {
        let records: Vec<_> = (start..(start + 100).min(210))
            .map(|i| {
                json!({
                    "log_id":format!("summary-{i:03}"),
                    "timestamp":(from+chrono::Duration::minutes(i % 60)).to_rfc3339(),
                    "service":format!("service-{:02}", i % 70),
                    "message":"Literal Needle_% completed",
                    "level":if i % 3 == 0 { "fatal" } else { "info" },
                    "attributes":{"group":i % 2}
                })
            })
            .collect();
        let (status, ack) = test
            .call(
                "/api/logs/ingest",
                "POST",
                json!({"logs":records}),
                Some(&key),
            )
            .await;
        assert_eq!(status, 200, "{ack}");
    }
    let body = json!({"from":from.to_rfc3339(),"to":to.to_rfc3339(),"search":"nEeDlE_%"});
    let path = format!(
        "/api/products/{}/logs/query",
        project["id"].as_str().unwrap()
    );
    let (status, first) = test.call(&path, "POST", body.clone(), None).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["total"], 210);
    let buckets = first["series"].as_array().unwrap();
    assert_eq!(buckets.len(), 60);
    for (index, bucket) in buckets.iter().enumerate() {
        assert_eq!(
            bucket["time"],
            from.timestamp_millis() + index as i64 * 60_000
        );
        assert_eq!(bucket["count"], if index < 30 { 4 } else { 3 });
        assert_eq!(
            bucket["errors"],
            if index % 3 == 0 {
                if index < 30 { 4 } else { 3 }
            } else {
                0
            }
        );
    }
    assert_eq!(first["services"].as_array().unwrap().len(), 50);
    for (index, service) in first["services"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            service,
            &json!({"name":format!("service-{index:02}"),"count":3})
        );
    }
    let mut next_body = body.clone();
    next_body["cursor"] = first["next_cursor"].clone();
    let (status, next) = test.call(&path, "POST", next_body, None).await;
    assert_eq!(status, 200, "{next}");
    for field in ["total", "series", "services"] {
        assert_eq!(next[field], first[field], "cursor changed {field}");
    }
    let mut filtered_body = body.clone();
    filtered_body["filters"] = json!([{"attribute":"group","value":1}]);
    let (status, filtered) = test.call(&path, "POST", filtered_body, None).await;
    assert_eq!(status, 200, "{filtered}");
    assert_eq!(filtered["total"], 105);
    let mut empty_body = body;
    empty_body["search"] = json!("absent");
    let (status, empty) = test.call(&path, "POST", empty_body, None).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["services"], json!([]));
    assert!(
        empty["series"]
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["count"] == 0 && b["errors"] == 0)
    );
    test.close().await;
}
#[tokio::test]
async fn log_retention_is_independent_and_survives_reopening_catalog() {
    let test = Test::new();
    let a = test.project("A").await;
    let id = a["id"].as_str().unwrap();
    let key = test.key(&a).await;
    let mut old = log("old");
    old["timestamp"] = json!((chrono::Utc::now() - chrono::Duration::days(2)).to_rfc3339());
    assert_eq!(
        test.call("/api/logs/ingest", "POST", old, Some(&key))
            .await
            .0,
        200
    );
    let path = format!("/api/products/{id}/logs/settings");
    assert_eq!(
        test.call(&path, "GET", Value::Null, None).await.1["retention_days"],
        7
    );
    assert_eq!(
        test.call(&path, "PATCH", json!({"retention_days":1}), None)
            .await
            .0,
        200
    );
    assert_eq!(
        test.call(&path, "PATCH", json!({"retention_days":0}), None)
            .await
            .0,
        400
    );
    let (_, result) = test.call("/api/cleanup", "POST", json!({}), None).await;
    assert_eq!(result["logs_removed"], 1);
    assert_eq!(test.query(&a, json!({})).await["total"], 0);
    let db = test.state.store.sqlite().unwrap();
    assert_eq!(piko::store::product(&db, id).unwrap().retention_days, 365);
    assert_eq!(piko::logs::keys::retention(&db, id).unwrap(), 1);
    drop(db);
    let test = test.reopen().await;
    assert_eq!(
        test.call(&path, "GET", Value::Null, None).await.1["retention_days"],
        1
    );
    assert_eq!(
        test.call("/api/logs/ingest", "POST", log("after-restart"), Some(&key))
            .await
            .0,
        200
    );
    assert_eq!(test.query(&a, json!({})).await["total"], 1);
    test.close().await;
}
#[tokio::test]
async fn saturated_log_queries_do_not_block_ingestion_or_analytics() {
    let test = Test::new();
    let project = test.project("Capacity").await;
    let key = test.key(&project).await;
    let permits = test
        .state
        .store
        .log_query_slots
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let now = chrono::Utc::now();
    let (status, _) = test
        .call(
            &format!(
                "/api/products/{}/logs/query",
                project["id"].as_str().unwrap()
            ),
            "POST",
            json!({"from": (now-chrono::Duration::hours(1)).to_rfc3339(), "to": now.to_rfc3339()}),
            None,
        )
        .await;
    assert_eq!(status, 503);
    assert_eq!(
        test.call("/api/logs/ingest", "POST", log("under-load"), Some(&key))
            .await
            .0,
        200
    );
    test.state
        .store
        .query(project["id"].as_str().unwrap().into(), |_| Ok(()))
        .await
        .unwrap();
    drop(permits);
    assert_eq!(test.query(&project, json!({})).await["total"], 1);
    test.close().await;
}
#[tokio::test]
async fn otlp_json_protobuf_gzip_and_limits_follow_the_same_storage_contract() {
    use piko::logs::otlp::{AnyValue, ExportRequest, Record, ResourceLogs, ScopeLogs, ValueKind};
    let test = Test::new();
    let a = test.project("A").await;
    let key = test.key(&a).await;
    let payload = json!({"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"worker"}},{"key":"deployment.environment.name","value":{"stringValue":"production"}}]},"scopeLogs":[{"logRecords":[{"severityNumber":17,"body":{"stringValue":"Job failed"},"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","attributes":[{"key":"attempt","value":{"intValue":"2"}},{"key":"retryable","value":{"boolValue":true}}]}]}]}]});
    let (status, response) = test
        .call("/api/logs/v1/logs", "POST", payload, Some(&key))
        .await;
    assert_eq!(status, 200, "{response}");
    assert_eq!(response, json!({}));
    let query = test.query(&a, json!({})).await;
    assert_eq!(query["logs"][0]["service"], "worker");
    assert_eq!(query["logs"][0]["level"], "error");
    assert_eq!(query["logs"][0]["attributes"]["attempt"], 2);
    assert_eq!(query["logs"][0]["attributes"]["retryable"], true);
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
    let response = test
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/logs/v1/logs")
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
    assert_eq!(test.query(&a, json!({})).await["total"], 2);
    let response = test
        .app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/logs/ingest")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(" ".repeat(262145)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    test.close().await;
}
#[test]
fn otlp_records_without_uid_get_time_ordered_ids() {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    let record =
        json!({"timeUnixNano":"1767225600000000000","body":{"stringValue":"Same instant"}});
    let payload = json!({"resourceLogs":[{"scopeLogs":[{"logRecords":[record, record]}]}]});
    let logs = piko::logs::otlp::decode(&headers, payload.to_string().as_bytes()).unwrap();
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
    let logs = serde_json::from_value::<piko::logs::model::Payload>(json!({"logs":[log, log]}))
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
async fn facets_list_every_known_service_environment_and_typed_attribute() {
    let test = Test::new();
    let project = test.project("Facets").await;
    let key = test.key(&project).await;
    let logs = json!({"logs":[
        {"log_id":"f-1","service":"api","environment":"production","message":"ok","attributes":{"status":200,"region":"tokyo","cached":false,"context":{"queue":"orders"}}},
        {"log_id":"f-2","service":"worker","environment":"staging","message":"ok","attributes":{"status":500,"region":"osaka"}},
        {"log_id":"f-3","service":"api","message":"no environment","attributes":{"status":"200"}}
    ]});
    let (status, ack) = test
        .call("/api/logs/ingest", "POST", logs, Some(&key))
        .await;
    assert_eq!(status, 200, "{ack}");
    // Facets ignore the other filters, so a narrowed view still offers every alternative.
    let result = test
        .query(
            &project,
            json!({"service":"api","environment":"production"}),
        )
        .await;
    assert_eq!(result["total"], 1);
    let names = |list: &Value| -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(names(&result["facets"]["services"]), ["api", "worker"]);
    assert_eq!(
        names(&result["facets"]["environments"]),
        ["production", "staging"]
    );
    let attributes = result["facets"]["attributes"].as_array().unwrap();
    let kind = |key: &str| {
        attributes
            .iter()
            .find(|item| item["key"] == key)
            .map(|item| item["type"].as_str().unwrap().to_string())
    };
    // Status is mostly numeric; nested objects are not offered because they cannot be matched.
    assert_eq!(kind("status").as_deref(), Some("number"));
    assert_eq!(kind("region").as_deref(), Some("string"));
    assert_eq!(kind("cached").as_deref(), Some("boolean"));
    assert_eq!(kind("context"), None);
}

#[tokio::test]
async fn minimum_level_includes_more_severe_levels_and_excludes_an_exact_level() {
    let test = Test::new();
    let project = test.project("Levels").await;
    let key = test.key(&project).await;
    let records: Vec<Value> = ["trace", "debug", "info", "warn", "error", "fatal"]
        .iter()
        .map(|level| json!({"log_id":format!("l-{level}"),"service":"api","level":level,"message":"m"}))
        .collect();
    let (status, ack) = test
        .call(
            "/api/logs/ingest",
            "POST",
            json!({"logs":records}),
            Some(&key),
        )
        .await;
    assert_eq!(status, 200, "{ack}");
    assert_eq!(test.query(&project, json!({})).await["total"], 6);
    assert_eq!(
        test.query(&project, json!({"min_level":"warn"})).await["total"],
        3
    );
    assert_eq!(
        test.query(&project, json!({"min_level":"fatal"})).await["total"],
        1
    );
    assert_eq!(
        test.query(&project, json!({"level":"warn"})).await["total"],
        1
    );
    let now = chrono::Utc::now();
    let path = format!(
        "/api/products/{}/logs/query",
        project["id"].as_str().unwrap()
    );
    for extra in [
        json!({"min_level":"loud"}),
        json!({"level":"warn","min_level":"warn"}),
    ] {
        let mut body =
            json!({"from":(now-chrono::Duration::days(1)).to_rfc3339(),"to":now.to_rfc3339()});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, result) = test.call(&path, "POST", body, None).await;
        assert_eq!(status, 400, "{result}");
    }
    test.close().await;
}
