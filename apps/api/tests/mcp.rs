//! The MCP server at `/api/mcp` (everything) and `/api/read/mcp` (read tools only), driven with
//! raw JSON-RPC through the router.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use piko::{AppState, Config, changes::Signal, dashboards::limit::WriteLimit, router};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;

const FULL: &str = "/api/mcp";
const READ: &str = "/api/read/mcp";

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
        // Most tests write far more than 30 times a minute; some pin their own limit.
        state.write_limit = Arc::new(WriteLimit::new(100_000, Duration::from_secs(60)));
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
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "piko.example")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
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
        let body = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        let text = || json!(String::from_utf8_lossy(&body));
        (
            status,
            serde_json::from_slice(&body).unwrap_or_else(|_| text()),
        )
    }
    async fn manage(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        self.send(method, path, body, &[("x-piko-admin", "1")])
            .await
    }
    async fn read(&self, path: &str) -> (StatusCode, Value) {
        self.send("GET", path, Value::Null, &[]).await
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
    /// The JSON-RPC response to one request on an MCP endpoint.
    async fn rpc(&self, path: &str, method: &str, params: Value) -> Value {
        let (status, body) = self
            .send(
                "POST",
                path,
                json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
                &[],
            )
            .await;
        assert_eq!(status, 200, "{method}: {body}");
        body
    }
    /// The MCP handshake an agent starts with.
    async fn initialize(&self, path: &str) -> Value {
        self.rpc(
            path,
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}),
        )
        .await["result"]
            .clone()
    }
    async fn tool_names(&self, path: &str) -> Vec<String> {
        self.initialize(path).await;
        let listed = self.rpc(path, "tools/list", json!({})).await;
        listed["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("{listed}"))
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }
    /// A tool call that must produce a tool result, as `(is_error, parsed JSON text)`.
    async fn tool_on(&self, path: &str, name: &str, arguments: Value) -> (bool, Value) {
        let response = self
            .rpc(
                path,
                "tools/call",
                json!({"name":name,"arguments":arguments}),
            )
            .await;
        let result = &response["result"];
        assert!(result.is_object(), "{name}: {response}");
        let text = result["content"][0]["text"].as_str().expect("text content");
        let value = serde_json::from_str(text).unwrap_or_else(|_| json!(text));
        (result["isError"].as_bool().unwrap_or(false), value)
    }
    async fn tool(&self, name: &str, arguments: Value) -> (bool, Value) {
        self.tool_on(FULL, name, arguments).await
    }
    /// A tool call that must succeed.
    async fn ok(&self, name: &str, arguments: Value) -> Value {
        let (is_error, value) = self.tool(name, arguments).await;
        assert!(!is_error, "{name} failed: {value}");
        value
    }
    /// A tool call that must fail as a tool error, as the error body.
    async fn fails(&self, name: &str, arguments: Value) -> Value {
        let (is_error, value) = self.tool(name, arguments).await;
        assert!(is_error, "{name} should fail: {value}");
        value
    }
    async fn seed_events(&self, project: &Value, name: &str, n: usize) {
        let events: Vec<Value> = (0..n)
            .map(|i| {
                json!({"event_id": uuid::Uuid::now_v7().to_string(), "source": "web", "name": name,
                       "properties": {"n": i, "plan": "pro"}})
            })
            .collect();
        let (status, key) = self
            .manage(
                "POST",
                &format!("/api/products/{}/keys", id(project)),
                json!({"label":"Seed"}),
            )
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
            .map(|i| json!({"service":service,"level":level,"message":format!("Request {i} finished")}))
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
    async fn close(self) {
        self.state.log_writer.stop().await;
        self.state.writer.stop().await;
    }
}
fn id(project: &Value) -> &str {
    project["id"].as_str().unwrap()
}
fn document(name: &str) -> Value {
    json!({
        "version": 1,
        "name": name,
        "widgets": [{
            "id": "requests", "title": "Requests", "view": {"type": "stat"},
            "queries": {"requests": {"signal": "events", "event": "checkout_request"}}
        }]
    })
}
fn event_view(name: &str) -> Value {
    json!({"version":1,"name":name,"query":{"event":"signup","measure":"count"}})
}
fn log_view(name: &str) -> Value {
    json!({"version":1,"kind":"logs","name":name,"query":{"min_level":"error"},"window":"1h"})
}
fn hint(body: &Value) -> &str {
    body["errors"][0]["hint"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn read_path_lists_only_read_tools() {
    let test = Test::new();
    let read = test.tool_names(READ).await;
    for name in [
        "list_projects",
        "describe_project",
        "run_widget",
        "sample_events",
        "sample_logs",
        "list_dashboards",
        "get_dashboard",
        "list_revisions",
        "validate_dashboard",
        "list_views",
        "get_view",
    ] {
        assert!(read.contains(&name.to_string()), "{name} in {read:?}");
    }
    for name in [
        "save_dashboard",
        "restore_revision",
        "delete_dashboard",
        "save_view",
        "delete_view",
    ] {
        assert!(!read.contains(&name.to_string()), "{name} in {read:?}");
    }
    let full = test.tool_names(FULL).await;
    for name in [
        "save_dashboard",
        "restore_revision",
        "delete_dashboard",
        "save_view",
        "delete_view",
    ] {
        assert!(full.contains(&name.to_string()), "{name} in {full:?}");
    }
    assert!(full.len() > read.len());
    test.close().await;
}

#[tokio::test]
async fn the_server_says_how_to_use_it() {
    let test = Test::new();
    let info = test.initialize(FULL).await;
    let instructions = info["instructions"].as_str().unwrap();
    assert!(instructions.starts_with(
        "Piko builds dashboards and saved views from typed queries over a project's events and logs. Call describe_project first"
    ));
    assert!(instructions.contains("Saved dashboards appear under Overview in Piko's sidebar, and saved views under Events or Logs."));
    assert!(info["capabilities"]["tools"].is_object());
    assert!(info["capabilities"]["resources"].is_object());
    assert!(info["capabilities"]["prompts"].is_object());
    test.close().await;
}

#[tokio::test]
async fn describe_run_validate_and_save_round_trip() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    test.seed_events(&project, "checkout_request", 4).await;
    let mut changes = test.state.store.changes.subscribe();

    let described = test
        .ok("describe_project", json!({"project": "orbit"}))
        .await;
    assert_eq!(described["project"]["id"], project["id"]);
    assert_eq!(described["events"]["names"], json!(["checkout_request"]));
    assert!(described["sql"]["events"].is_array());
    assert!(described["sql"]["parameters"].is_array());
    assert_eq!(described["limits"]["max_widgets"], 24);

    let listed = test.ok("list_projects", json!({})).await;
    assert_eq!(listed[0]["slug"], "orbit");
    assert_eq!(listed[0]["id"], project["id"]);
    assert_eq!(listed[0]["name"], "Orbit");
    assert_eq!(listed[0]["retention_days"], 365);

    let widget = document("x")["widgets"][0].clone();
    let run = test
        .ok("run_widget", json!({"project": "orbit", "widget": widget}))
        .await;
    assert_eq!(run["series"][0]["total"], 4.0, "{run}");
    assert!(run["elapsed_ms"].is_u64());
    assert_eq!(run["range"]["clamped"], false);

    let validated = test
        .ok(
            "validate_dashboard",
            json!({"project": "orbit", "document": document("Orbit overview")}),
        )
        .await;
    assert_eq!(validated["valid"], true);
    assert_eq!(validated["errors"], json!([]));

    let saved = test
        .ok(
            "save_dashboard",
            json!({"project": "orbit", "document": document("Orbit overview")}),
        )
        .await;
    assert_eq!(saved["slug"], "orbit-overview");
    assert_eq!(saved["revision"], 1);
    assert!(saved["id"].is_string());
    assert!(saved["warnings"].is_array());
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint arrives")
        .unwrap();
    assert_eq!(seen, (id(&project).to_string(), Signal::Dashboards));

    let got = test
        .ok(
            "get_dashboard",
            json!({"project": "orbit", "dashboard": "orbit-overview"}),
        )
        .await;
    assert_eq!(got["revision"], 1);
    assert_eq!(got["document"]["name"], "Orbit overview");
    let (status, over_http) = test
        .read("/api/read/products/orbit/dashboards/orbit-overview")
        .await;
    assert_eq!(status, 200, "{over_http}");
    assert_eq!(over_http["document"], got["document"]);

    let all = test
        .ok("list_dashboards", json!({"project": "orbit"}))
        .await;
    assert_eq!(all[0]["slug"], "orbit-overview");

    // An update names the revision it was based on; a restore is the undo.
    let mut changed = document("Orbit overview");
    changed["widgets"][0]["title"] = json!("Checkout requests");
    let updated = test
        .ok(
            "save_dashboard",
            json!({"project": "orbit", "dashboard": "orbit-overview", "document": changed, "base_revision": 1}),
        )
        .await;
    assert_eq!(updated["revision"], 2);
    let restored = test
        .ok(
            "restore_revision",
            json!({"project": "orbit", "dashboard": "orbit-overview", "revision": 1}),
        )
        .await;
    assert_eq!(restored["revision"], 3);
    let now = test
        .ok(
            "get_dashboard",
            json!({"project": "orbit", "dashboard": "orbit-overview"}),
        )
        .await;
    assert_eq!(now["revision"], 3);
    assert_eq!(now["document"]["widgets"][0]["title"], "Requests");
    let revisions = test
        .ok(
            "list_revisions",
            json!({"project": "orbit", "dashboard": "orbit-overview"}),
        )
        .await;
    let revisions = revisions.as_array().unwrap();
    assert_eq!(revisions.len(), 3);
    assert!(
        revisions.iter().all(|r| r["origin"] == "mcp"),
        "{revisions:?}"
    );
    test.close().await;
}

#[tokio::test]
async fn a_stale_base_revision_is_a_readable_conflict() {
    let test = Test::new();
    test.project("Orbit").await;
    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "document": document("Board")}),
    )
    .await;
    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "dashboard": "board", "document": document("Board"), "base_revision": 1}),
    )
    .await;
    let body = test
        .fails(
            "save_dashboard",
            json!({"project": "orbit", "dashboard": "board", "document": document("Board"), "base_revision": 1}),
        )
        .await;
    assert_eq!(body["code"], "revision_conflict");
    assert_eq!(body["revision"], 2);
    test.close().await;
}

#[tokio::test]
async fn save_on_read_path_is_not_a_tool() {
    let test = Test::new();
    test.project("Orbit").await;
    test.initialize(READ).await;
    for name in ["save_dashboard", "delete_view", "restore_revision"] {
        let response = test
            .rpc(
                READ,
                "tools/call",
                json!({"name":name,"arguments":{"project":"orbit","document":document("Nope")}}),
            )
            .await;
        assert!(response["error"].is_object(), "{name}: {response}");
        assert!(response.get("result").is_none(), "{name}: {response}");
    }
    let (_, list) = test.read("/api/read/products/orbit/dashboards").await;
    assert_eq!(list, json!([]));
    test.close().await;
}

#[tokio::test]
async fn unknown_tools_are_json_rpc_errors_and_malformed_arguments_say_what_is_missing() {
    let test = Test::new();
    test.initialize(FULL).await;
    let response = test
        .rpc(
            FULL,
            "tools/call",
            json!({"name":"no_such_tool","arguments":{}}),
        )
        .await;
    assert!(response["error"].is_object(), "{response}");
    // rmcp reports arguments that do not deserialize as a tool error the agent can read.
    let (is_error, text) = test.tool("describe_project", json!({})).await;
    assert!(is_error);
    assert!(
        text.as_str().unwrap().contains("missing field `project`"),
        "{text}"
    );
    test.close().await;
}

#[tokio::test]
async fn browser_origins_are_rejected() {
    let test = Test::new();
    for path in [FULL, READ] {
        let (status, _) = test
            .send(
                "POST",
                path,
                json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}),
                &[("origin", "https://evil.example")],
            )
            .await;
        assert_eq!(status, 403, "{path}");
    }
    test.close().await;
}

#[tokio::test]
async fn invalid_document_is_a_readable_tool_error() {
    let test = Test::new();
    test.project("Orbit").await;
    let mut bad = document("Bad");
    bad["widgets"][0]["series"] = json!([{"expr": "requets"}]);
    let validated = test
        .ok(
            "validate_dashboard",
            json!({"project": "orbit", "document": bad}),
        )
        .await;
    assert_eq!(validated["valid"], false);
    assert_eq!(validated["errors"][0]["path"], "/widgets/0/series/0/expr");

    for tool in ["save_dashboard"] {
        let body = test
            .fails(tool, json!({"project": "orbit", "document": bad}))
            .await;
        assert_eq!(body["code"], "invalid_document", "{body}");
        assert_eq!(body["errors"][0]["path"], "/widgets/0/series/0/expr");
        assert!(
            body["errors"][0]["message"]
                .as_str()
                .unwrap()
                .contains("did you mean `requests`"),
            "{body}"
        );
    }
    let (_, list) = test.read("/api/read/products/orbit/dashboards").await;
    assert_eq!(list, json!([]));
    test.close().await;
}

#[tokio::test]
async fn resources_and_prompt_are_listed() {
    let test = Test::new();
    test.initialize(FULL).await;
    let listed = test.rpc(FULL, "resources/list", json!({})).await;
    let resources = listed["result"]["resources"].as_array().unwrap();
    let uris: Vec<&str> = resources
        .iter()
        .map(|r| r["uri"].as_str().unwrap())
        .collect();
    assert!(uris.contains(&"piko://schema/dashboard.v1"), "{uris:?}");
    assert!(uris.contains(&"piko://docs/dashboards"), "{uris:?}");

    let schema = test
        .rpc(
            FULL,
            "resources/read",
            json!({"uri":"piko://schema/dashboard.v1"}),
        )
        .await;
    let contents = &schema["result"]["contents"][0];
    assert_eq!(contents["mimeType"], "application/json");
    let parsed: Value = serde_json::from_str(contents["text"].as_str().unwrap()).unwrap();
    assert_eq!(parsed, piko::dashboards::spec::schema());

    let guide = test
        .rpc(
            FULL,
            "resources/read",
            json!({"uri":"piko://docs/dashboards"}),
        )
        .await;
    let contents = &guide["result"]["contents"][0];
    assert_eq!(contents["mimeType"], "text/markdown");
    assert!(
        contents["text"]
            .as_str()
            .unwrap()
            .contains("describe_project")
    );

    let prompts = test.rpc(FULL, "prompts/list", json!({})).await;
    assert_eq!(prompts["result"]["prompts"][0]["name"], "build_dashboard");
    let prompt = test
        .rpc(
            FULL,
            "prompts/get",
            json!({"name":"build_dashboard","arguments":{"goal":"Track checkout errors"}}),
        )
        .await;
    let message = &prompt["result"]["messages"][0];
    assert_eq!(message["role"], "user");
    let text = message["content"]["text"].as_str().unwrap();
    assert!(text.contains("Track checkout errors"));
    for step in [
        "describe_project",
        "run_widget",
        "validate_dashboard",
        "save_dashboard",
    ] {
        assert!(text.contains(step), "{step} in {text}");
    }
    test.close().await;
}

#[tokio::test]
async fn mcp_writes_share_the_write_limit() {
    let mut test = Test::new();
    let project = test.project("Orbit").await;
    test.state.write_limit = Arc::new(WriteLimit::new(2, Duration::from_secs(60)));
    // One write over HTTP and one over MCP use the same project allowance.
    let (status, body) = test
        .manage(
            "POST",
            &format!("/api/products/{}/dashboards", id(&project)),
            json!({"document": document("One")}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "document": document("Two")}),
    )
    .await;
    let body = test
        .fails(
            "save_dashboard",
            json!({"project": "orbit", "document": document("Three")}),
        )
        .await;
    assert_eq!(body["code"], "rate_limited", "{body}");
    let wait = body["retry_after_secs"].as_u64().unwrap();
    assert!((1..=60).contains(&wait), "{body}");
    // The limit counts view writes too.
    let body = test
        .fails(
            "save_view",
            json!({"project": "orbit", "document": event_view("Four")}),
        )
        .await;
    assert_eq!(body["code"], "rate_limited", "{body}");
    test.close().await;
}

#[tokio::test]
async fn delete_dashboard_requires_matching_confirm() {
    let test = Test::new();
    test.project("Orbit").await;
    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "document": document("Old board")}),
    )
    .await;
    for confirm in [json!("wrong"), json!("Old board"), json!("")] {
        let body = test
            .fails(
                "delete_dashboard",
                json!({"project": "orbit", "dashboard": "old-board", "confirm": confirm}),
            )
            .await;
        assert_eq!(body["errors"][0]["path"], "confirm", "{body}");
        assert!(hint(&body).contains("old-board"), "{body}");
    }
    let (_, list) = test.read("/api/read/products/orbit/dashboards").await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let mut changes = test.state.store.changes.subscribe();
    let done = test
        .ok(
            "delete_dashboard",
            json!({"project": "orbit", "dashboard": "old-board", "confirm": "old-board"}),
        )
        .await;
    assert_eq!(done["deleted"], "old-board");
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint arrives")
        .unwrap();
    assert_eq!(seen.1, Signal::Dashboards);
    let (_, list) = test.read("/api/read/products/orbit/dashboards").await;
    assert_eq!(list, json!([]));
    test.close().await;
}

#[tokio::test]
async fn delete_view_requires_matching_confirm() {
    let test = Test::new();
    test.project("Orbit").await;
    test.ok(
        "save_view",
        json!({"project": "orbit", "document": event_view("Signups")}),
    )
    .await;
    let body = test
        .fails(
            "delete_view",
            json!({"project": "orbit", "view": "signups", "confirm": "nope"}),
        )
        .await;
    assert_eq!(body["errors"][0]["path"], "confirm", "{body}");
    assert!(hint(&body).contains("signups"), "{body}");
    assert_eq!(
        test.ok("list_views", json!({"project": "orbit"}))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let done = test
        .ok(
            "delete_view",
            json!({"project": "orbit", "view": "signups", "confirm": "signups"}),
        )
        .await;
    assert_eq!(done["deleted"], "signups");
    assert_eq!(
        test.ok("list_views", json!({"project": "orbit"})).await,
        json!([])
    );
    test.close().await;
}

#[tokio::test]
async fn views_round_trip_over_mcp() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    let mut changes = test.state.store.changes.subscribe();
    let events = test
        .ok(
            "save_view",
            json!({"project": "orbit", "document": event_view("Checkout")}),
        )
        .await;
    assert_eq!(events["slug"], "checkout");
    assert_eq!(events["kind"], "events");
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint arrives")
        .unwrap();
    assert_eq!(seen, (id(&project).to_string(), Signal::Dashboards));
    let logs = test
        .ok(
            "save_view",
            json!({"project": "orbit", "document": log_view("Checkout")}),
        )
        .await;
    assert_eq!(logs["slug"], "checkout");
    assert_eq!(logs["kind"], "logs");

    let all = test.ok("list_views", json!({"project": "orbit"})).await;
    assert_eq!(all.as_array().unwrap().len(), 2);
    let only_logs = test
        .ok("list_views", json!({"project": "orbit", "kind": "logs"}))
        .await;
    assert_eq!(only_logs.as_array().unwrap().len(), 1);
    assert_eq!(only_logs[0]["kind"], "logs");

    let got = test
        .ok(
            "get_view",
            json!({"project": "orbit", "view": "checkout", "kind": "logs"}),
        )
        .await;
    assert_eq!(got["id"], logs["id"]);
    // The same slug in both kinds needs a kind.
    for (tool, args) in [
        ("get_view", json!({"project": "orbit", "view": "checkout"})),
        (
            "delete_view",
            json!({"project": "orbit", "view": "checkout", "confirm": "checkout"}),
        ),
        (
            "save_view",
            json!({"project": "orbit", "view": "checkout", "document": event_view("Checkout")}),
        ),
    ] {
        let body = test.fails(tool, args).await;
        assert_eq!(body["code"], "ambiguous_view", "{tool}: {body}");
        if tool == "save_view" {
            // `save_view` has no `kind` argument; the document names it.
            assert!(hint(&body).contains("in the document"), "{body}");
            continue;
        }
        assert!(
            hint(&body).contains("events") && hint(&body).contains("logs"),
            "{body}"
        );
    }

    // A document that names its kind replaces that view.
    let mut changed = event_view("Checkout, changed");
    changed["kind"] = json!("events");
    let replaced = test
        .ok(
            "save_view",
            json!({"project": "orbit", "view": "checkout", "document": changed}),
        )
        .await;
    assert_eq!(replaced["id"], events["id"]);
    assert_eq!(replaced["slug"], "checkout");
    assert_eq!(replaced["document"]["name"], "Checkout, changed");

    let done = test
        .ok(
            "delete_view",
            json!({"project": "orbit", "view": "checkout", "kind": "events", "confirm": "checkout"}),
        )
        .await;
    assert_eq!(done["deleted"], "checkout");
    let left = test.ok("list_views", json!({"project": "orbit"})).await;
    assert_eq!(left.as_array().unwrap().len(), 1);
    assert_eq!(left[0]["kind"], "logs");
    // With one left, the slug is no longer ambiguous.
    let got = test
        .ok("get_view", json!({"project": "orbit", "view": "checkout"}))
        .await;
    assert_eq!(got["kind"], "logs");
    test.close().await;
}

#[tokio::test]
async fn invalid_view_documents_are_readable_tool_errors() {
    let test = Test::new();
    test.project("Orbit").await;
    let mut bad = event_view("Bad");
    bad["query"]["measure"] = json!("sum");
    let body = test
        .fails("save_view", json!({"project": "orbit", "document": bad}))
        .await;
    assert_eq!(body["error"], "Invalid view document");
    assert_eq!(body["errors"][0]["path"], "/query/property");
    test.close().await;
}

#[tokio::test]
async fn unknown_project_gets_a_nearest_match_hint() {
    let test = Test::new();
    test.project("Orbit").await;
    test.project("Pulse").await;
    let body = test
        .fails("describe_project", json!({"project": "orbt"}))
        .await;
    assert_eq!(body["code"], "not_found", "{body}");
    assert_eq!(body["errors"][0]["path"], "project");
    assert_eq!(hint(&body), "did you mean `orbit`?");

    // Nothing close lists what exists.
    let body = test
        .fails("list_dashboards", json!({"project": "zzzzzzzz"}))
        .await;
    assert_eq!(body["code"], "not_found");
    assert_eq!(hint(&body), "Existing projects: orbit, pulse");

    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "document": document("Checkout")}),
    )
    .await;
    test.ok(
        "save_view",
        json!({"project": "orbit", "document": event_view("Signups")}),
    )
    .await;
    let body = test
        .fails(
            "get_dashboard",
            json!({"project": "orbit", "dashboard": "chekout"}),
        )
        .await;
    assert_eq!(body["code"], "not_found");
    assert_eq!(hint(&body), "did you mean `checkout`?");
    let body = test
        .fails("get_view", json!({"project": "orbit", "view": "signop"}))
        .await;
    assert_eq!(body["code"], "not_found");
    assert_eq!(hint(&body), "did you mean `signups`?");
    let body = test
        .fails(
            "save_dashboard",
            json!({"project": "orbit", "dashboard": "chekout", "document": document("Checkout"), "base_revision": 1}),
        )
        .await;
    assert_eq!(body["code"], "not_found");
    test.close().await;
}

#[tokio::test]
async fn unknown_events_and_properties_warn_with_a_suggestion() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    test.seed_events(&project, "checkout_request", 2).await;
    let mut doc = document("Typos");
    doc["widgets"][0]["queries"]["requests"]["event"] = json!("checkout_requset");
    doc["widgets"][0]["queries"]["requests"]["filters"] =
        json!([{"property": "pln", "op": "eq", "value": "pro"}]);
    let validated = test
        .ok(
            "validate_dashboard",
            json!({"project": "orbit", "document": doc}),
        )
        .await;
    assert_eq!(validated["valid"], true, "{validated}");
    let warnings = validated["warnings"].as_array().unwrap();
    let hints: Vec<&str> = warnings.iter().filter_map(|w| w["hint"].as_str()).collect();
    assert!(
        hints
            .iter()
            .any(|h| h.contains("did you mean `checkout_request`?")),
        "{hints:?}"
    );
    assert!(
        hints.iter().any(|h| h.contains("did you mean `plan`?")),
        "{hints:?}"
    );

    // The HTTP endpoint shares the function.
    let (status, body) = test
        .read_post(
            "/api/read/products/orbit/dashboards/validate",
            json!({"document": doc}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body["warnings"][0]["hint"]
            .as_str()
            .unwrap()
            .contains("did you mean")
    );

    // Running the widget says the same about the event name.
    let run = test
        .ok(
            "run_widget",
            json!({"project": "orbit", "widget": doc["widgets"][0]}),
        )
        .await;
    assert!(
        run["warnings"]
            .to_string()
            .contains("did you mean `checkout_request`?"),
        "{run}"
    );
    test.close().await;
}

#[tokio::test]
async fn sql_widget_runs_over_mcp() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    test.seed_events(&project, "checkout_request", 3).await;
    test.seed_events(&project, "signup", 1).await;
    let widget = json!({
        "id": "by-name", "title": "Events by name", "view": {"type": "table"},
        "queries": {"q": {"signal": "sql", "database": "events",
            "sql": "SELECT name, count(*) AS events FROM events WHERE event_time >= $from AND event_time < $to GROUP BY name ORDER BY events DESC"}}
    });
    let run = test
        .ok(
            "run_widget",
            json!({"project": "orbit", "widget": widget.clone()}),
        )
        .await;
    assert_eq!(run["columns"][0]["name"], "name", "{run}");
    assert_eq!(run["rows"][0], json!(["checkout_request", 3]), "{run}");
    assert_eq!(run["rows"][1], json!(["signup", 1]));

    // A write is refused with a path and a hint, not run.
    let mut bad = widget;
    bad["queries"]["q"]["sql"] = json!("DELETE FROM events");
    let body = test
        .fails("run_widget", json!({"project": "orbit", "widget": bad}))
        .await;
    assert_eq!(body["code"], "invalid_document", "{body}");
    assert_eq!(body["errors"][0]["path"], "/queries/q/sql");
    test.close().await;
}

#[tokio::test]
async fn run_widget_keeps_the_first_fifty_table_rows() {
    let test = Test::new();
    test.project("Orbit").await;
    let widget = json!({
        "id": "numbers", "title": "Numbers", "view": {"type": "table"},
        "queries": {"q": {"signal": "sql", "database": "events",
            "sql": "SELECT i, i * 2 AS twice FROM range(120) t(i) WHERE $from < $to ORDER BY i"}}
    });
    let run = test
        .ok("run_widget", json!({"project": "orbit", "widget": widget}))
        .await;
    let rows = run["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 50, "{run}");
    assert_eq!(rows[0], json!([0, 0]));
    assert_eq!(rows[49], json!([49, 98]));
    assert!(
        run["warnings"].as_array().unwrap().contains(&json!({
            "path": "/rows",
            "message": "Showing the first 50 of 120 rows",
            "hint": "Add a LIMIT, aggregate, or narrow from and to to see the rest; saved widgets show up to 10,000 rows",
        })),
        "{run}"
    );
    // A short result is returned whole, without a warning.
    let mut short = widget;
    short["queries"]["q"]["sql"] = json!("SELECT i FROM range(3) t(i) WHERE $from < $to");
    let run = test
        .ok("run_widget", json!({"project": "orbit", "widget": short}))
        .await;
    assert_eq!(run["rows"].as_array().unwrap().len(), 3, "{run}");
    assert!(
        !run["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["path"] == "/rows"),
        "{run}"
    );
    test.close().await;
}

#[tokio::test]
async fn run_widget_takes_a_range_and_trims_long_series() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    test.seed_events(&project, "checkout_request", 2).await;
    let widget = json!({
        "id": "hourly", "title": "Hourly", "view": {"type": "line", "bucket": "hour"},
        "queries": {"requests": {"signal": "events", "event": "checkout_request"}}
    });
    let to = chrono::Utc::now() + chrono::Duration::minutes(1);
    let from = to - chrono::Duration::days(14);
    let run = test
        .ok(
            "run_widget",
            json!({"project": "orbit", "widget": widget, "from": from.to_rfc3339(), "to": to.to_rfc3339()}),
        )
        .await;
    assert_eq!(
        run["series"][0]["points"].as_array().unwrap().len(),
        200,
        "{run}"
    );
    assert_eq!(
        run["series"][0]["previous_points"]
            .as_array()
            .unwrap()
            .len(),
        200
    );
    let warnings = run["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w["message"].as_str().unwrap().contains("newest 200")),
        "{warnings:?}"
    );
    // The newest points are the ones kept, so the last one is still the current hour.
    let last = run["series"][0]["points"][199]["time"].as_i64().unwrap();
    assert!((to.timestamp_millis() - last).abs() < 2 * 3_600_000);

    let body = test
        .fails(
            "run_widget",
            json!({"project": "orbit", "widget": document("x")["widgets"][0], "from": "yesterday"}),
        )
        .await;
    assert_eq!(body["errors"][0]["path"], "from", "{body}");
    test.close().await;
}

#[tokio::test]
async fn samples_show_at_most_twenty_recent_rows() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    test.seed_events(&project, "checkout_request", 25).await;
    test.seed_events(&project, "signup", 2).await;
    test.seed_logs(&project, "checkout", "error", 22).await;
    test.seed_logs(&project, "search", "info", 3).await;

    let all = test.ok("sample_events", json!({"project": "orbit"})).await;
    assert_eq!(all["rows"].as_array().unwrap().len(), 20, "{all}");
    assert_eq!(all["rows"][0]["properties"]["plan"], "pro");
    let named = test
        .ok(
            "sample_events",
            json!({"project": "orbit", "event": "signup", "limit": 5}),
        )
        .await;
    assert_eq!(named["rows"].as_array().unwrap().len(), 2);
    assert!(
        named["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["name"] == "signup")
    );
    let few = test
        .ok("sample_events", json!({"project": "orbit", "limit": 3}))
        .await;
    assert_eq!(few["rows"].as_array().unwrap().len(), 3);
    let many = test
        .ok("sample_events", json!({"project": "orbit", "limit": 200}))
        .await;
    assert_eq!(many["rows"].as_array().unwrap().len(), 20);

    let logs = test.ok("sample_logs", json!({"project": "orbit"})).await;
    assert_eq!(logs["rows"].as_array().unwrap().len(), 20, "{logs}");
    let search = test
        .ok(
            "sample_logs",
            json!({"project": "orbit", "service": "search"}),
        )
        .await;
    assert_eq!(search["rows"].as_array().unwrap().len(), 3);
    let level = test
        .ok(
            "sample_logs",
            json!({"project": "orbit", "level": "error", "search": "Request 1"}),
        )
        .await;
    assert!(!level["rows"].as_array().unwrap().is_empty(), "{level}");
    test.close().await;
}

/// The guide's `json document` and `json view` examples must be valid as written.
#[tokio::test]
async fn the_guides_examples_pass_validation() {
    let guide = include_str!("../src/dashboards/guide.md");
    let mut documents = Vec::new();
    let mut views = Vec::new();
    let mut lines = guide.lines();
    while let Some(line) = lines.next() {
        let tag = line.trim_start_matches('`');
        if !line.starts_with("```") || !(tag == "json document" || tag == "json view") {
            continue;
        }
        let mut block = String::new();
        for line in lines.by_ref() {
            if line.starts_with("```") {
                break;
            }
            block.push_str(line);
            block.push('\n');
        }
        let value: Value = serde_json::from_str(&block)
            .unwrap_or_else(|e| panic!("the guide has invalid JSON ({e}):\n{block}"));
        if tag == "json document" {
            documents.push(value);
        } else {
            views.push(value);
        }
    }
    assert!(
        documents.len() >= 3,
        "{} document examples",
        documents.len()
    );
    assert!(!views.is_empty(), "a view example");

    let test = Test::new();
    test.project("Orbit").await;
    for document in documents {
        let validated = test
            .ok(
                "validate_dashboard",
                json!({"project": "orbit", "document": document}),
            )
            .await;
        assert_eq!(validated["valid"], true, "{document}: {validated}");
        // Valid is not enough: it has to save, which also benchmarks it.
        test.ok(
            "save_dashboard",
            json!({"project": "orbit", "document": document}),
        )
        .await;
    }
    for view in views {
        test.ok("save_view", json!({"project": "orbit", "document": view}))
            .await;
    }
    test.close().await;
}

impl Test {
    async fn read_post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.send("POST", path, body, &[]).await
    }
}

#[tokio::test]
async fn updating_a_dashboard_requires_base_revision() {
    let test = Test::new();
    test.project("Orbit").await;
    test.ok(
        "save_dashboard",
        json!({"project": "orbit", "document": document("Board")}),
    )
    .await;
    let body = test
        .fails(
            "save_dashboard",
            json!({"project": "orbit", "dashboard": "board", "document": document("Board")}),
        )
        .await;
    assert_eq!(body["code"], "invalid_argument", "{body}");
    assert_eq!(body["errors"][0]["path"], "/base_revision");
    assert!(hint(&body).contains("get_dashboard"), "{body}");
    let got = test
        .ok(
            "get_dashboard",
            json!({"project": "orbit", "dashboard": "board"}),
        )
        .await;
    assert_eq!(got["revision"], 1);
    test.close().await;
}

const WORKSPACE_WRITES: [&str; 13] = [
    "create_project",
    "update_project",
    "create_source",
    "update_source",
    "connect_source",
    "list_keys",
    "create_key",
    "update_key_origins",
    "revoke_key",
    "list_log_keys",
    "create_log_key",
    "revoke_log_key",
    "update_log_settings",
];

#[tokio::test]
async fn read_path_hides_management_writes() {
    let test = Test::new();
    let read = test.tool_names(READ).await;
    for name in ["list_sources", "get_log_settings"] {
        assert!(read.contains(&name.to_string()), "{name} in {read:?}");
    }
    for name in WORKSPACE_WRITES {
        assert!(!read.contains(&name.to_string()), "{name} in {read:?}");
    }
    let full = test.tool_names(FULL).await;
    for name in WORKSPACE_WRITES
        .into_iter()
        .chain(["list_sources", "get_log_settings"])
    {
        assert!(full.contains(&name.to_string()), "{name} in {full:?}");
    }
    let info = test.initialize(FULL).await;
    assert!(info["instructions"].as_str().unwrap().contains(
        "tools that revoke keys or delete need a confirm argument equal to the id or slug."
    ));
    test.close().await;
}

#[tokio::test]
async fn connect_source_returns_a_working_key() {
    let test = Test::new();
    test.project("Orbit").await;
    let connected = test
        .ok(
            "connect_source",
            json!({"project":"orbit","name":"Marketing site","icon":"website"}),
        )
        .await;
    assert_eq!(connected["source"]["slug"], "marketing-site");
    assert_eq!(connected["key"]["prefix"].as_str().unwrap().len(), 11);
    let secret = connected["key"]["secret"].as_str().unwrap().to_string();
    assert!(secret.starts_with("pk_"));
    let setup = &connected["setup"];
    assert!(setup["instructions"].as_str().unwrap().contains(
        "Replace PIKO_URL with the origin of the Piko URL this MCP server is reached at. The secret is shown only once."
    ));
    assert_eq!(setup["logs"], "For logs, call create_log_key.");
    for integration in ["browser", "typescript", "http", "rust"] {
        let snippet = setup["snippets"][integration].as_str().unwrap();
        assert!(snippet.contains(&secret), "{integration}: {snippet}");
        assert!(snippet.contains("PIKO_URL"), "{integration}: {snippet}");
    }
    let one = test
        .ok(
            "connect_source",
            json!({"project":"orbit","name":"CLI","integration":"rust","label":"Release CLI"}),
        )
        .await;
    assert_eq!(one["setup"]["snippets"].as_object().unwrap().len(), 1);
    assert!(one["setup"]["snippets"]["rust"].is_string());
    let keys = test.ok("list_keys", json!({"project":"orbit"})).await;
    assert!(
        keys.as_array()
            .unwrap()
            .iter()
            .any(|k| k["label"] == "Release CLI")
    );
    assert!(
        keys.as_array()
            .unwrap()
            .iter()
            .any(|k| k["label"] == "Marketing site")
    );

    let (status, ack) = test
        .send(
            "POST",
            "/api/ingest",
            json!({"event_id": uuid::Uuid::now_v7().to_string(), "name":"signup", "source":"web"}),
            &[("authorization", &format!("Bearer {secret}"))],
        )
        .await;
    assert_eq!(status, 200, "{ack}");
    assert_eq!(ack["accepted"], 1);
    let sources = test.ok("list_sources", json!({"project":"orbit"})).await;
    assert!(
        sources
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == connected["source"]["id"] && s["name"] == "Marketing site")
    );

    let bad = test
        .fails(
            "connect_source",
            json!({"project":"orbit","name":"Broken","allowed_origins":["not a url"]}),
        )
        .await;
    assert_eq!(bad["errors"][0]["path"], "/allowed_origins", "{bad}");
    let sources = test.ok("list_sources", json!({"project":"orbit"})).await;
    assert!(
        !sources
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "Broken"),
        "a failed connect leaves no source behind"
    );
    test.close().await;
}

#[tokio::test]
async fn update_project_changes_only_given_fields() {
    let test = Test::new();
    let created = test
        .ok(
            "create_project",
            json!({"name":"Orbit","website_url":"https://orbit.example","retention_days":30}),
        )
        .await;
    assert_eq!(created["slug"], "orbit");
    assert_eq!(created["retention_days"], 30);
    assert_eq!(created["sources"][0]["slug"], "events");
    let defaulted = test.ok("create_project", json!({"name":"Plain"})).await;
    assert_eq!(defaulted["retention_days"], 365);

    let renamed = test
        .ok(
            "update_project",
            json!({"project":"orbit","name":"Orbit 2"}),
        )
        .await;
    assert_eq!(renamed["name"], "Orbit 2");
    assert_eq!(renamed["retention_days"], 30);
    assert_eq!(renamed["website_url"], "https://orbit.example");
    assert_eq!(renamed["slug"], "orbit");

    let retained = test
        .ok(
            "update_project",
            json!({"project":created["id"],"retention_days":60}),
        )
        .await;
    assert_eq!(retained["name"], "Orbit 2");
    assert_eq!(retained["retention_days"], 60);
    assert_eq!(retained["website_url"], "https://orbit.example");

    let cleared = test
        .ok(
            "update_project",
            json!({"project":"orbit","website_url":""}),
        )
        .await;
    assert_eq!(cleared["website_url"], Value::Null);
    assert_eq!(cleared["name"], "Orbit 2");

    let bad = test
        .fails(
            "update_project",
            json!({"project":"orbit","retention_days":0}),
        )
        .await;
    assert_eq!(bad["code"], "invalid_input", "{bad}");
    assert_eq!(bad["errors"][0]["path"], "/retention_days");
    assert!(hint(&bad).contains("3650"), "{bad}");
    let bad = test
        .fails(
            "update_project",
            json!({"project":"orbit","website_url":"ftp://x"}),
        )
        .await;
    assert_eq!(bad["errors"][0]["path"], "/website_url", "{bad}");
    let missing = test
        .fails("update_project", json!({"project":"orbt","name":"x"}))
        .await;
    assert_eq!(missing["code"], "not_found");
    test.close().await;
}

#[tokio::test]
async fn revoke_key_requires_matching_confirm() {
    let test = Test::new();
    test.project("Orbit").await;
    let key = test
        .ok(
            "create_key",
            json!({"project":"orbit","label":"Web","allowed_origins":["https://orbit.example"]}),
        )
        .await;
    let key_id = key["id"].as_str().unwrap().to_string();
    assert!(key["key"].as_str().unwrap().starts_with("pk_"));
    assert_eq!(key["allowed_origins"], json!(["https://orbit.example"]));

    let updated = test
        .ok(
            "update_key_origins",
            json!({"project":"orbit","key":key_id,"allowed_origins":["https://orbit.example/","https://*.orbit.example"]}),
        )
        .await;
    assert_eq!(
        updated["allowed_origins"],
        json!(["https://orbit.example", "https://*.orbit.example"])
    );
    let bad = test
        .fails(
            "update_key_origins",
            json!({"project":"orbit","key":key_id,"allowed_origins":["orbit.example/path"]}),
        )
        .await;
    assert_eq!(bad["code"], "invalid_input");
    assert_eq!(bad["errors"][0]["path"], "/allowed_origins");
    assert!(hint(&bad).contains("https://example.com"), "{bad}");

    let refused = test
        .fails(
            "revoke_key",
            json!({"project":"orbit","key":key_id,"confirm":"nope"}),
        )
        .await;
    assert_eq!(refused["code"], "confirm_mismatch", "{refused}");
    assert!(hint(&refused).contains(&key_id));
    let listed = test.ok("list_keys", json!({"project":"orbit"})).await;
    let found = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["id"] == key_id.as_str())
        .unwrap();
    assert_eq!(found["revoked"], false);

    test.ok(
        "revoke_key",
        json!({"project":"orbit","key":key_id,"confirm":key_id}),
    )
    .await;
    let listed = test.ok("list_keys", json!({"project":"orbit"})).await;
    let found = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["id"] == key_id.as_str())
        .unwrap();
    assert_eq!(found["revoked"], true);
    let (status, _) = test
        .send(
            "POST",
            "/api/ingest",
            json!({"event_id":"e1","name":"x","source":"web"}),
            &[(
                "authorization",
                &format!("Bearer {}", key["key"].as_str().unwrap()),
            )],
        )
        .await;
    assert_eq!(status, 401);
    let missing = test
        .fails(
            "revoke_key",
            json!({"project":"orbit","key":"zzz","confirm":"zzz"}),
        )
        .await;
    assert_eq!(missing["code"], "not_found");
    test.close().await;
}

#[tokio::test]
async fn invalid_icon_error_lists_icons() {
    let test = Test::new();
    test.project("Orbit").await;
    let body = test
        .fails(
            "create_source",
            json!({"project":"orbit","name":"App","icon":"phone"}),
        )
        .await;
    assert_eq!(body["code"], "invalid_input", "{body}");
    assert_eq!(body["errors"][0]["path"], "/icon");
    for icon in ["website", "ios", "android", "terminal", "generic"] {
        assert!(hint(&body).contains(icon), "{body}");
    }
    let source = test
        .ok(
            "create_source",
            json!({"project":"orbit","name":"App","icon":"ios"}),
        )
        .await;
    assert_eq!(source["icon"], "ios");
    let renamed = test
        .ok(
            "update_source",
            json!({"project":"orbit","source":"app","name":"iOS app"}),
        )
        .await;
    assert_eq!(renamed["name"], "iOS app");
    assert_eq!(renamed["icon"], "ios");
    assert_eq!(renamed["slug"], "app");
    let missing = test
        .fails(
            "update_source",
            json!({"project":"orbit","source":"ap","name":"x"}),
        )
        .await;
    assert_eq!(missing["code"], "not_found");
    assert!(hint(&missing).contains("app"), "{missing}");
    let dup = test
        .fails("create_source", json!({"project":"orbit","name":"ios APP"}))
        .await;
    assert_eq!(dup["errors"][0]["path"], "/name", "{dup}");
    test.close().await;
}

#[tokio::test]
async fn log_settings_round_trip() {
    let test = Test::new();
    test.project("Orbit").await;
    let settings = test
        .ok("get_log_settings", json!({"project":"orbit"}))
        .await;
    assert_eq!(settings["retention_days"], 7);
    let updated = test
        .ok(
            "update_log_settings",
            json!({"project":"orbit","retention_days":30}),
        )
        .await;
    assert_eq!(updated["retention_days"], 30);
    let again = test
        .ok("update_log_settings", json!({"project":"orbit"}))
        .await;
    assert_eq!(again["retention_days"], 30);
    let read = test
        .tool_on(READ, "get_log_settings", json!({"project":"orbit"}))
        .await;
    assert_eq!(read.1["retention_days"], 30);
    let bad = test
        .fails(
            "update_log_settings",
            json!({"project":"orbit","retention_days":1000}),
        )
        .await;
    assert_eq!(bad["errors"][0]["path"], "/retention_days", "{bad}");
    assert!(hint(&bad).contains("365"));

    let key = test
        .ok(
            "create_log_key",
            json!({"project":"orbit","label":"API logs"}),
        )
        .await;
    assert!(key["key"].as_str().unwrap().starts_with("pl_"));
    let key_id = key["id"].as_str().unwrap().to_string();
    let listed = test.ok("list_log_keys", json!({"project":"orbit"})).await;
    assert_eq!(listed[0]["label"], "API logs");
    assert_eq!(listed[0]["revoked"], false);
    let refused = test
        .fails(
            "revoke_log_key",
            json!({"project":"orbit","key":key_id,"confirm":"x"}),
        )
        .await;
    assert_eq!(refused["code"], "confirm_mismatch");
    test.ok(
        "revoke_log_key",
        json!({"project":"orbit","key":key_id,"confirm":key_id}),
    )
    .await;
    let listed = test.ok("list_log_keys", json!({"project":"orbit"})).await;
    assert_eq!(listed[0]["revoked"], true);
    let bad = test
        .fails("create_log_key", json!({"project":"orbit","label":""}))
        .await;
    assert_eq!(bad["errors"][0]["path"], "/label", "{bad}");
    test.close().await;
}

#[tokio::test]
async fn mcp_source_change_emits_a_hint() {
    let test = Test::new();
    let project = test.project("Orbit").await;
    let mut changes = test.state.store.changes.subscribe();
    test.ok("create_source", json!({"project":"orbit","name":"Web"}))
        .await;
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint")
        .unwrap();
    assert_eq!(seen, (id(&project).to_string(), Signal::Dashboards));
    test.ok(
        "update_project",
        json!({"project":"orbit","name":"Orbit 2"}),
    )
    .await;
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint")
        .unwrap();
    assert_eq!(seen, (id(&project).to_string(), Signal::Dashboards));
    // The HTTP route shares the function, so it emits too.
    let (status, _) = test
        .manage(
            "POST",
            &format!("/api/products/{}/sources", id(&project)),
            json!({"name":"Docs"}),
        )
        .await;
    assert_eq!(status, 200);
    let seen = tokio::time::timeout(Duration::from_secs(2), changes.recv())
        .await
        .expect("a hint")
        .unwrap();
    assert_eq!(seen, (id(&project).to_string(), Signal::Dashboards));
    test.close().await;
}
