use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use chrono::{DateTime, Datelike, Duration, DurationRound, Utc};
use piko::{AppState, Config, router};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Test {
    _directory: tempfile::TempDir,
    state: AppState,
}
impl Test {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let mut state = AppState::open(&Config {
            data_dir: directory.path().into(),
            query_concurrency: 4,
            queue_capacity: 16,
        })
        .unwrap();
        // Most tests write far more than 30 dashboards a minute; one test pins the real limit.
        state.write_limit = std::sync::Arc::new(piko::dashboards::limit::WriteLimit::new(
            100_000,
            std::time::Duration::from_secs(60),
        ));
        Self {
            _directory: directory,
            state,
        }
    }
    fn app(&self) -> Router {
        router(self.state.clone())
    }
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let (status, _, body) = self.send_full(method, path, body, headers).await;
        (status, body)
    }
    async fn send_full(
        &self,
        method: &str,
        path: &str,
        body: Value,
        headers: &[(&str, &str)],
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let body = if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        };
        let response = self
            .app()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            headers,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        )
    }
    /// A management request, carrying the `X-Piko-Admin` marker.
    async fn manage(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(method, path, body, &[("x-piko-admin", "1")])
            .await
    }
    /// A read request: no marker and no credentials.
    async fn read(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(method, path, body, &[]).await
    }
    async fn project(&self, name: &str) -> Value {
        let (status, body) = self
            .manage(
                "POST",
                "/api/products",
                json!({"name":name,"retention_days":365}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }
    async fn source(&self, project: &Value, name: &str) -> String {
        let (status, body) = self
            .manage(
                "POST",
                &format!("/api/products/{}/sources", id(project)),
                json!({"name":name}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body["id"].as_str().unwrap().into()
    }
    /// Ingests `n` events named `name` through the public endpoint, into `source` or the
    /// project's initial source.
    async fn seed_events(&self, project: &Value, source: Option<&str>, name: &str, n: usize) {
        let events = (0..n).map(|_| json!({"name": name})).collect();
        self.ingest_events(project, source, events).await;
    }
    /// Ingests `n` events stamped `at`, so a test never straddles a bucket boundary.
    async fn seed_events_at(&self, project: &Value, name: &str, n: usize, at: DateTime<Utc>) {
        let events = (0..n)
            .map(|_| json!({"name": name, "timestamp": at.to_rfc3339()}))
            .collect();
        self.ingest_events(project, None, events).await;
    }
    /// Ingests events, each given an id and a source, through the public endpoint.
    async fn ingest_events(&self, project: &Value, source: Option<&str>, mut events: Vec<Value>) {
        let n = events.len();
        for event in &mut events {
            event["event_id"] = json!(uuid::Uuid::now_v7().to_string());
            event["source"] = json!("web");
        }
        let mut key = json!({"label":"Seed"});
        if let Some(source) = source {
            key["source_id"] = json!(source);
        }
        let (status, key) = self
            .manage("POST", &format!("/api/products/{}/keys", id(project)), key)
            .await;
        assert_eq!(status, 200, "{key}");
        let bearer = format!("Bearer {}", key["key"].as_str().unwrap());
        let (status, ack) = self
            .send(
                "POST",
                "/api/ingest",
                json!({ "events": events }),
                &[("authorization", &bearer)],
            )
            .await;
        assert_eq!(status, 200, "{ack}");
        assert_eq!(ack["accepted"], n);
    }
    /// Ingests `n` logs from `service` at `level` through the public endpoint.
    async fn seed_logs(&self, project: &Value, service: &str, level: &str, n: usize) {
        self.seed_logs_stamped(project, service, level, n, None)
            .await;
    }
    /// Ingests `n` logs stamped `at`, so a test never straddles a bucket boundary.
    async fn seed_logs_at(
        &self,
        project: &Value,
        service: &str,
        level: &str,
        n: usize,
        at: DateTime<Utc>,
    ) {
        self.seed_logs_stamped(project, service, level, n, Some(at))
            .await;
    }
    async fn seed_logs_stamped(
        &self,
        project: &Value,
        service: &str,
        level: &str,
        n: usize,
        at: Option<DateTime<Utc>>,
    ) {
        let (status, key) = self
            .manage(
                "POST",
                &format!("/api/products/{}/logs/keys", id(project)),
                json!({"label":"Seed"}),
            )
            .await;
        assert_eq!(status, 200, "{key}");
        let logs: Vec<Value> = (0..n)
            .map(|_| {
                let mut log = json!({"service":service,"level":level,"message":"Request finished"});
                if let Some(at) = at {
                    log["timestamp"] = json!(at.to_rfc3339());
                }
                log
            })
            .collect();
        let bearer = format!("Bearer {}", key["key"].as_str().unwrap());
        let (status, ack) = self
            .send(
                "POST",
                "/api/logs/ingest",
                json!({ "logs": logs }),
                &[("authorization", &bearer)],
            )
            .await;
        assert_eq!(status, 200, "{ack}");
        assert_eq!(ack["accepted"], n);
    }
    async fn run(&self, project: &str, body: Value) -> (StatusCode, Value) {
        self.read(
            "POST",
            &format!("/api/read/products/{project}/widgets/run"),
            body,
        )
        .await
    }
    async fn close(self) {
        self.state.log_writer.stop().await;
        self.state.writer.stop().await;
    }
}
fn id(project: &Value) -> &str {
    project["id"].as_str().unwrap()
}
fn window(days: i64) -> (DateTime<Utc>, DateTime<Utc>) {
    let to = Utc::now() + Duration::minutes(1);
    (to - Duration::days(days), to)
}
fn run_body(widget: Value, days: i64) -> Value {
    let (from, to) = window(days);
    json!({"widget": widget, "from": from, "to": to})
}
fn time(value: &Value) -> DateTime<Utc> {
    value.as_str().unwrap().parse().unwrap()
}
/// The error-rate widget from the design's example document.
fn error_rate() -> Value {
    json!({
        "id": "error-rate",
        "title": "Checkout error rate",
        "description": "Share of checkout requests that logged an error",
        "view": { "type": "line", "unit": "percent", "decimals": 1, "compare": "previous_period" },
        "size": { "w": 6, "h": 2 },
        "range": "24h",
        "timeout_ms": 5000,
        "queries": {
            "errors": { "signal": "logs", "min_level": "error", "service": "checkout" },
            "requests": { "signal": "events", "event": "checkout_request" }
        },
        "series": [{
            "expr": "errors / requests * 100",
            "label": "Error rate",
            "color": "red",
            "thresholds": [{ "at": 1, "color": "yellow" }, { "at": 5, "color": "red" }]
        }]
    })
}

#[tokio::test]
async fn widgets_run_over_events_and_logs_by_slug() {
    let test = Test::new();
    let project = test.project("Checkout Shop").await;
    assert_eq!(project["slug"], "checkout-shop");
    // Mid-hour two hours back: every row lands in one hourly bucket whatever the clock says.
    let at = (Utc::now() - Duration::hours(2))
        .duration_trunc(Duration::hours(1))
        .unwrap()
        + Duration::minutes(30);
    test.seed_events_at(&project, "checkout_request", 8, at)
        .await;
    test.seed_events_at(&project, "page_view", 3, at).await;
    test.seed_logs_at(&project, "checkout", "error", 1, at)
        .await;
    test.seed_logs_at(&project, "checkout", "fatal", 1, at)
        .await;
    test.seed_logs_at(&project, "checkout", "info", 5, at).await;
    test.seed_logs_at(&project, "search", "error", 4, at).await;

    // `read` sends no X-Piko-Admin header.
    let (status, body) = test.run("checkout-shop", run_body(error_rate(), 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["widget"], "error-rate");
    let series = &body["series"][0];
    assert_eq!(body["series"].as_array().unwrap().len(), 1);
    assert_eq!(series["label"], "Error rate");
    assert_eq!(series["color"], "red");
    assert_eq!(series["total"], 25.0);
    // Nothing happened in the previous 24 hours, so 0 / 0 has no value.
    assert!(series["previous_total"].is_null(), "{series}");
    let points = series["points"].as_array().unwrap();
    assert!(points.iter().any(|p| p["value"] == 25.0), "{series}");
    assert!(series["previous_points"].is_array(), "{series}");
    // The widget's 24h override replaces the 7-day workspace range.
    assert_eq!(body["range"]["clamped"], false);
    assert_eq!(body["range"]["bucket"], "hour");
    let (from, to) = (time(&body["range"]["from"]), time(&body["range"]["to"]));
    assert_eq!(to - from, Duration::hours(24));
    assert_eq!(body["range"]["requested_from"], body["range"]["from"]);
    assert_eq!(body["range"]["requested_to"], body["range"]["to"]);
    assert!(body["elapsed_ms"].is_u64(), "{body}");
    assert!(body["rows"].is_null());
    assert_eq!(body["warnings"], json!([]));

    // The id works as well as the slug, and gives the same series.
    let (status, by_id) = test.run(id(&project), run_body(error_rate(), 7)).await;
    assert_eq!(status, 200, "{by_id}");
    assert_eq!(by_id["series"][0]["total"], 25.0);
    assert_eq!(test.run("missing", run_body(error_rate(), 7)).await.0, 404);
    test.close().await;
}

#[tokio::test]
async fn ninety_day_run_with_logs_reports_clamp() {
    let test = Test::new();
    let project = test.project("Clamp").await;
    test.seed_logs(&project, "api", "error", 3).await;
    let widget = json!({
        "id": "errors", "title": "Errors", "view": {"type": "line"},
        "queries": {"errors": {"signal": "logs", "min_level": "error"}}
    });
    let (from, to) = window(90);
    let (status, body) = test
        .run(
            "clamp",
            json!({"widget": widget, "from": from, "to": to, "bucket": "auto"}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["range"]["clamped"], true);
    assert_eq!(time(&body["range"]["requested_from"]), from);
    assert_eq!(time(&body["range"]["requested_to"]), to);
    assert_eq!(time(&body["range"]["from"]), to - Duration::days(31));
    assert_eq!(time(&body["range"]["to"]), to);
    assert_eq!(body["range"]["bucket"], "day");
    assert_eq!(body["warnings"][0]["path"], "/range");
    assert!(
        body["warnings"][0]["message"]
            .as_str()
            .unwrap()
            .contains("31 days"),
        "{body}"
    );
    assert_eq!(body["series"][0]["total"], 3.0);

    // An events-only widget keeps the whole 90 days.
    let widget = json!({
        "id": "views", "title": "Views", "view": {"type": "stat"},
        "queries": {"views": {"signal": "events", "event": "page_view"}}
    });
    let (status, body) = test.run("clamp", run_body(widget, 90)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["range"]["clamped"], false);
    assert_eq!(body["series"][0]["total"], 0.0);
    test.close().await;
}

#[tokio::test]
async fn invalid_widget_returns_pointer_errors() {
    let test = Test::new();
    let project = test.project("Invalid").await;
    let mut widget = error_rate();
    widget["series"][0]["expr"] = json!("erors/requests");
    let (status, body) = test.run("invalid", run_body(widget, 7)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "invalid_document");
    assert_eq!(body["error"], "Invalid dashboard document");
    assert_eq!(body["errors"][0]["path"], "/series/0/expr");
    assert!(body["warnings"].is_array(), "{body}");

    // Shape errors carry their path too.
    let mut widget = error_rate();
    widget["view"]["colour"] = json!("red");
    let (status, body) = test.run(id(&project), run_body(widget, 7)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "invalid_document");
    assert_eq!(body["errors"][0]["path"], "/view/colour");

    // Request errors outside the widget are plain bad requests.
    let (from, to) = window(7);
    for request in [
        json!({"widget": error_rate(), "from": to, "to": from}),
        json!({"widget": error_rate(), "from": from, "to": to, "bucket": "minute"}),
    ] {
        let (status, body) = test.run("invalid", request).await;
        assert_eq!(status, 400, "{body}");
        assert!(body["error"].is_string(), "{body}");
    }
    let (status, body) = test
        .run("invalid", json!({"widget": error_rate(), "from": from}))
        .await;
    assert!(status.is_client_error(), "{status}");
    assert!(body["error"].is_string(), "{body}");
    test.close().await;
}

#[tokio::test]
async fn workspace_source_narrows_unpinned_queries_only() {
    let test = Test::new();
    let project = test.project("Sources").await;
    let other = test.project("Other").await;
    // The initial source's id is the project id.
    let s1 = id(&project).to_string();
    let s2 = test.source(&project, "iOS").await;
    test.seed_events(&project, None, "checkout_request", 3)
        .await;
    test.seed_events(&project, Some(&s2), "checkout_request", 5)
        .await;
    let widget = json!({
        "id": "requests", "title": "Requests", "view": {"type": "stat"},
        "queries": {
            "all": {"signal": "events", "event": "checkout_request"},
            "pinned": {"signal": "events", "event": "checkout_request", "source_id": s1}
        },
        "series": [{"expr": "all"}, {"expr": "pinned"}]
    });
    let totals = |body: &Value| {
        (
            body["series"][0]["total"].clone(),
            body["series"][1]["total"].clone(),
        )
    };
    let mut request = run_body(widget.clone(), 7);
    request["source_id"] = json!(s2);
    let (status, body) = test.run(id(&project), request.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(totals(&body), (json!(5.0), json!(3.0)));

    let (status, body) = test.run(id(&project), run_body(widget, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(totals(&body), (json!(8.0), json!(3.0)));

    // A workspace source must belong to the project.
    request["source_id"] = json!(id(&other));
    assert_eq!(test.run(id(&project), request).await.0, 404);
    test.close().await;
}

#[tokio::test]
async fn read_prefix_serves_schema_and_existing_queries() {
    let test = Test::new();
    let project = test.project("Read Prefix").await;
    test.seed_events(&project, None, "checkout_request", 4)
        .await;
    test.seed_logs(&project, "api", "warn", 2).await;

    let (status, schema) = test
        .read("GET", "/api/read/schemas/dashboard.v1.json", Value::Null)
        .await;
    assert_eq!(status, 200, "{schema}");
    assert_eq!(schema["$id"], "/api/read/schemas/dashboard.v1.json");

    let (status, products) = test.read("GET", "/api/read/products", Value::Null).await;
    assert_eq!(status, 200, "{products}");
    assert_eq!(products[0]["id"], project["id"]);
    assert_eq!(products[0]["slug"], "read-prefix");

    let (from, to) = window(7);
    let query = json!({"from": from, "to": to, "measure": "count"});
    let (status, managed) = test
        .manage(
            "POST",
            &format!("/api/products/{}/query", id(&project)),
            query.clone(),
        )
        .await;
    assert_eq!(status, 200, "{managed}");
    assert_eq!(managed["summary"]["total"], 4, "{managed}");
    for key in [id(&project), "read-prefix"] {
        let (status, read) = test
            .read(
                "POST",
                &format!("/api/read/products/{key}/query"),
                query.clone(),
            )
            .await;
        assert_eq!(status, 200, "{read}");
        assert_eq!(read, managed);
    }

    let logs = json!({"from": from, "to": to});
    let (status, managed) = test
        .manage(
            "POST",
            &format!("/api/products/{}/logs/query", id(&project)),
            logs.clone(),
        )
        .await;
    assert_eq!(status, 200, "{managed}");
    assert_eq!(managed["total"], 2, "{managed}");
    for key in [id(&project), "read-prefix"] {
        let (status, read) = test
            .read(
                "POST",
                &format!("/api/read/products/{key}/logs/query"),
                logs.clone(),
            )
            .await;
        assert_eq!(status, 200, "{read}");
        assert_eq!(read, managed);
    }

    // The management paths keep their marker; the read prefix rejects unknown projects.
    let (status, _) = test
        .read(
            "POST",
            &format!("/api/products/{}/query", id(&project)),
            query.clone(),
        )
        .await;
    assert_eq!(status, 403);
    let (status, body) = test
        .read("POST", "/api/read/products/missing/query", query)
        .await;
    assert_eq!(status, 404, "{body}");
    test.close().await;
}

#[tokio::test]
async fn rankings_grouped_series_and_lists_run() {
    let test = Test::new();
    let project = test.project("Shapes").await;
    let mut events = Vec::new();
    for (plan, n) in [(json!("pro"), 5), (json!("free"), 3), (json!(1), 2)] {
        events.extend((0..n).map(|_| json!({"name": "signup", "properties": {"plan": plan}})));
    }
    events.push(json!({"name": "signup"}));
    events.extend((0..2).map(|_| json!({"name": "upgrade", "properties": {"plan": "pro"}})));
    for page in 1..=8 {
        events.extend(
            (0..9 - page)
                .map(|_| json!({"name": "visit", "properties": {"page": format!("p{page}")}})),
        );
    }
    test.ingest_events(&project, None, events).await;
    test.seed_events(&project, None, "tick", 55).await;
    test.seed_logs(&project, "api", "info", 3).await;

    // Rankings take their rows from the first query; the others align to its labels.
    let ranking = json!({
        "id": "plans", "title": "Plans", "view": {"type": "ranking", "limit": 3},
        "queries": {
            "signups": {"signal": "events", "event": "signup", "group_by": "property:plan"},
            "upgrades": {"signal": "events", "event": "upgrade", "group_by": "property:plan"}
        },
        "series": [{"expr": "signups"}, {"expr": "upgrades / signups * 100"}]
    });
    let (status, body) = test.run("shapes", run_body(ranking, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"][0]["total"], 11.0);
    assert_eq!(
        body["series"][0]["groups"],
        json!([{"label":"pro","value":5.0},{"label":"free","value":3.0},{"label":1,"value":2.0}])
    );
    assert_eq!(
        body["series"][1]["groups"],
        json!([{"label":"pro","value":40.0},{"label":"free","value":0.0},{"label":1,"value":0.0}])
    );

    // A grouped time series draws the six largest groups.
    let grouped = json!({
        "id": "pages", "title": "Pages", "view": {"type": "line"},
        "queries": {"visits": {"signal": "events", "event": "visit", "group_by": "property:page"}}
    });
    let (status, body) = test.run("shapes", run_body(grouped, 7)).await;
    assert_eq!(status, 200, "{body}");
    let series = body["series"].as_array().unwrap();
    assert_eq!(
        series
            .iter()
            .map(|s| s["group"].clone())
            .collect::<Vec<_>>(),
        ["p1", "p2", "p3", "p4", "p5", "p6"]
            .map(|p| json!(p))
            .to_vec()
    );
    let points = series[0]["points"].as_array().unwrap();
    let sum: f64 = points.iter().filter_map(|p| p["value"].as_f64()).sum();
    assert_eq!(sum, 8.0);

    // List views return rows, newest first, at most 50.
    let list = json!({
        "id": "ticks", "title": "Ticks", "view": {"type": "events"},
        "queries": {"ticks": {"signal": "events", "event": "tick"}}
    });
    let (status, body) = test.run("shapes", run_body(list, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"], json!([]));
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 50);
    assert!(rows.iter().all(|r| r["name"] == "tick"));
    assert!(rows[0]["timestamp"].as_i64() >= rows[49]["timestamp"].as_i64());
    let list = json!({
        "id": "api", "title": "API logs", "view": {"type": "logs"},
        "queries": {"api": {"signal": "logs", "service": "api"}}
    });
    let (status, body) = test.run("shapes", run_body(list, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 3);
    assert_eq!(body["rows"][0]["service"], "api");

    // Text widgets read nothing.
    let text =
        json!({"id": "note", "title": "Note", "view": {"type": "text", "markdown": "Hello"}});
    let (status, body) = test.run("shapes", run_body(text, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["series"].clone(), body["rows"].clone()),
        (json!([]), Value::Null)
    );
    test.close().await;
}

#[tokio::test]
async fn a_full_dashboard_gate_times_out_widgets_but_not_interactive_queries() {
    let test = Test::new();
    let project = test.project("Busy").await;
    test.seed_events(&project, None, "checkout_request", 2)
        .await;
    let widget = json!({
        "id": "requests", "title": "Requests", "view": {"type": "stat"}, "timeout_ms": 1000,
        "queries": {"requests": {"signal": "events", "event": "checkout_request"}}
    });
    // Three dashboard runs already hold the gate.
    let gate = test.state.store.dashboard_event_gate.clone();
    let held = gate.acquire_many_owned(3).await.unwrap();
    let started = std::time::Instant::now();
    let (status, headers, body) = test
        .send_full(
            "POST",
            "/api/read/products/busy/widgets/run",
            run_body(widget.clone(), 7),
            &[],
        )
        .await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(
        body,
        json!({"error": "Timed out after 1 s", "code": "query_timeout"})
    );
    assert!(headers.get("retry-after").is_none());
    assert!(started.elapsed() >= std::time::Duration::from_secs(1));

    let (from, to) = window(7);
    let (status, result) = test
        .read(
            "POST",
            "/api/read/products/busy/query",
            json!({"from": from, "to": to}),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["summary"]["total"], 2);

    drop(held);
    let (status, body) = test.run("busy", run_body(widget, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"][0]["total"], 2.0);
    test.close().await;
}

#[tokio::test]
async fn catalog_lists_typed_keys_facets_retention_and_limits() {
    let test = Test::new();
    let project = test.project("Shop").await;
    test.ingest_events(
        &project,
        None,
        vec![
            json!({"name":"checkout","properties":{"plan":"pro","amount":12.5}}),
            json!({"name":"checkout","properties":{"plan":"free","amount":3.0}}),
            json!({"name":"signup","properties":{"plan":"pro"}}),
        ],
    )
    .await;
    test.seed_logs(&project, "checkout", "info", 3).await;
    test.seed_logs(&project, "search", "error", 1).await;

    let (status, body) = test
        .read("GET", "/api/read/products/shop/catalog", Value::Null)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["project"]["id"], id(&project));
    assert_eq!(body["project"]["slug"], "shop");
    assert_eq!(body["project"]["name"], "Shop");
    assert_eq!(body["events"]["names"], json!(["checkout", "signup"]));
    assert_eq!(
        body["events"]["properties"],
        json!([
            {"key":"plan","type":"string","count":3},
            {"key":"amount","type":"number","count":2},
        ])
    );
    assert_eq!(body["logs"]["services"][0]["name"], "checkout");
    assert_eq!(body["logs"]["services"][0]["count"], 3);
    assert_eq!(body["logs"]["services"][1]["name"], "search");
    assert_eq!(body["logs"]["levels"], json!(["info", "error"]));
    assert_eq!(body["sources"].as_array().unwrap().len(), 1);
    assert!(body["sources"][0]["id"].is_string());
    assert!(body["sources"][0]["name"].is_string());
    assert_eq!(
        body["retention"],
        json!({"events_days": 365, "logs_days": 7})
    );
    assert_eq!(body["limits"]["max_widgets"], 24);
    assert_eq!(body["limits"]["max_query_runs_per_widget"], 8);

    // The id works too, and an unknown project is a 404.
    let (status, by_id) = test
        .read(
            "GET",
            &format!("/api/read/products/{}/catalog", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{by_id}");
    assert_eq!(by_id["events"], body["events"]);
    assert_eq!(
        test.read("GET", "/api/read/products/missing/catalog", Value::Null)
            .await
            .0,
        404
    );

    // A misspelled event name still runs, with a warning at its path; a real one has none.
    let widget = |event: &str| {
        json!({
            "id": "w", "title": "W",
            "view": {"type": "stat"},
            "queries": {"a": {"signal": "events", "event": event}},
            "series": [{"expr": "a"}]
        })
    };
    let (status, run) = test.run("shop", run_body(widget("checkot"), 7)).await;
    assert_eq!(status, 200, "{run}");
    let warnings = run["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{run}");
    assert_eq!(warnings[0]["path"], "/queries/a/event");
    let (status, run) = test.run("shop", run_body(widget("checkout"), 7)).await;
    assert_eq!(status, 200, "{run}");
    assert_eq!(run["warnings"], json!([]));
    assert_eq!(run["series"][0]["total"], 2.0);
    test.close().await;
}

fn document(name: &str) -> Value {
    json!({
        "version": 1,
        "name": name,
        "widgets": [{
            "id": "views",
            "title": "Page views",
            "view": { "type": "stat" },
            "queries": { "views": { "signal": "events", "event": "page_view", "measure": "count" } },
            "series": [{ "expr": "views" }]
        }]
    })
}
fn dashboards_path(project: &Value) -> String {
    format!("/api/products/{}/dashboards", id(project))
}
async fn create_dashboard(test: &Test, project: &Value, name: &str) -> Value {
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(project),
            json!({"document": document(name)}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}
async fn put(
    test: &Test,
    project: &Value,
    key: &str,
    base: i64,
    document: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut all = vec![("x-piko-admin", "1")];
    all.extend_from_slice(headers);
    test.send(
        "PUT",
        &format!("{}/{key}", dashboards_path(project)),
        json!({"base_revision": base, "document": document}),
        &all,
    )
    .await
}

#[tokio::test]
async fn create_get_update_and_list_by_id_or_slug() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let created = create_dashboard(&test, &project, "Checkout Health").await;
    assert_eq!(created["revision"], 1);
    assert_eq!(created["slug"], "checkout-health");
    assert_eq!(created["document"], document("Checkout Health"));
    let dashboard_id = created["id"].as_str().unwrap();
    assert!(
        uuid::Uuid::parse_str(dashboard_id).is_ok(),
        "{dashboard_id}"
    );

    let base = format!("/api/read/products/{}/dashboards", id(&project));
    let by_slug = test
        .read("GET", &format!("{base}/checkout-health"), Value::Null)
        .await;
    assert_eq!(by_slug.0, 200);
    let by_project_slug = test
        .read(
            "GET",
            &format!("/api/read/products/shop/dashboards/{dashboard_id}"),
            Value::Null,
        )
        .await;
    assert_eq!(by_project_slug.1["id"], dashboard_id);
    assert_eq!(by_slug.1["revision"], 1);
    assert_eq!(by_slug.1["document"], document("Checkout Health"));

    let (status, updated) = put(
        &test,
        &project,
        "checkout-health",
        1,
        document("Checkout Health v2"),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["slug"], "checkout-health");
    assert_eq!(updated["document"]["name"], "Checkout Health v2");

    let (_, list) = test.read("GET", &base, Value::Null).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], dashboard_id);
    assert_eq!(list[0]["slug"], "checkout-health");
    assert_eq!(list[0]["name"], "Checkout Health v2");
    assert!(list[0]["description"].is_null());
    assert_eq!(list[0]["revision"], 2);
    assert_eq!(list[0]["widgets"], 1);
    assert!(list[0]["updated_at"].is_string());

    let (_, products) = test.read("GET", "/api/read/products", Value::Null).await;
    assert_eq!(
        products[0]["dashboards"],
        json!([{"id": dashboard_id, "slug": "checkout-health", "name": "Checkout Health v2"}])
    );
    let (_, products) = test.manage("GET", "/api/products", Value::Null).await;
    assert_eq!(products[0]["dashboards"][0]["slug"], "checkout-health");
    assert_eq!(
        test.read("GET", &format!("{base}/nope"), Value::Null)
            .await
            .0,
        404
    );
    test.close().await;
}

#[tokio::test]
async fn stale_base_revision_conflicts() {
    let test = Test::new();
    let project = test.project("Shop").await;
    create_dashboard(&test, &project, "Board").await;
    assert_eq!(
        put(&test, &project, "board", 1, document("Board"), &[])
            .await
            .0,
        200
    );
    let (status, body) = put(&test, &project, "board", 1, document("Other"), &[]).await;
    assert_eq!(status, 409);
    assert_eq!(body["code"], "revision_conflict");
    assert_eq!(body["revision"], 2);
    let (_, current) = test
        .read(
            "GET",
            "/api/read/products/shop/dashboards/board",
            Value::Null,
        )
        .await;
    assert_eq!(current["revision"], 2);
    assert_eq!(current["document"]["name"], "Board");
    test.close().await;
}

#[tokio::test]
async fn missing_projects_and_sources_are_named_on_dashboard_paths() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let unknown = uuid::Uuid::now_v7().to_string();
    let (from, to) = window(7);
    for (method, path, body) in [
        (
            "GET",
            "/api/read/products/nope/dashboards".to_string(),
            Value::Null,
        ),
        (
            "GET",
            "/api/read/products/nope/catalog".to_string(),
            Value::Null,
        ),
        (
            "GET",
            "/api/read/products/nope/views".to_string(),
            Value::Null,
        ),
        (
            "POST",
            "/api/read/products/nope/query".to_string(),
            json!({"from": from, "to": to}),
        ),
        (
            "POST",
            "/api/read/products/nope/widgets/run".to_string(),
            run_body(error_rate(), 7),
        ),
        (
            "POST",
            format!("/api/products/{unknown}/dashboards"),
            json!({"document": document("Board")}),
        ),
        (
            "POST",
            format!("/api/products/{unknown}/views"),
            json!({"document": {"version": 1, "name": "View", "query": {"measure": "count"}}}),
        ),
    ] {
        let (status, body) = test
            .send(method, &path, body, &[("x-piko-admin", "1")])
            .await;
        assert_eq!(status, 404, "{method} {path}: {body}");
        assert_eq!(
            body["error"], "Project not found",
            "{method} {path}: {body}"
        );
        assert_eq!(body["code"], "not_found", "{method} {path}: {body}");
        assert_eq!(
            body["errors"][0]["path"], "/project",
            "{method} {path}: {body}"
        );
    }
    // A source that is not the project's is named as the argument at fault.
    let mut request = run_body(error_rate(), 7);
    request["source_id"] = json!(unknown);
    let (status, body) = test.run(id(&project), request).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["error"], "Source not found");
    assert_eq!(body["errors"][0]["path"], "/source_id", "{body}");
    assert!(
        body["errors"][0]["hint"]
            .as_str()
            .unwrap()
            .contains("sources"),
        "{body}"
    );
    test.close().await;
}

#[tokio::test]
async fn dashboards_and_views_sort_by_name_ignoring_case() {
    let test = Test::new();
    let project = test.project("Shop").await;
    for name in ["Zeta", "apple", "Mango"] {
        create_dashboard(&test, &project, name).await;
        let (status, body) = test
            .manage(
                "POST",
                &format!("/api/products/{}/views", id(&project)),
                json!({"document": {"version": 1, "name": name, "query": {"measure": "count"}}}),
            )
            .await;
        assert_eq!(status, 200, "{body}");
    }
    let names = |list: &Value| -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap().to_string())
            .collect()
    };
    let expected = ["apple", "Mango", "Zeta"];
    let (_, list) = test
        .read("GET", "/api/read/products/shop/dashboards", Value::Null)
        .await;
    assert_eq!(names(&list), expected);
    let (_, list) = test
        .read("GET", "/api/read/products/shop/views", Value::Null)
        .await;
    assert_eq!(names(&list), expected);
    let (_, products) = test.read("GET", "/api/products", Value::Null).await;
    assert_eq!(names(&products[0]["dashboards"]), expected);
    assert_eq!(names(&products[0]["views"]), expected);
    test.close().await;
}

#[tokio::test]
async fn a_stale_save_with_sql_conflicts_without_waiting_for_the_gate() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let sql = "SELECT count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to";
    let board = json!({
        "version": 1, "name": "Board",
        "widgets": [{"id": "n", "title": "N", "view": {"type": "stat"},
            "queries": {"q": {"signal": "sql", "database": "events", "sql": sql}}}]
    });
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": board.clone()}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        put(&test, &project, "board", 1, board.clone(), &[]).await.0,
        200
    );
    // Every dashboard slot is busy, so verifying the SQL would wait for its deadline.
    let gate = test.state.store.dashboard_event_gate.clone();
    let held = gate.acquire_many_owned(3).await.unwrap();
    let started = std::time::Instant::now();
    let (status, body) = put(&test, &project, "board", 1, board, &[]).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "revision_conflict");
    assert_eq!(body["revision"], 2);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    drop(held);
    test.close().await;
}

#[tokio::test]
async fn concurrent_saves_with_the_same_base_have_one_winner() {
    let test = Test::new();
    let project = test.project("Shop").await;
    create_dashboard(&test, &project, "Board").await;
    let (a, b) = tokio::join!(
        put(&test, &project, "board", 1, document("From A"), &[]),
        put(&test, &project, "board", 1, document("From B"), &[]),
    );
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{a:?} {b:?}");
    let loser = if a.0 == 409 { &a.1 } else { &b.1 };
    assert_eq!(loser["revision"], 2);
    let (_, current) = test
        .read(
            "GET",
            "/api/read/products/shop/dashboards/board",
            Value::Null,
        )
        .await;
    assert_eq!(current["revision"], 2);
    test.close().await;
}

#[tokio::test]
async fn slugs_are_unique_stable_and_never_empty() {
    let test = Test::new();
    let project = test.project("Shop").await;
    // The project slug rule, so non-ASCII letters are dropped, not transliterated.
    assert_eq!(
        create_dashboard(&test, &project, "Ünïcode ✨").await["slug"],
        "n-code"
    );
    assert_eq!(
        create_dashboard(&test, &project, "Café sales").await["slug"],
        "caf-sales"
    );
    assert_eq!(
        create_dashboard(&test, &project, "✨").await["slug"],
        "dashboard"
    );
    assert_eq!(
        create_dashboard(&test, &project, "!!!").await["slug"],
        "dashboard-2"
    );
    assert_eq!(
        create_dashboard(&test, &project, "Checkout").await["slug"],
        "checkout"
    );
    let second = create_dashboard(&test, &project, "Checkout").await;
    assert_eq!(second["slug"], "checkout-2");
    assert_eq!(
        create_dashboard(&test, &project, "Checkout").await["slug"],
        "checkout-3"
    );
    // Renaming keeps the slug, even to a name another dashboard now has.
    let (status, renamed) = put(&test, &project, "checkout-2", 1, document("Renamed"), &[]).await;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["slug"], "checkout-2");
    // Another project may reuse the same slug.
    let other = test.project("Other").await;
    assert_eq!(
        create_dashboard(&test, &other, "Checkout").await["slug"],
        "checkout"
    );
    test.close().await;
}

#[tokio::test]
async fn pruning_keeps_fifty_plus_each_origins_newest() {
    let test = Test::new();
    let project = test.project("Shop").await;
    create_dashboard(&test, &project, "Board").await;
    let marked = [("x-piko-origin", "dashboard")];
    assert_eq!(
        put(&test, &project, "board", 1, document("By hand"), &marked)
            .await
            .0,
        200
    );
    for base in 2..62 {
        let (status, body) = put(&test, &project, "board", base, document("By api"), &[]).await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, revisions) = test
        .read(
            "GET",
            "/api/read/products/shop/dashboards/board/revisions",
            Value::Null,
        )
        .await;
    assert_eq!(status, 200);
    let revisions = revisions.as_array().unwrap();
    assert_eq!(revisions.len(), 51);
    assert_eq!(revisions[0]["revision"], 62);
    assert_eq!(revisions[0]["origin"], "api");
    assert!(revisions[0]["created_at"].is_string());
    let last = revisions.last().unwrap();
    assert_eq!(last["revision"], 2);
    assert_eq!(last["origin"], "dashboard");
    assert_eq!(revisions[49]["revision"], 13);
    test.close().await;
}

#[tokio::test]
async fn restore_writes_a_new_revision() {
    let test = Test::new();
    let project = test.project("Shop").await;
    create_dashboard(&test, &project, "First").await;
    put(&test, &project, "first", 1, document("Second"), &[]).await;
    let (status, restored) = test
        .manage(
            "POST",
            &format!("{}/first/revisions/1/restore", dashboards_path(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["revision"], 3);
    assert_eq!(restored["slug"], "first");
    assert_eq!(restored["document"], document("First"));
    let (_, list) = test
        .read("GET", "/api/read/products/shop/dashboards", Value::Null)
        .await;
    assert_eq!(list[0]["name"], "First");
    let missing = test
        .manage(
            "POST",
            &format!("{}/first/revisions/9/restore", dashboards_path(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(missing.0, 404);
    test.close().await;
}

#[tokio::test]
async fn writes_require_marker_and_limits_hold() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let body = json!({"document": document("Board")});
    let (status, _) = test
        .send("POST", &dashboards_path(&project), body.clone(), &[])
        .await;
    assert_eq!(status, 403);
    assert_eq!(
        test.read("GET", "/api/read/products/shop/dashboards", Value::Null)
            .await
            .1,
        json!([])
    );

    for n in 0..50 {
        create_dashboard(&test, &project, &format!("Board {n}")).await;
    }
    let (status, body) = test.manage("POST", &dashboards_path(&project), body).await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "limit");

    // A document one byte over 64 KiB is refused, on create and on update.
    let mut big = document("Big");
    let base = serde_json::to_vec(&big).unwrap().len();
    big["description"] = json!("");
    let overhead = serde_json::to_vec(&big).unwrap().len() - base;
    let filler = 65_536 + 1 - base - overhead;
    let (other_project, other_key) = (test.project("Big").await, "big");
    big["description"] = json!("x".repeat(filler));
    assert_eq!(serde_json::to_vec(&big).unwrap().len(), 65_537);
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&other_project),
            json!({"document": big}),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "invalid_document", "{body}");
    create_dashboard(&test, &other_project, "Big").await;
    let (status, body) = put(&test, &other_project, other_key, 1, big, &[]).await;
    assert_eq!(status, 400);
    assert_eq!(body["code"], "invalid_document", "{body}");
    test.close().await;
}

#[tokio::test]
async fn validate_endpoint_reports_errors_and_warnings() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let path = format!("/api/read/products/{}/dashboards/validate", id(&project));
    let (status, body) = test
        .read("POST", &path, json!({"document": document("Fine")}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["valid"], true);
    assert_eq!(body["errors"], json!([]));
    // The project has no `page_view` events yet: a warning, not an error.
    assert_eq!(body["warnings"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(
        body["warnings"][0]["path"],
        "/widgets/0/queries/views/event"
    );

    let mut broken = document("Broken");
    broken["widgets"][0]["series"][0]["expr"] = json!("vews");
    let (status, body) = test.read("POST", &path, json!({"document": broken})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["valid"], false);
    assert_eq!(body["errors"][0]["path"], "/widgets/0/series/0/expr");

    let (status, body) = test
        .read("POST", &path, json!({"document": {"version": 1}}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["valid"], false);
    assert!(body["errors"][0]["path"].is_string());
    let missing = test
        .read(
            "POST",
            "/api/read/products/missing/dashboards/validate",
            json!({"document": document("Fine")}),
        )
        .await;
    assert_eq!(missing.0, 404);
    test.close().await;
}

#[tokio::test]
async fn delete_removes_dashboard_and_revisions() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let created = create_dashboard(&test, &project, "Board").await;
    put(&test, &project, "board", 1, document("Board"), &[]).await;
    let path = format!("{}/board", dashboards_path(&project));
    let (status, _, _) = test.send_full("DELETE", &path, Value::Null, &[]).await;
    assert_eq!(status, 403);
    let (status, _) = test.manage("DELETE", &path, Value::Null).await;
    assert_eq!(status, 204);
    assert_eq!(
        test.read(
            "GET",
            "/api/read/products/shop/dashboards/board",
            Value::Null
        )
        .await
        .0,
        404
    );
    assert_eq!(test.manage("DELETE", &path, Value::Null).await.0, 404);
    let connection = test.state.store.sqlite().unwrap();
    let left: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM dashboard_revisions WHERE dashboard_id=?",
            [created["id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    test.close().await;
}

#[tokio::test]
async fn the_validate_slug_is_reserved_so_every_dashboard_is_readable_by_slug() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let first = create_dashboard(&test, &project, "Validate").await;
    assert_eq!(first["slug"], "validate-2");
    let second = create_dashboard(&test, &project, "Validate").await;
    assert_eq!(second["slug"], "validate-3");
    let (status, body) = test
        .read(
            "GET",
            "/api/read/products/shop/dashboards/validate-2",
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["id"], first["id"]);
    test.close().await;
}

async fn preflight(test: &Test, path: &str, origin: &str) -> (StatusCode, HeaderMap) {
    let (status, headers, _) = test
        .send_full(
            "OPTIONS",
            path,
            Value::Null,
            &[
                ("origin", origin),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "content-type"),
            ],
        )
        .await;
    (status, headers)
}

#[tokio::test]
async fn read_cors_allows_loopback_and_configured_origins_only() {
    let mut test = Test::new();
    let path = "/api/read/products/anything/widgets/run";
    for origin in [
        "http://localhost:5173",
        "https://localhost",
        "http://127.0.0.1:3000",
        "http://[::1]:8080",
        "http://[::1]",
    ] {
        let (_, headers) = preflight(&test, path, origin).await;
        assert_eq!(
            headers.get("access-control-allow-origin").unwrap(),
            origin,
            "{origin}"
        );
        assert!(headers.get("access-control-allow-credentials").is_none());
        let methods = headers["access-control-allow-methods"].to_str().unwrap();
        assert!(methods.contains("GET") && methods.contains("POST"));
        let allowed = headers["access-control-allow-headers"].to_str().unwrap();
        assert!(allowed.contains("cf-access-client-secret"));
    }
    for origin in [
        "https://evil.example",
        "null",
        "HTTP://LOCALHOST:5173",
        "http://Localhost:5173",
        "http://localhost.evil.com",
        "http://127.0.0.1.nip.io",
        "http://evil.com:5173",
        "ftp://localhost",
        "http://localhost:abc",
        "http://localhost/path",
        "http://user@localhost",
        "https://dash.example",
    ] {
        let (_, headers) = preflight(&test, path, origin).await;
        assert!(
            headers.get("access-control-allow-origin").is_none(),
            "{origin}"
        );
        assert!(headers.get("access-control-allow-credentials").is_none());
    }
    // A simple cross-origin response carries the header too, still without credentials.
    let (_, headers, _) = test
        .send_full(
            "GET",
            "/api/read/products",
            Value::Null,
            &[("origin", "http://localhost:5173")],
        )
        .await;
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "http://localhost:5173"
    );
    assert!(headers.get("access-control-allow-credentials").is_none());

    test.state.cors_origins = std::sync::Arc::new(vec!["https://dash.example".into()]);
    let (_, headers) = preflight(&test, path, "https://dash.example").await;
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "https://dash.example"
    );
    assert!(headers.get("access-control-allow-credentials").is_none());
    let (_, headers) = preflight(&test, path, "https://other.example").await;
    assert!(headers.get("access-control-allow-origin").is_none());
    let (_, headers) = preflight(&test, path, "null").await;
    assert!(headers.get("access-control-allow-origin").is_none());

    test.state.cors_origins = std::sync::Arc::new(vec!["*".into()]);
    let (_, headers) = preflight(&test, path, "https://anything.example").await;
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "https://anything.example"
    );
    assert!(headers.get("access-control-allow-credentials").is_none());
    let (_, headers) = preflight(&test, path, "null").await;
    assert!(headers.get("access-control-allow-origin").is_none());
    test.close().await;
}

#[tokio::test]
async fn management_writes_never_send_cors() {
    let mut test = Test::new();
    test.state.cors_origins = std::sync::Arc::new(vec!["*".into()]);
    for path in [
        "/api/products/anything/dashboards",
        "/api/products",
        "/api/ingest-not-this",
    ] {
        let (_, headers) = preflight(&test, path, "http://localhost:5173").await;
        assert!(
            headers.get("access-control-allow-origin").is_none(),
            "{path}"
        );
    }
    let (_, headers, _) = test
        .send_full(
            "GET",
            "/api/products",
            Value::Null,
            &[("origin", "http://localhost:5173")],
        )
        .await;
    assert!(headers.get("access-control-allow-origin").is_none());
    test.close().await;
}

#[tokio::test]
async fn read_prefix_has_no_mutating_route() {
    let test = Test::new();
    let base = "/api/read/products/p";
    let paths = [
        "/api/read/products".to_string(),
        format!("{base}/query"),
        format!("{base}/logs/query"),
        format!("{base}/widgets/run"),
        format!("{base}/catalog"),
        format!("{base}/dashboards"),
        format!("{base}/dashboards/validate"),
        format!("{base}/dashboards/d"),
        format!("{base}/dashboards/d/revisions"),
        format!("{base}/views"),
        format!("{base}/views/v"),
        "/api/read/schemas/dashboard.v1.json".to_string(),
    ];
    let posts = ["query", "logs/query", "widgets/run", "dashboards/validate"];
    for path in &paths {
        for method in ["PUT", "PATCH", "DELETE"] {
            let (status, _) = test.send(method, path, json!({}), &[]).await;
            assert!(
                status == StatusCode::METHOD_NOT_ALLOWED || status == StatusCode::NOT_FOUND,
                "{method} {path} -> {status}"
            );
        }
        if !posts.iter().any(|post| path.ends_with(post)) {
            let (status, _) = test.send("POST", path, json!({}), &[]).await;
            assert!(
                status == StatusCode::METHOD_NOT_ALLOWED || status == StatusCode::NOT_FOUND,
                "POST {path} -> {status}"
            );
        }
    }
    let (status, _) = test
        .send("POST", &format!("{base}/dashboards"), json!({}), &[])
        .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    // MCP takes JSON-RPC over POST only (its tools there are read tools); no other method
    // reaches a handler.
    for method in ["GET", "PUT", "PATCH", "DELETE"] {
        let (status, body) = test
            .send(
                method,
                "/api/read/mcp",
                json!({}),
                &[
                    ("host", "piko.example"),
                    ("accept", "application/json, text/event-stream"),
                ],
            )
            .await;
        assert_eq!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} /api/read/mcp: {body}"
        );
    }
    test.close().await;
}

// SQL queries: read-only DuckDB SELECTs over one of a project's databases.

fn sql_query(database: &str, sql: &str) -> Value {
    json!({"signal": "sql", "database": database, "sql": sql})
}
/// A one-query SQL widget over the events database.
fn sql_widget(view: &str, sql: &str) -> Value {
    json!({
        "id": "sql", "title": "SQL", "view": {"type": view},
        "queries": {"q": sql_query("events", sql)}
    })
}
fn total(body: &Value) -> Value {
    body["series"][0]["total"].clone()
}
/// Events in the project, counted through the interactive query.
async fn event_count(test: &Test, project: &Value) -> Value {
    let (from, to) = window(30);
    let (status, body) = test
        .read(
            "POST",
            &format!("/api/read/products/{}/query", id(project)),
            json!({"from": from, "to": to}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body["summary"]["total"].clone()
}
/// Runs `sql` in a stat widget and expects a refusal at the query's `sql` path.
async fn refused(test: &Test, project: &Value, view: &str, sql: &str) -> Value {
    let (status, body) = test
        .run(id(project), run_body(sql_widget(view, sql), 7))
        .await;
    assert_eq!(status, 400, "{sql}: {body}");
    assert_eq!(body["code"], "invalid_document", "{sql}: {body}");
    assert_eq!(body["errors"][0]["path"], "/queries/q/sql", "{sql}: {body}");
    assert!(body["errors"][0]["message"].is_string(), "{sql}: {body}");
    assert!(body["errors"][0]["hint"].is_string(), "{sql}: {body}");
    body["errors"][0].clone()
}
/// Writes events straight into the project's events database, `n` rows named `name`.
fn bulk_events(test: &Test, project: &Value, name: &str, n: usize) {
    let lease = test.state.store.analytics.connection(id(project)).unwrap();
    let now = Utc::now().timestamp_millis();
    lease
        .connection
        .execute(
            "INSERT INTO events(product_id,event_id,name,source,event_time,received_at,properties,source_id)
             SELECT ?, concat(?, i), ?, 'web', ?, ?, '{}', ? FROM range(?) t(i)",
            duckdb::params![id(project), name, name, now, now, id(project), n as i64],
        )
        .unwrap();
}

#[tokio::test]
async fn sql_refuses_every_non_select_and_leaves_data_alone() {
    let test = Test::new();
    let project = test.project("Guarded").await;
    test.seed_events(&project, None, "checkout", 3).await;
    let statements = [
        "INSERT INTO events SELECT * FROM events",
        "UPDATE events SET name = 'x'",
        "DELETE FROM events",
        "CREATE TABLE copy AS SELECT * FROM events",
        "DROP TABLE events",
        "ALTER TABLE events ADD COLUMN x INTEGER",
        "ATTACH ':memory:' AS x",
        "DETACH x",
        "COPY events TO 'x.csv'",
        "EXPORT DATABASE 'dump'",
        "IMPORT DATABASE 'dump'",
        "INSTALL httpfs",
        "LOAD json",
        "SET threads=8",
        "RESET threads",
        "PRAGMA version",
        "CALL pragma_version()",
        "CHECKPOINT",
        "VACUUM",
        "USE memory",
        "PREPARE p AS SELECT 1",
        "EXECUTE p",
        "BEGIN",
        "COMMIT",
        "EXPLAIN SELECT 1",
        "SELECT 1; SELECT 2",
        "SELECT count(*) AS value FROM events; DELETE FROM events",
        "WITH gone AS (SELECT 1) DELETE FROM events",
        "SELECT 1; ATTACH ':memory:' AS x",
    ];
    for sql in statements {
        let issue = refused(&test, &project, "stat", sql).await;
        let text = format!("{issue}");
        assert!(text.contains("single SELECT"), "{sql}: {issue}");
    }
    let issue = refused(&test, &project, "stat", "DELETE FROM events").await;
    assert!(
        issue["hint"].as_str().unwrap().contains("DELETE"),
        "{issue}"
    );
    let issue = refused(&test, &project, "stat", "SELECT 1; SELECT 2").await;
    assert!(
        issue["message"].as_str().unwrap().contains("2 statements"),
        "{issue}"
    );
    assert!(!std::path::Path::new("x.csv").exists());
    assert!(!std::path::Path::new("dump").exists());
    assert_eq!(event_count(&test, &project).await, 3);

    // Syntax errors carry DuckDB's message and where it happened.
    let issue = refused(
        &test,
        &project,
        "stat",
        "SELECT count(*) AS value\nFROM events WHERE AND x",
    )
    .await;
    let message = issue["message"].as_str().unwrap();
    assert!(message.contains("syntax error"), "{issue}");
    assert!(message.contains("line 2, column 19"), "{issue}");
    test.close().await;
}

#[tokio::test]
async fn sql_refuses_escaping_functions_and_other_catalogs() {
    let test = Test::new();
    let project = test.project("Escape").await;
    test.seed_events(&project, None, "checkout", 2).await;
    let cases = [
        (
            "SELECT count(*) AS value FROM read_csv('/etc/passwd')",
            "read_csv",
        ),
        ("SELECT count(*) AS value FROM glob('*')", "glob"),
        (
            "SELECT count(*) AS value FROM query('DROP TABLE events')",
            "query",
        ),
        (
            "SELECT count(*) AS value FROM query_table('events')",
            "query_table",
        ),
        (
            "SELECT count(*) AS value FROM duckdb_databases()",
            "duckdb_databases",
        ),
        ("SELECT nextval('s') AS value", "nextval"),
        ("SELECT setseed(0.5) AS value", "setseed"),
        (
            "SELECT count(*) AS value FROM system.main.something",
            "system",
        ),
        ("SELECT count(*) AS value FROM memory.main.events", "memory"),
        (
            "SELECT count(*) AS value FROM information_schema.tables",
            "information_schema",
        ),
        ("SELECT count(*) AS value FROM 'events.csv'", "events.csv"),
        ("SELECT count(*) AS value FROM logs", "logs"),
        (
            "SELECT count(*) AS value FROM events WHERE name = $name",
            "$name",
        ),
        (
            "SELECT count(*) AS value FROM events WHERE name = ?",
            "parameter",
        ),
        ("DESCRIBE events", "DESCRIBE"),
    ];
    for (sql, needle) in cases {
        let issue = refused(&test, &project, "stat", sql).await;
        assert!(format!("{issue}").contains(needle), "{sql}: {issue}");
    }
    // The table function refusal says what SQL may read instead.
    let issue = refused(
        &test,
        &project,
        "stat",
        "SELECT count(*) AS value FROM read_csv('x')",
    )
    .await;
    let hint = issue["hint"].as_str().unwrap();
    assert!(hint.contains("events table"), "{issue}");
    assert!(
        issue["message"]
            .as_str()
            .unwrap()
            .contains("line 1, column 31"),
        "{issue}"
    );
    assert_eq!(event_count(&test, &project).await, 2);

    // Allowed table functions, CTEs and the events table itself all run.
    let sql = "WITH named AS (SELECT name FROM main.events)
        SELECT count(*) + (SELECT count(*) FROM range(3)) + (SELECT count(*) FROM generate_series(1, 2))
            + (SELECT count(*) FROM unnest([1, 2, 3, 4])) + (SELECT count(*) FROM json_each('[1]')) AS value
        FROM named";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("stat", sql), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 2.0 + 3.0 + 2.0 + 4.0 + 1.0);
    test.close().await;
}

#[tokio::test]
async fn sql_cannot_reach_another_projects_database() {
    let test = Test::new();
    let project = test.project("Tenant A").await;
    let other = test.project("Tenant B").await;
    test.seed_events(&project, None, "mine", 2).await;
    test.seed_events(&other, None, "theirs", 3).await;
    let theirs = test.state.store.analytics.path(id(&other)).unwrap();
    assert!(theirs.exists());
    let file = theirs.display();
    let folder = theirs.parent().unwrap().display();
    // Statements that open, attach or redefine anything are refused before anything runs.
    for sql in [
        format!("ATTACH '{file}' AS theirs"),
        format!("SELECT count(*) AS value FROM events; ATTACH '{file}' AS theirs"),
        format!("ATTACH '{file}' AS all_events (READ_ONLY)"),
        "SELECT 1; ATTACH ':memory:' AS x".into(),
        "USE memory".into(),
        "SET enable_external_access = true".into(),
        "CREATE OR REPLACE TEMP VIEW all_events AS SELECT 1 AS value".into(),
        "CREATE OR REPLACE TEMP MACRO bucket(t) AS 0".into(),
        "SET VARIABLE piko_run = 1".into(),
    ] {
        let issue = refused(&test, &project, "stat", &sql).await;
        assert!(
            format!("{issue}").contains("single SELECT"),
            "{sql}: {issue}"
        );
    }
    // Readers of files and other catalogs are refused, under any name.
    let catalog = id(&other);
    for (sql, needle) in [
        (format!("SELECT count(*) AS value FROM read_blob('{file}')"), "read_blob"),
        (format!("SELECT count(*) AS value FROM read_text('{file}')"), "read_text"),
        (format!("SELECT count(*) AS value FROM read_json('{file}')"), "read_json"),
        (format!("SELECT count(*) AS value FROM read_parquet('{file}')"), "read_parquet"),
        (format!("SELECT count(*) AS value FROM parquet_scan('{file}')"), "parquet_scan"),
        (format!("SELECT count(*) AS value FROM sqlite_scan('{file}', 'events')"), "sqlite_scan"),
        (format!("SELECT count(*) AS value FROM glob('{folder}/*')"), "glob"),
        (format!("SELECT count(*) AS value FROM '{file}'"), "duckdb"),
        (format!("SELECT count(*) AS value FROM \"{catalog}\".main.events"), catalog),
        (format!("SELECT count(*) AS value FROM \"{catalog}\".main.all_events"), catalog),
        ("SELECT count(*) AS value FROM memory.main.all_events".into(), "memory"),
        ("SELECT count(*) AS value FROM system.main.all_events".into(), "system"),
        ("SELECT count(*) AS value FROM temp.main.all_events".into(), "temp"),
        ("SELECT count(*) AS value FROM temp.all_events".into(), "temp"),
        ("SELECT count(*) AS value FROM theirs.all_events".into(), "theirs"),
        (
            "WITH all_events AS (SELECT * FROM memory.main.events) SELECT count(*) AS value FROM all_events".into(),
            "memory",
        ),
        (
            "WITH events AS (SELECT * FROM duckdb_tables()) SELECT count(*) AS value FROM events".into(),
            "duckdb_tables",
        ),
        ("SELECT count(*) AS value FROM duckdb_tables()".into(), "duckdb_tables"),
        ("SELECT count(*) AS value FROM duckdb_databases".into(), "duckdb_databases"),
        ("SELECT count(*) AS value FROM main.other_table".into(), "other_table"),
        ("SELECT count(*) AS value FROM all_logs".into(), "all_logs"),
        ("SELECT getvariable('piko_run') AS value".into(), "getvariable"),
    ] {
        let issue = refused(&test, &project, "stat", &sql).await;
        assert!(format!("{issue}").contains(needle), "{sql}: {issue}");
    }
    // What is allowed reads this project's rows alone, however it is named or aliased.
    for sql in [
        "SELECT count(*) AS value FROM events",
        "SELECT count(*) AS value FROM all_events",
        "SELECT count(*) AS value FROM main.all_events",
        "SELECT count(*) AS value FROM all_events AS memory",
        "SELECT count(*) AS value FROM (SELECT * FROM all_events) theirs",
    ] {
        assert_eq!(stat_total(&test, &project, sql, None).await, 2.0, "{sql}");
    }
    assert_eq!(
        stat_total(
            &test,
            &other,
            "SELECT count(*) AS value FROM all_events",
            None
        )
        .await,
        3.0
    );
    test.close().await;
}

#[tokio::test]
async fn sql_shapes_are_checked_against_the_view() {
    let test = Test::new();
    let project = test.project("Shapes").await;
    let series = "SELECT date_trunc($bucket, epoch_ms(event_time)) AS time, count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1";
    let issue = refused(&test, &project, "stat", series).await;
    let message = issue["message"].as_str().unwrap();
    assert!(
        message.contains("value") && message.contains("time"),
        "{issue}"
    );

    let issue = refused(
        &test,
        &project,
        "ranking",
        "SELECT name, count(*) AS value FROM events GROUP BY name",
    )
    .await;
    assert!(
        issue["message"].as_str().unwrap().contains("label"),
        "{issue}"
    );

    let wide = (0..51)
        .map(|i| format!("{i} AS c{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let issue = refused(&test, &project, "table", &format!("SELECT {wide}")).await;
    assert!(issue["message"].as_str().unwrap().contains("50"), "{issue}");

    // Binder errors keep DuckDB's message and point at the column.
    let issue = refused(
        &test,
        &project,
        "stat",
        "SELECT count(nosuch) AS value FROM events",
    )
    .await;
    let message = issue["message"].as_str().unwrap();
    assert!(message.contains("nosuch"), "{issue}");
    assert!(message.contains("line 1, column 14"), "{issue}");
    // bucket takes a time, and says what kinds.
    let issue = refused(
        &test,
        &project,
        "stat",
        "SELECT max(bucket(name)) AS value FROM events",
    )
    .await;
    assert!(
        issue["message"].as_str().unwrap().contains("bucket"),
        "{issue}"
    );
    let hint = issue["hint"].as_str().unwrap();
    assert!(
        hint.starts_with("bucket takes one time") && hint.contains("TIMESTAMP"),
        "{issue}"
    );

    // The right shapes run; a series takes time and value, a ranking label and value.
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("line", series), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    let ranking = "SELECT name AS label, count(*) AS value FROM events GROUP BY 1 ORDER BY 2 DESC";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("ranking", ranking), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"][0]["groups"], json!([]));

    // A table widget has exactly one SQL query and no series.
    let mut widget = sql_widget("table", "SELECT 1 AS one");
    widget["queries"]["typed"] = json!({"signal": "events"});
    let (status, body) = test.run(id(&project), run_body(widget, 7)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "/queries");
    let mut widget = sql_widget("table", "SELECT 1 AS one");
    widget["series"] = json!([{"expr": "q"}]);
    let (status, body) = test.run(id(&project), run_body(widget, 7)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "/series");
    // SQL is limited to 8,000 characters.
    let long = format!("SELECT 1 AS value -- {}", "x".repeat(8_000));
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("stat", &long), 7))
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "/queries/q/sql");
    test.close().await;
}

#[tokio::test]
async fn sql_parameters_bind_by_name() {
    let test = Test::new();
    let project = test.project("Params").await;
    let ios = test.source(&project, "iOS").await;
    test.seed_events(&project, None, "visit", 3).await;
    test.seed_events(&project, Some(&ios), "visit", 2).await;
    let old = (Utc::now() - Duration::days(10)).to_rfc3339();
    test.ingest_events(
        &project,
        None,
        vec![json!({"name": "visit", "timestamp": old})],
    )
    .await;

    let scoped = "SELECT count(*) AS value FROM events
        WHERE event_time >= $from AND event_time < $to AND ($source IS NULL OR source_id = $source)";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("stat", scoped), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 5.0);
    assert_eq!(body["warnings"], json!([]));
    let mut request = run_body(sql_widget("stat", scoped), 7);
    request["source_id"] = json!(ios);
    let (status, body) = test.run(id(&project), request).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 2.0);

    // Every parameter is bound by name, in any order and any number of times.
    let echo = "SELECT $bucket AS bucket, $to AS to_ms, $from AS from_ms, $source AS source, $from - $from AS zero";
    let (from, to) = window(7);
    let mut request =
        json!({"widget": sql_widget("table", echo), "from": from, "to": to, "bucket": "week"});
    let (status, body) = test.run(id(&project), request.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["rows"],
        json!([[
            "week",
            to.timestamp_millis(),
            from.timestamp_millis(),
            null,
            0
        ]])
    );
    request["source_id"] = json!(ios);
    let (_, body) = test.run(id(&project), request).await;
    assert_eq!(body["rows"][0][3], json!(ios));

    // Only a query that reads nothing but all_events, without $from or $to, ignores the range,
    // and its warning says so.
    let all = "SELECT count(*) AS value FROM all_events";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("stat", all), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 6.0);
    assert_eq!(body["warnings"].as_array().unwrap().len(), 1, "{body}");
    let warning = &body["warnings"][0];
    assert_eq!(warning["path"], "/queries/q/sql", "{body}");
    assert_eq!(
        warning["message"],
        "This query reads only all_events, so it shows all history and ignores the dashboard's range"
    );
    let hint = warning["hint"].as_str().unwrap();
    assert!(
        hint.contains("all history") && hint.contains("events") && hint.contains("$from"),
        "{hint}"
    );
    for sql in [
        "SELECT count(*) AS value FROM events",
        "SELECT count(*) AS value FROM all_events WHERE event_time >= $from",
        "SELECT count(*) AS value FROM all_events WHERE event_time < $to",
        "SELECT (SELECT count(*) FROM all_events) - (SELECT count(*) FROM events) AS value",
        "SELECT 7 AS value",
        "SELECT count(*) AS value FROM range(3)",
    ] {
        let (status, body) = test
            .run(id(&project), run_body(sql_widget("stat", sql), 7))
            .await;
        assert_eq!(status, 200, "{sql}: {body}");
        assert_eq!(body["warnings"], json!([]), "{sql}: {body}");
    }
    // A WITH named events over all_events reads only all history.
    let shadowed = "WITH events AS (SELECT * FROM all_events) SELECT count(*) AS value FROM events";
    let (_, body) = test
        .run(id(&project), run_body(sql_widget("stat", shadowed), 7))
        .await;
    assert_eq!(body["warnings"][0]["path"], "/queries/q/sql", "{body}");
    test.close().await;
}

/// Runs `sql` in a stat widget over the last 7 days, scoped to `source` when given, and
/// returns its total.
async fn stat_total(test: &Test, project: &Value, sql: &str, source: Option<&str>) -> Value {
    let mut request = run_body(sql_widget("stat", sql), 7);
    if let Some(source) = source {
        request["source_id"] = json!(source);
    }
    let (status, body) = test.run(id(project), request).await;
    assert_eq!(status, 200, "{sql}: {body}");
    total(&body)
}

#[tokio::test]
async fn sql_events_hold_only_the_dashboards_range_and_source() {
    let test = Test::new();
    let project = test.project("Scoped").await;
    let ios = test.source(&project, "iOS").await;
    test.seed_events(&project, None, "visit", 3).await;
    test.seed_events(&project, Some(&ios), "visit", 2).await;
    let old = (Utc::now() - Duration::days(10)).to_rfc3339();
    test.ingest_events(
        &project,
        None,
        vec![json!({"name": "visit", "timestamp": old})],
    )
    .await;
    let ios = Some(ios.as_str());
    for (sql, source, expected) in [
        // No $from or $to: events holds the window's rows, of the chosen source only.
        ("SELECT count(*) AS value FROM events", None, 5.0),
        ("SELECT count(*) AS value FROM events", ios, 2.0),
        // A qualified name is the same scoped relation.
        ("SELECT count(*) AS value FROM main.events", None, 5.0),
        // all_events holds all history, of every source.
        ("SELECT count(*) AS value FROM all_events", None, 6.0),
        ("SELECT count(*) AS value FROM all_events", ios, 6.0),
        // Filtering events by $from and $to as well is harmless.
        (
            "SELECT count(*) AS value FROM events WHERE event_time >= $from AND event_time < $to AND ($source IS NULL OR source_id = $source)",
            ios,
            2.0,
        ),
        // A WITH named events shadows it, as any WITH does.
        (
            "WITH events AS (SELECT * FROM all_events) SELECT count(*) AS value FROM events",
            None,
            6.0,
        ),
        (
            "WITH events AS (SELECT 42 AS value) SELECT value FROM events",
            None,
            42.0,
        ),
        // Inside its own definition, events is still the scoped relation.
        (
            "WITH events AS (SELECT * FROM events WHERE name = 'visit') SELECT count(*) AS value FROM events",
            ios,
            2.0,
        ),
        // Joins and subqueries see the same rows.
        (
            "SELECT count(*) AS value FROM events e JOIN all_events a USING (event_id)",
            None,
            5.0,
        ),
        (
            "SELECT (SELECT count(*) FROM all_events) - (SELECT count(*) FROM events) AS value",
            None,
            1.0,
        ),
    ] {
        let total = stat_total(&test, &project, sql, source).await;
        assert_eq!(total, expected, "{sql} ({source:?})");
    }
    // Result columns and their order are the query's own, ORDER BY included.
    let (status, body) = test
        .run(
            id(&project),
            run_body(
                sql_widget(
                    "table",
                    "SELECT event_time AS b, name AS a FROM all_events ORDER BY event_time",
                ),
                7,
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["columns"],
        json!([{"name": "b", "type": "BIGINT"}, {"name": "a", "type": "VARCHAR"}])
    );
    let times: Vec<i64> = body["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_i64().unwrap())
        .collect();
    assert_eq!(times.len(), 6);
    assert!(times.is_sorted(), "{times:?}");
    test.close().await;
}

/// Writes logs straight into the project's logs database: `(source id, epoch ms)` each.
fn insert_logs(test: &Test, project: &Value, logs: &[(&str, i64)]) {
    let lease = test.state.store.logs.connection(id(project)).unwrap();
    for (source, at) in logs {
        lease
            .connection
            .execute(
                "INSERT INTO logs VALUES (?, ?, ?, ?, 'error', 'Failed', 'checkout', NULL, NULL, NULL, NULL, '{}')",
                duckdb::params![uuid::Uuid::now_v7().to_string(), source, at, at],
            )
            .unwrap();
    }
}

#[tokio::test]
async fn sql_logs_hold_only_the_dashboards_range_and_source() {
    let test = Test::new();
    let project = test.project("Scoped logs").await;
    let ios = test.source(&project, "iOS").await;
    let web = test.source(&project, "Web").await;
    let now = Utc::now().timestamp_millis();
    let day = 86_400_000;
    insert_logs(
        &test,
        &project,
        &[
            (&web, now - 1000),
            (&web, now - 2000),
            (&ios, now - 3000),
            (&web, now - 3 * day),
        ],
    );
    let run = |sql: &str, source: Option<&str>| {
        let widget = json!({
            "id": "logs", "title": "Logs", "view": {"type": "stat"},
            "queries": {"q": sql_query("logs", sql)}
        });
        let mut request = run_body(widget, 1);
        if let Some(source) = source {
            request["source_id"] = json!(source);
        }
        let test = &test;
        let project = &project;
        let sql = sql.to_string();
        async move {
            let (status, body) = test.run(id(project), request).await;
            assert_eq!(status, 200, "{sql}: {body}");
            total(&body)
        }
    };
    assert_eq!(run("SELECT count(*) AS value FROM logs", None).await, 3.0);
    assert_eq!(
        run("SELECT count(*) AS value FROM logs", Some(&ios)).await,
        1.0
    );
    assert_eq!(
        run("SELECT count(*) AS value FROM logs", Some(&web)).await,
        2.0
    );
    assert_eq!(
        run("SELECT count(*) AS value FROM all_logs", None).await,
        4.0
    );
    assert_eq!(
        run("SELECT count(*) AS value FROM all_logs", Some(&ios)).await,
        4.0
    );
    test.close().await;
}

#[tokio::test]
async fn sql_bucket_lands_on_the_typed_grid() {
    let test = Test::new();
    let project = test.project("Grid").await;
    let now = Utc::now();
    let hour = now.duration_trunc(Duration::hours(1)).unwrap();
    let day = now.duration_trunc(Duration::days(1)).unwrap();
    let monday = day - Duration::days(i64::from(day.weekday().num_days_from_monday()));
    let first = day - Duration::days(i64::from(day.day0()));
    let mut times = vec![
        now - Duration::hours(1),
        now - Duration::days(3),
        now - Duration::days(45),
        now - Duration::days(150),
    ];
    // Exactly on a boundary of each bucket, and a millisecond before it.
    for boundary in [hour, day, monday, first] {
        times.extend([boundary, boundary - Duration::milliseconds(1)]);
    }
    let events = times
        .iter()
        .map(|t| json!({"name": "visit", "timestamp": t.to_rfc3339()}))
        .collect();
    test.ingest_events(&project, None, events).await;
    for (bucket, days) in [("hour", 2), ("day", 7), ("week", 60), ("month", 200)] {
        let widget = json!({
            "id": "grid", "title": "Grid",
            "view": {"type": "line", "bucket": bucket, "compare": "none"},
            "queries": {
                "sql": {
                    "signal": "sql", "database": "events", "missing": "zero",
                    "sql": "SELECT bucket(event_time) AS time, count(*) AS value FROM events GROUP BY 1"
                },
                "typed": {"signal": "events"}
            }
        });
        let (status, body) = test.run(id(&project), run_body(widget, days)).await;
        assert_eq!(status, 200, "{bucket}: {body}");
        assert_eq!(body["range"]["bucket"], bucket, "{body}");
        let (sql, typed) = (&body["series"][0], &body["series"][1]);
        assert_eq!(sql["points"], typed["points"], "{bucket}: {body}");
        assert_eq!(sql["total"], typed["total"], "{bucket}: {body}");
        assert!(typed["total"].as_f64().unwrap() > 0.0, "{bucket}: {body}");
    }
    test.close().await;
}

#[tokio::test]
async fn sql_previous_period_rescopes_events() {
    let test = Test::new();
    let project = test.project("Compare").await;
    let now = Utc::now();
    test.seed_events_at(&project, "visit", 2, now - Duration::days(1))
        .await;
    test.seed_events_at(&project, "visit", 3, now - Duration::days(10))
        .await;
    test.seed_events_at(&project, "visit", 4, now - Duration::days(20))
        .await;
    // Stats compare with the previous period by default, which runs the SQL again over it.
    let (status, body) = test
        .run(
            id(&project),
            run_body(
                sql_widget("stat", "SELECT count(*) AS value FROM events"),
                7,
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"][0]["total"], 2.0, "{body}");
    assert_eq!(body["series"][0]["previous_total"], 3.0, "{body}");
    // all_events is all history in both periods.
    let (_, body) = test
        .run(
            id(&project),
            run_body(
                sql_widget("stat", "SELECT count(*) AS value FROM all_events"),
                7,
            ),
        )
        .await;
    assert_eq!(body["series"][0]["total"], 9.0, "{body}");
    assert_eq!(body["series"][0]["previous_total"], 9.0, "{body}");
    test.close().await;
}

#[tokio::test]
async fn sql_series_align_and_combine_in_formulas() {
    let test = Test::new();
    let project = test.project("Align").await;
    let at = |days: i64| (Utc::now() - Duration::days(days)).to_rfc3339();
    let mut events = Vec::new();
    for (name, days, n) in [("req", 3, 4), ("req", 1, 2), ("err", 3, 1), ("err", 1, 1)] {
        events.extend((0..n).map(|_| json!({"name": name, "timestamp": at(days)})));
    }
    test.ingest_events(&project, None, events).await;
    let errors = "SELECT date_trunc($bucket, epoch_ms(event_time)) AS time, count(*) AS value
        FROM events WHERE name = 'err' AND event_time >= $from AND event_time < $to GROUP BY 1";
    let widget = |missing: &str, series: Value| {
        let mut sql = sql_query("events", errors);
        sql["missing"] = json!(missing);
        json!({
            "id": "rate", "title": "Error rate", "view": {"type": "line", "bucket": "day"},
            "queries": {"errs": sql, "reqs": {"signal": "events", "event": "req"}},
            "series": series
        })
    };
    // The day buckets of the run's window: eight, or nine when it crosses midnight.
    let (from, to) = window(7);
    let buckets =
        ((to - Duration::milliseconds(1)).date_naive() - from.date_naive()).num_days() as usize + 1;
    let request = |widget: Value| json!({"widget": widget, "from": from, "to": to});
    let ratio = json!([{"expr": "errs / reqs * 100"}]);
    let (status, body) = test.run(id(&project), request(widget("zero", ratio))).await;
    assert_eq!(status, 200, "{body}");
    let series = &body["series"][0];
    // Totals come from totals: two errors over six requests.
    assert_eq!(series["total"].as_f64().unwrap(), 2.0 / 6.0 * 100.0);
    let points = series["points"].as_array().unwrap();
    assert_eq!(points.len(), buckets, "{series}");
    let values: Vec<Value> = points.iter().map(|p| p["value"].clone()).collect();
    let day = |days: i64| {
        let start = (Utc::now() - Duration::days(days)).date_naive();
        start
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    };
    let at_day = |days: i64| {
        points
            .iter()
            .find(|p| p["time"] == day(days))
            .map(|p| p["value"].clone())
            .unwrap()
    };
    assert_eq!(at_day(3), 25.0);
    assert_eq!(at_day(1), 50.0);
    // Empty days are 0 / 0, so they have no value.
    assert_eq!(
        values.iter().filter(|v| v.is_null()).count(),
        buckets - 2,
        "{series}"
    );

    // `missing: zero` fills the absent buckets of the SQL series itself, and the total is the
    // sum of its points; `null` leaves them as gaps.
    let (_, body) = test
        .run(
            id(&project),
            request(widget("zero", json!([{"expr": "errs"}, {"expr": "reqs"}]))),
        )
        .await;
    let errs = &body["series"][0];
    assert_eq!(errs["total"], 2.0);
    let points = errs["points"].as_array().unwrap();
    assert_eq!(points.len(), buckets);
    assert_eq!(
        points.iter().filter(|p| p["value"] == 0.0).count(),
        buckets - 2,
        "{errs}"
    );
    let sum: f64 = points.iter().filter_map(|p| p["value"].as_f64()).sum();
    assert_eq!(sum, 2.0);
    let (_, body) = test
        .run(
            id(&project),
            request(widget("null", json!([{"expr": "errs"}, {"expr": "reqs"}]))),
        )
        .await;
    let points = body["series"][0]["points"].as_array().unwrap();
    assert_eq!(
        points.iter().filter(|p| p["value"].is_null()).count(),
        buckets - 2
    );
    assert_eq!(body["series"][0]["total"], 2.0);

    // Grouped SQL series draw one series per group, and rankings align by JSON label.
    let grouped = "SELECT date_trunc($bucket, epoch_ms(event_time)) AS time, name AS \"group\", count(*) AS value
        FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1, 2";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("line", grouped), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    let groups: Vec<Value> = body["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["group"].clone())
        .collect();
    assert_eq!(groups, [json!("req"), json!("err")]);
    let ranking = json!({
        "id": "names", "title": "Names", "view": {"type": "ranking"},
        "queries": {
            "sql": sql_query("events", "SELECT name AS label, count(*) AS value FROM events GROUP BY 1 ORDER BY 2 DESC"),
            "typed": {"signal": "events", "group_by": "name"}
        },
        "series": [{"expr": "sql"}, {"expr": "typed - sql"}]
    });
    let (status, body) = test.run(id(&project), run_body(ranking, 7)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["series"][0]["groups"],
        json!([{"label": "req", "value": 6.0}, {"label": "err", "value": 2.0}])
    );
    assert_eq!(body["series"][0]["total"], 8.0);
    assert_eq!(
        body["series"][1]["groups"],
        json!([{"label": "req", "value": 0.0}, {"label": "err", "value": 0.0}])
    );
    test.close().await;
}

#[tokio::test]
async fn sql_table_view_returns_rows_and_columns() {
    let test = Test::new();
    let project = test.project("Table").await;
    test.ingest_events(
        &project,
        None,
        vec![
            json!({"name": "checkout", "properties": {"plan": "pro"}}),
            json!({"name": "checkout", "properties": {"plan": "pro"}}),
            json!({"name": "signup", "properties": {"plan": "free"}}),
        ],
    )
    .await;
    let sql = "SELECT name, count(*) AS n, epoch_ms(max(event_time)) AS last_seen,
            any_value(properties) AS props, count(*) > 1 AS repeated, 1.5::DECIMAL(4,2) AS price, NULL AS nothing
        FROM events WHERE event_time >= $from AND event_time < $to GROUP BY name ORDER BY n DESC";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("table", sql), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["series"], json!([]));
    assert_eq!(body["warnings"], json!([]));
    assert_eq!(
        body["columns"],
        json!([
            {"name": "name", "type": "VARCHAR"},
            {"name": "n", "type": "BIGINT"},
            {"name": "last_seen", "type": "TIMESTAMP"},
            {"name": "props", "type": "JSON"},
            {"name": "repeated", "type": "BOOLEAN"},
            {"name": "price", "type": "DECIMAL(4,2)"},
            {"name": "nothing", "type": "NULL"},
        ])
    );
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0], "checkout");
    assert_eq!(rows[0][1], 2);
    // Timestamps are epoch milliseconds, JSON is parsed, decimals are numbers.
    let last = rows[0][2].as_i64().unwrap();
    assert!(
        (Utc::now().timestamp_millis() - last).abs() < 60_000,
        "{body}"
    );
    assert_eq!(rows[0][3], json!({"plan": "pro"}));
    assert_eq!(rows[0][4], true);
    assert_eq!(rows[0][5], "1.50");
    assert_eq!(rows[0][6], Value::Null);
    assert_eq!(rows[1][0], "signup");
    assert_eq!(rows[1][4], false);
    test.close().await;
}

#[tokio::test]
async fn sql_row_cap_truncates_with_a_warning() {
    let test = Test::new();
    let project = test.project("Many").await;
    bulk_events(&test, &project, "bulk", 10_050);
    let recent = "SELECT event_id FROM events WHERE event_time >= $from AND event_time < $to";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("table", recent), 7))
        .await;
    assert_eq!(status, 200, "{body:.200}");
    assert_eq!(body["rows"].as_array().unwrap().len(), 10_000);
    assert_eq!(
        body["warnings"],
        json!([{"path": "/queries/q/sql", "message": "Showing the first 10,000 rows", "hint": null}])
    );
    let (status, body) = test
        .run(
            id(&project),
            run_body(sql_widget("table", &format!("{recent} LIMIT 10000")), 7),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["rows"].as_array().unwrap().len(), 10_000);
    assert_eq!(body["warnings"], json!([]));
    test.close().await;
}

#[tokio::test]
async fn heavy_sql_times_out_and_releases_slots() {
    let test = Test::new();
    let project = test.project("Heavy").await;
    let mut widget = sql_widget(
        "stat",
        "SELECT count(*) AS value FROM range(10000000000) a, range(10) b",
    );
    widget["timeout_ms"] = json!(1000);
    let started = std::time::Instant::now();
    let (status, body) = test.run(id(&project), run_body(widget, 7)).await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(body["code"], "query_timeout");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let store = &test.state.store;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while store.query_slots.available_permits() != 4
        || store.dashboard_event_gate.available_permits() != 3
    {
        assert!(std::time::Instant::now() < until, "slots return");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (status, body) = test
        .run(
            id(&project),
            run_body(sql_widget("stat", "SELECT 7 AS value"), 7),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 7.0);
    test.close().await;
}

#[tokio::test]
async fn logs_sql_reads_only_the_logs_database() {
    let test = Test::new();
    let project = test.project("Logs SQL").await;
    test.seed_events(&project, None, "checkout", 5).await;
    test.seed_logs(&project, "checkout", "error", 3).await;
    test.seed_logs(&project, "search", "info", 1).await;
    let logs = |sql: &str| {
        json!({
            "id": "logs", "title": "Logs", "view": {"type": "ranking"},
            "queries": {"q": sql_query("logs", sql)}
        })
    };
    let by_service = "SELECT service AS label, count(*) AS value FROM logs
        WHERE timestamp >= $from AND timestamp < $to GROUP BY 1 ORDER BY 2 DESC";
    let (status, body) = test.run(id(&project), run_body(logs(by_service), 90)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["series"][0]["groups"],
        json!([{"label": "checkout", "value": 3.0}, {"label": "search", "value": 1.0}])
    );
    // A logs query keeps the log range, like typed log queries.
    assert_eq!(body["range"]["clamped"], true);

    // Each query sees only the database it names.
    for sql in [
        "SELECT name AS label, count(*) AS value FROM events GROUP BY 1",
        "SELECT name AS label, count(*) AS value FROM main.events GROUP BY 1",
    ] {
        let (status, body) = test.run(id(&project), run_body(logs(sql), 7)).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["errors"][0]["path"], "/queries/q/sql");
        assert!(format!("{body}").contains("logs"), "{body}");
    }
    let issue = refused(
        &test,
        &project,
        "stat",
        "SELECT count(*) AS value FROM logs",
    )
    .await;
    assert!(format!("{issue}").contains("events"), "{issue}");
    test.close().await;
}

#[tokio::test]
async fn sql_is_verified_on_validate_and_on_writes() {
    let test = Test::new();
    let project = test.project("Writes").await;
    let doc = |sql: &str| {
        json!({
            "version": 1,
            "name": "Churn",
            "widgets": [
                {"id": "note", "title": "Note", "view": {"type": "text", "markdown": "Hi"}, "queries": {}},
                {
                    "id": "cohorts", "title": "Cohorts", "view": {"type": "table"},
                    "queries": {"q": {"signal": "sql", "database": "events", "sql": sql, "missing": "null"}}
                }
            ]
        })
    };
    let good = "SELECT name, count(*) AS n FROM events WHERE event_time >= $from AND event_time < $to GROUP BY 1";
    let validate = format!("/api/read/products/{}/dashboards/validate", id(&project));
    let (status, body) = test
        .read("POST", &validate, json!({"document": doc(good)}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["valid"], true, "{body}");
    for bad in [
        "DELETE FROM events",
        "SELECT * FROM read_csv('x')",
        "SELECT nosuch FROM events",
    ] {
        let (status, body) = test
            .read("POST", &validate, json!({"document": doc(bad)}))
            .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["valid"], false, "{bad}: {body}");
        assert_eq!(
            body["errors"][0]["path"], "/widgets/1/queries/q/sql",
            "{bad}: {body}"
        );
        assert!(body["errors"][0]["hint"].is_string(), "{bad}: {body}");
    }

    let (status, created) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": doc(good)}),
        )
        .await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["document"], doc(good));
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": doc("DROP TABLE events")}),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "invalid_document");
    assert_eq!(body["errors"][0]["path"], "/widgets/1/queries/q/sql");
    let (status, body) = put(
        &test,
        &project,
        "churn",
        1,
        doc("SELECT nosuch FROM events"),
        &[],
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "/widgets/1/queries/q/sql");
    let (status, body) = put(&test, &project, "churn", 1, document("Plain"), &[]).await;
    assert_eq!(status, 200, "{body}");
    // Restoring re-verifies the revision too, and a good one restores.
    let (status, body) = test
        .manage(
            "POST",
            &format!("{}/churn/revisions/1/restore", dashboards_path(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["revision"], 3);
    // A missing project is a 404, before any SQL runs.
    let (status, _) = test
        .manage(
            "POST",
            &format!("/api/products/{}/dashboards", uuid::Uuid::now_v7()),
            json!({"document": doc(good)}),
        )
        .await;
    assert_eq!(status, 404);
    test.close().await;
}

#[tokio::test]
async fn catalog_describes_the_sql_schemas_and_parameters() {
    let test = Test::new();
    let project = test.project("Catalog SQL").await;
    let (status, body) = test
        .read(
            "GET",
            &format!("/api/read/products/{}/catalog", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let sql = &body["sql"];
    assert_eq!(sql["parameters"], json!(["from", "to", "bucket", "source"]));
    let has = |table: &str, name: &str, kind: &str| {
        sql[table]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == name && c["type"] == kind)
    };
    assert!(has("events", "event_time", "BIGINT"), "{sql}");
    assert!(has("events", "properties", "JSON"), "{sql}");
    assert!(has("events", "source_id", "VARCHAR"), "{sql}");
    assert!(has("logs", "timestamp", "BIGINT"), "{sql}");
    assert!(has("logs", "attributes", "JSON"), "{sql}");
    assert!(!has("logs", "event_time", "BIGINT"));
    // The whole tables have the same columns, and the catalog says which names are scoped.
    assert_eq!(sql["all_events"], sql["events"]);
    assert_eq!(sql["all_logs"], sql["logs"]);
    let tables = sql["tables"].as_array().unwrap();
    let names: Vec<(&str, &str, bool)> = tables
        .iter()
        .map(|t| {
            (
                t["name"].as_str().unwrap(),
                t["database"].as_str().unwrap(),
                t["scoped"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("events", "events", true),
            ("all_events", "events", false),
            ("logs", "logs", true),
            ("all_logs", "logs", false),
        ]
    );
    assert!(tables.iter().all(|t| t["description"].is_string()), "{sql}");
    assert!(
        tables[0]["description"].as_str().unwrap().contains("range"),
        "{sql}"
    );
    assert_eq!(sql["functions"][0]["name"], "bucket", "{sql}");
    assert_eq!(sql["functions"][0]["call"], "bucket(event_time)", "{sql}");
    assert!(sql["functions"][0]["description"].is_string(), "{sql}");
    assert_eq!(body["limits"]["max_sql_chars"], 8_000);
    assert_eq!(body["limits"]["max_sql_rows"], 10_000);
    assert_eq!(body["limits"]["max_table_columns"], 50);
    test.close().await;
}

#[tokio::test]
async fn sql_cannot_reach_system_catalogs_or_settings() {
    let test = Test::new();
    let project = test.project("Catalog escape").await;
    test.seed_events(&project, None, "checkout", 2).await;
    // A WITH that names itself reads the system view of that name; recursive or not, it is
    // refused in the tree. Catalog macros pass the tree and are refused by the plan.
    for (sql, needle) in [
        (
            "WITH duckdb_databases AS (SELECT * FROM duckdb_databases) SELECT count(path) AS value FROM duckdb_databases",
            "duckdb_databases",
        ),
        (
            "WITH RECURSIVE duckdb_databases AS (SELECT * FROM duckdb_databases) SELECT count(path) AS value FROM duckdb_databases",
            "duckdb_databases",
        ),
        (
            "WITH pg_settings AS (SELECT * FROM pg_settings) SELECT count(*) AS value FROM pg_settings",
            "pg_settings",
        ),
        (
            "WITH RECURSIVE pg_settings AS (SELECT * FROM pg_settings) SELECT count(*) AS value FROM pg_settings",
            "pg_settings",
        ),
        (
            "WITH sqlite_master AS (SELECT * FROM sqlite_master) SELECT count(sql) AS value FROM sqlite_master",
            "sqlite_master",
        ),
        (
            "WITH RECURSIVE sqlite_master AS (SELECT * FROM sqlite_master) SELECT count(sql) AS value FROM sqlite_master",
            "sqlite_master",
        ),
        ("SELECT length(pg_get_viewdef(1)) AS value", "duckdb_views"),
        ("SELECT length(format_type(23, 0)) AS value", "duckdb_types"),
        (
            "SELECT length(current_setting('temp_directory')) AS value",
            "current_setting",
        ),
        (
            "SELECT length(current_setting('secret_directory')) AS value",
            "current_setting",
        ),
        ("SELECT length(getvariable('x')) AS value", "getvariable"),
    ] {
        let issue = refused(&test, &project, "stat", sql).await;
        assert!(format!("{issue}").contains(needle), "{sql}: {issue}");
    }
    let issue = refused(&test, &project, "table", "SELECT pg_get_viewdef(1) AS def").await;
    assert!(
        issue["message"]
            .as_str()
            .unwrap()
            .starts_with("This query reads duckdb_views"),
        "{issue}"
    );
    // A real recursive WITH is refused whatever it is called, since it can grow without bound.
    let sql = "WITH RECURSIVE duckdb_databases(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM duckdb_databases WHERE n < 4)
        SELECT count(*) AS value FROM duckdb_databases";
    let issue = refused(&test, &project, "stat", sql).await;
    assert!(
        issue["message"]
            .as_str()
            .unwrap()
            .starts_with("WITH RECURSIVE is not allowed (line 1, column 6)"),
        "{issue}"
    );
    test.close().await;
}

#[tokio::test]
async fn deeply_nested_or_costly_sql_is_refused_not_fatal() {
    // Widget runs and validation use Tokio's 2 MiB blocking threads; each of these overflowed
    // one (aborting the process) or planned for minutes before the fix.
    let test = Test::new();
    let project = test.project("Deep").await;
    let validate = format!("/api/read/products/{}/dashboards/validate", id(&project));
    let nested = |open: &str, close: &str, n: usize| {
        format!("SELECT {}1{} AS value", open.repeat(n), close.repeat(n))
    };
    let siblings = (0..40)
        .map(|i| format!("(SELECT t.x + {i})"))
        .collect::<Vec<_>>()
        .join(" + ");
    let lateral: String = (1..60)
        .map(|i| format!(", LATERAL (SELECT t{}.*) t{i}", i - 1))
        .collect();
    let with = |n: usize| {
        let chain: String = (1..n)
            .map(|i| format!(", t{i} AS (SELECT v FROM t{})", i - 1))
            .collect();
        format!(
            "WITH t0 AS (SELECT 1 AS v){chain} SELECT v AS value FROM t{}",
            n - 1
        )
    };
    for (sql, needle) in [
        (nested("(SELECT ", ")", 880), "Max expression depth"),
        (nested("abs(", ")", 990), "Max expression depth"),
        (nested("abs(", ")", 140), "nests too deeply"),
        (
            format!("SELECT {siblings} AS value FROM range(3) t(x)"),
            "joins and subqueries",
        ),
        (
            format!("SELECT 1 AS value FROM range(1) t0{lateral}"),
            "joins and subqueries",
        ),
        (with(270), "Max expression depth"),
    ] {
        assert!(sql.chars().count() <= 8_000);
        let started = std::time::Instant::now();
        let issue = refused(&test, &project, "stat", &sql).await;
        assert!(
            issue["message"].as_str().unwrap().contains(needle),
            "{issue}"
        );
        assert!(
            !issue["message"].as_str().unwrap().contains("SET"),
            "{issue}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let widget = sql_widget("stat", &sql);
        let doc = json!({"version": 1, "name": "Deep", "widgets": [widget]});
        let (status, body) = test.read("POST", &validate, json!({"document": doc})).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            body["errors"][0]["path"], "/widgets/0/queries/q/sql",
            "{body}"
        );
    }
    // A long WITH chain within the limits runs, and the API is still up afterwards.
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("stat", &with(200)), 7))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(total(&body), 1.0);
    test.close().await;
}

#[tokio::test]
async fn sql_results_stop_at_four_megabytes() {
    let test = Test::new();
    let project = test.project("Wide").await;
    // repeat is refused, so the 100,000-character value is aggregated once.
    let sql = "SELECT big FROM (SELECT string_agg('x', '') AS big FROM range(100000)) t, range(100) WHERE $from > 0";
    let (status, body) = test
        .run(id(&project), run_body(sql_widget("table", sql), 7))
        .await;
    assert_eq!(status, 200);
    let n = body["rows"].as_array().unwrap().len();
    assert!((1..100).contains(&n), "{n}");
    assert_eq!(
        body["warnings"],
        json!([{"path": "/queries/q/sql", "message": format!("Showing the first {n} rows (4 MB limit)"), "hint": null}])
    );
    test.close().await;
}

// Benchmarks before saving, and the write rate limit.

fn views_widget(id: &str, event: &str) -> Value {
    json!({
        "id": id, "title": id, "view": {"type": "stat"},
        "queries": {"q": {"signal": "events", "event": event, "measure": "count"}},
        "series": [{"expr": "q"}]
    })
}
fn board(name: &str, widgets: Vec<Value>) -> Value {
    json!({"version": 1, "name": name, "widgets": widgets})
}

#[tokio::test]
async fn a_fast_widget_saves_and_reports_its_bench() {
    let test = Test::new();
    let project = test.project("Shop").await;
    test.seed_events(&project, None, "page_view", 2).await;
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": document("Board")}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["revision"], 1);
    let bench = body["bench"].as_array().unwrap();
    assert_eq!(bench.len(), 1, "{body}");
    assert_eq!(bench[0]["widget"], "views");
    assert!(bench[0]["elapsed_ms"].as_u64().unwrap() < 1_000, "{body}");
    assert_eq!(body["warnings"], json!([]));
    test.close().await;
}

#[tokio::test]
async fn a_slow_sql_cross_join_is_refused_and_nothing_is_saved() {
    let test = Test::new();
    let project = test.project("Shop").await;
    bulk_events(&test, &project, "hit", 3_000);
    let mut slow = sql_widget(
        "stat",
        "SELECT count(*) AS value FROM events a, events b, events c, events d",
    );
    slow["timeout_ms"] = json!(1_000);
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": board("Slow", vec![views_widget("ok", "hit"), slow])}),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "too_slow", "{body}");
    assert_eq!(body["errors"][0]["path"], "/widgets/1", "{body}");
    // The widget's own 1 s timeout set this budget, so the hint says so.
    let hint = body["errors"][0]["hint"].as_str().unwrap();
    assert!(
        hint.contains("own timeout is 1 s") && hint.contains("`timeout_ms`"),
        "{hint}"
    );
    // With the default timeout the plain 3 s budget applies and the hint is the brief's text.
    let plain = sql_widget(
        "stat",
        "SELECT count(*) AS value FROM events a, events b, events c, events d",
    );
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": board("Slow", vec![plain])}),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "too_slow", "{body}");
    assert_eq!(
        body["errors"][0]["hint"],
        "This widget took over 3 s on the last 7 days of data. Narrow it with $from/$to (or a widget range), filter by event or service, or avoid unbounded joins."
    );
    let (_, list) = test
        .read(
            "GET",
            &format!("/api/read/products/{}/dashboards", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(list, json!([]));
    test.close().await;
}

#[tokio::test]
async fn unchanged_widgets_are_not_benched_again() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let first = board(
        "Board",
        vec![views_widget("a", "x"), views_widget("b", "y")],
    );
    let (status, created) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": first}),
        )
        .await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["bench"].as_array().unwrap().len(), 2);

    // Renaming the dashboard changes no widget.
    let renamed = board(
        "Renamed",
        vec![views_widget("a", "x"), views_widget("b", "y")],
    );
    let (status, body) = put(&test, &project, "board", 1, renamed, &[]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["bench"], json!([]));

    // Changing one widget benches only that one.
    let edited = board(
        "Renamed",
        vec![views_widget("a", "x"), views_widget("b", "z")],
    );
    let (status, body) = put(&test, &project, "board", 2, edited, &[]).await;
    assert_eq!(status, 200, "{body}");
    let bench = body["bench"].as_array().unwrap();
    assert_eq!(bench.len(), 1, "{body}");
    assert_eq!(bench[0]["widget"], "b");

    // Restoring revision 1 changes widget b back, and a is untouched.
    let (status, body) = test
        .manage(
            "POST",
            &format!("{}/board/revisions/1/restore", dashboards_path(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let bench = body["bench"].as_array().unwrap();
    assert_eq!(bench.len(), 1, "{body}");
    assert_eq!(bench[0]["widget"], "b");
    test.close().await;
}

#[tokio::test]
async fn the_thirty_first_write_in_a_minute_is_rate_limited() {
    let mut test = Test::new();
    test.state.write_limit = std::sync::Arc::new(piko::dashboards::limit::WriteLimit::default());
    let project = test.project("Shop").await;
    let other = test.project("Other").await;
    for n in 0..30 {
        create_dashboard(&test, &project, &format!("Board {n}")).await;
    }
    let (status, headers, body) = test
        .send_full(
            "POST",
            &dashboards_path(&project),
            json!({"document": document("One too many")}),
            &[("x-piko-admin", "1")],
        )
        .await;
    assert_eq!(status, 429, "{body}");
    assert_eq!(body["code"], "rate_limited");
    let wait: u64 = headers["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=60).contains(&wait), "{wait}");
    assert_eq!(
        body["errors"][0]["message"],
        "Too many dashboard writes for this project"
    );
    assert_eq!(body["errors"][0]["hint"], format!("Retry after {wait} s"));
    // Another project has its own allowance.
    create_dashboard(&test, &other, "Fine").await;
    test.close().await;
}

#[tokio::test]
async fn waiting_for_a_busy_gate_is_busy_not_too_slow() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let mut widget = views_widget("a", "x");
    widget["timeout_ms"] = json!(1_000);
    let held = test
        .state
        .store
        .dashboard_event_gate
        .clone()
        .acquire_many_owned(3)
        .await
        .unwrap();
    let (status, headers, body) = test
        .send_full(
            "POST",
            &dashboards_path(&project),
            json!({"document": board("Busy", vec![widget])}),
            &[("x-piko-admin", "1")],
        )
        .await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(body["code"], "busy", "{body}");
    assert_eq!(body["errors"][0]["path"], "/widgets/0");
    assert_eq!(
        body["errors"][0]["message"],
        "Piko was busy running other queries"
    );
    assert_eq!(body["errors"][0]["hint"], "Retry the save in a few seconds");
    assert!(headers.get("retry-after").is_some());
    drop(held);
    // Nothing was saved, and the same save works once the gate is free.
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": board("Busy", vec![views_widget("a", "x")])}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    test.close().await;
}

#[tokio::test]
async fn a_run_warning_reaches_a_successful_save_under_the_widget() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (status, body) = test
        .manage(
            "POST",
            &dashboards_path(&project),
            json!({"document": board("Warn", vec![views_widget("a", "never_seen")])}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let warnings = body["warnings"].as_array().unwrap();
    assert!(!warnings.is_empty(), "{body}");
    assert!(
        warnings
            .iter()
            .all(|w| w["path"].as_str().unwrap().starts_with("/widgets/0/")),
        "{body}"
    );
    test.close().await;
}

#[tokio::test]
async fn a_stale_put_conflicts_before_any_benchmark_runs() {
    let test = Test::new();
    let project = test.project("Shop").await;
    create_dashboard(&test, &project, "Board").await;
    // A benchmark would wait out this held gate for a second; a conflict answers at once.
    let held = test
        .state
        .store
        .dashboard_event_gate
        .clone()
        .acquire_many_owned(3)
        .await
        .unwrap();
    let mut changed = document("Board");
    changed["widgets"][0]["queries"]["views"]["event"] = json!("other");
    changed["widgets"][0]["timeout_ms"] = json!(5_000);
    let started = std::time::Instant::now();
    let (status, body) = put(&test, &project, "board", 7, changed, &[]).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "revision_conflict");
    assert_eq!(body["revision"], 1);
    assert!(body.get("bench").is_none());
    assert!(started.elapsed() < std::time::Duration::from_millis(900));
    drop(held);
    test.close().await;
}
