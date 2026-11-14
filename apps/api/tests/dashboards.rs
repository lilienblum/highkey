use axum::{
    Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use chrono::{DateTime, Duration, Utc};
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
        let state = AppState::open(&Config {
            data_dir: directory.path().into(),
            query_concurrency: 4,
            queue_capacity: 16,
        })
        .unwrap();
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
        let body = to_bytes(response.into_body(), 4 * 1024 * 1024)
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
        let (status, key) = self
            .manage(
                "POST",
                &format!("/api/products/{}/logs/keys", id(project)),
                json!({"label":"Seed"}),
            )
            .await;
        assert_eq!(status, 200, "{key}");
        let logs: Vec<Value> = (0..n)
            .map(|_| json!({"service":service,"level":level,"message":"Request finished"}))
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
    test.seed_events(&project, None, "checkout_request", 8)
        .await;
    test.seed_events(&project, None, "page_view", 3).await;
    test.seed_logs(&project, "checkout", "error", 1).await;
    test.seed_logs(&project, "checkout", "fatal", 1).await;
    test.seed_logs(&project, "checkout", "info", 5).await;
    test.seed_logs(&project, "search", "error", 4).await;

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
