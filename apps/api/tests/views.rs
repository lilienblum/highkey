use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
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
        let body = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
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
    async fn save(&self, project: &Value, document: Value) -> (StatusCode, Value) {
        self.manage(
            "POST",
            &format!("/api/products/{}/views", id(project)),
            json!({"document": document}),
        )
        .await
    }
}
fn id(project: &Value) -> &str {
    project["id"].as_str().unwrap()
}
fn views_path(project: &Value) -> String {
    format!("/api/read/products/{}/views", id(project))
}
fn event_view(name: &str) -> Value {
    json!({"version":1,"name":name,"description":"Signups on the pro plan",
        "query":{"event":"signup","measure":"count","filters":[{"property":"plan","op":"eq","value":"pro"}],"group_by":"property:plan"}})
}
fn log_view(name: &str) -> Value {
    json!({"version":1,"kind":"logs","name":name,"query":{"min_level":"error","service":"checkout","search":"timeout"},"window":"1h"})
}

#[tokio::test]
async fn event_views_are_created_read_replaced_and_deleted_by_id_and_slug() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (status, created) = test.save(&project, event_view("Pro plan signups")).await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["slug"], "pro-plan-signups");
    assert_eq!(created["kind"], "events");
    assert_eq!(created["document"]["kind"], "events");
    assert_eq!(created["document"]["query"]["event"], "signup");
    let view_id = created["id"].as_str().unwrap().to_string();

    let (status, list) = test.read(&views_path(&project)).await;
    assert_eq!(status, 200);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["slug"], "pro-plan-signups");
    assert_eq!(list[0]["name"], "Pro plan signups");
    assert_eq!(list[0]["kind"], "events");
    assert_eq!(list[0]["description"], "Signups on the pro plan");

    for key in [view_id.as_str(), "pro-plan-signups"] {
        let (status, got) = test.read(&format!("{}/{key}", views_path(&project))).await;
        assert_eq!(status, 200, "{got}");
        assert_eq!(got["id"], view_id);
        assert_eq!(got["document"]["name"], "Pro plan signups");
    }
    // The project may be named by slug on reads.
    let (status, _) = test
        .read("/api/read/products/shop/views/pro-plan-signups")
        .await;
    assert_eq!(status, 200);

    let mut replacement = event_view("Pro signups, renamed");
    replacement["query"] = json!({"event":"checkout","measure":"actors"});
    let (status, replaced) = test
        .manage(
            "PUT",
            &format!("/api/products/{}/views/pro-plan-signups", id(&project)),
            json!({"document": replacement}),
        )
        .await;
    assert_eq!(status, 200, "{replaced}");
    assert_eq!(replaced["id"], view_id);
    assert_eq!(replaced["slug"], "pro-plan-signups");
    assert_eq!(replaced["document"]["name"], "Pro signups, renamed");
    assert_eq!(replaced["document"]["query"]["event"], "checkout");
    let (_, list) = test.read(&views_path(&project)).await;
    assert_eq!(list[0]["name"], "Pro signups, renamed");

    let (status, _) = test
        .manage(
            "DELETE",
            &format!("/api/products/{}/views/{view_id}", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 204);
    let (status, _) = test
        .read(&format!("{}/{view_id}", views_path(&project)))
        .await;
    assert_eq!(status, 404);
    let (_, list) = test.read(&views_path(&project)).await;
    assert_eq!(list, json!([]));
    let (status, _) = test
        .manage(
            "DELETE",
            &format!("/api/products/{}/views/pro-plan-signups", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn invalid_view_documents_report_pointer_paths() {
    let test = Test::new();
    let project = test.project("Shop").await;

    let mut doc = event_view("Bad");
    doc["query"]["measure"] = json!("sum");
    let (status, body) = test.save(&project, doc).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["code"], "invalid_document");
    assert_eq!(body["errors"][0]["path"], "/query/property");

    let mut doc = event_view("Bad");
    doc["query"]["filters"] = json!([{"property":"plan","op":"like","value":"pro"}]);
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/query/filters/0/op");

    let mut doc = event_view("Bad");
    doc["query"]["colour"] = json!("red");
    let (status, body) = test.save(&project, doc).await;
    assert_eq!(status, 400);
    assert_eq!(body["errors"][0]["path"], "/query/colour");

    let mut doc = event_view("Bad");
    doc["extra"] = json!(1);
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/extra");

    let (_, body) = test.save(&project, event_view("")).await;
    assert_eq!(body["errors"][0]["path"], "/name");
    let (_, body) = test.save(&project, event_view(&"n".repeat(81))).await;
    assert_eq!(body["errors"][0]["path"], "/name");
    let mut doc = event_view("Long");
    doc["description"] = json!("d".repeat(281));
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/description");
    let mut doc = event_view("Version");
    doc["version"] = json!(2);
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/version");
    let mut doc = event_view("Kind");
    doc["kind"] = json!("metrics");
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/kind");

    // Log views: only filter fields, no measure, and the window is a fixed set.
    let mut doc = log_view("Bad");
    doc["query"]["measure"] = json!("count");
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/query/measure");
    let mut doc = log_view("Bad");
    doc["query"]["min_level"] = json!("info");
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/query/min_level");
    let mut doc = log_view("Bad");
    doc["query"]["level"] = json!("error");
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/query/min_level");
    let mut doc = log_view("Bad");
    doc["window"] = json!("30d");
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/window");
    let mut doc = log_view("Bad");
    doc["query"]["filters"] = json!([{"attribute":"","value":1}]);
    let (_, body) = test.save(&project, doc).await;
    assert_eq!(body["errors"][0]["path"], "/query/filters/0/attribute");

    let (_, list) = test.read(&views_path(&project)).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn slugs_are_unique_per_kind_and_validate_is_reserved() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (_, first) = test.save(&project, event_view("Checkout")).await;
    let (_, second) = test.save(&project, event_view("Checkout")).await;
    assert_eq!(first["slug"], "checkout");
    assert_eq!(second["slug"], "checkout-2");

    // A log view may share a slug with an event view.
    let (status, logs) = test.save(&project, log_view("Checkout")).await;
    assert_eq!(status, 200, "{logs}");
    assert_eq!(logs["slug"], "checkout");
    assert_eq!(logs["kind"], "logs");
    let (_, again) = test.save(&project, log_view("Checkout")).await;
    assert_eq!(again["slug"], "checkout-2");

    // The same slug in two kinds is told apart by `kind`, and an id always is exact.
    let path = format!("{}/checkout", views_path(&project));
    let (_, got) = test.read(&format!("{path}?kind=logs")).await;
    assert_eq!(got["id"], logs["id"]);
    let (_, got) = test.read(&format!("{path}?kind=events")).await;
    assert_eq!(got["id"], first["id"]);
    let (status, got) = test.read(&path).await;
    assert_eq!(status, 409, "{got}");
    assert_eq!(got["code"], "ambiguous_view");
    let (_, list) = test
        .read(&format!("{}?kind=logs", views_path(&project)))
        .await;
    assert_eq!(list.as_array().unwrap().len(), 2);

    let (_, reserved) = test.save(&project, event_view("Validate")).await;
    assert_eq!(reserved["slug"], "validate-2");
    let (_, symbols) = test.save(&project, event_view("✨")).await;
    assert_eq!(symbols["slug"], "view");

    // Another project has its own slugs.
    let other = test.project("Blog").await;
    let (_, view) = test.save(&other, event_view("Checkout")).await;
    assert_eq!(view["slug"], "checkout");
}

#[tokio::test]
async fn log_views_are_created_read_replaced_and_deleted() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (status, created) = test.save(&project, log_view("Checkout errors")).await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["kind"], "logs");
    assert_eq!(created["slug"], "checkout-errors");
    assert_eq!(created["document"]["window"], "1h");
    assert_eq!(created["document"]["query"]["min_level"], "error");
    assert_eq!(created["document"]["query"]["service"], "checkout");

    let (_, got) = test
        .read(&format!("{}/checkout-errors", views_path(&project)))
        .await;
    assert_eq!(got["document"], created["document"]);

    // No window is allowed and means the Logs default.
    let mut replacement = log_view("Checkout errors");
    replacement.as_object_mut().unwrap().remove("window");
    replacement["query"] = json!({"level":"warn","filters":[{"attribute":"region","value":"eu"}]});
    let (status, replaced) = test
        .manage(
            "PUT",
            &format!("/api/products/{}/views/checkout-errors", id(&project)),
            json!({"document": replacement}),
        )
        .await;
    assert_eq!(status, 200, "{replaced}");
    assert!(replaced["document"].get("window").is_none());
    assert_eq!(
        replaced["document"]["query"]["filters"][0]["attribute"],
        "region"
    );

    // A view keeps its kind.
    let (status, body) = test
        .manage(
            "PUT",
            &format!(
                "/api/products/{}/views/{}",
                id(&project),
                created["id"].as_str().unwrap()
            ),
            json!({"document": event_view("Now events")}),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "/kind");

    let (status, _) = test
        .manage(
            "DELETE",
            &format!(
                "/api/products/{}/views/checkout-errors?kind=logs",
                id(&project)
            ),
            Value::Null,
        )
        .await;
    assert_eq!(status, 204);
    let (_, list) = test.read(&views_path(&project)).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn documents_without_a_kind_are_event_views() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (status, created) = test.save(&project, event_view("Plain")).await;
    assert_eq!(status, 200, "{created}");
    assert!(event_view("Plain").get("kind").is_none());
    assert_eq!(created["kind"], "events");
    assert_eq!(created["document"]["kind"], "events");
    // A stored document written before `kind` existed still loads as an event view.
    let product = id(&project).to_string();
    test.state
        .store
        .state(move |db| {
            db.execute(
                "UPDATE views SET document=json_remove(document,'$.kind') WHERE product_id=?",
                [product],
            )
            .map_err(anyhow::Error::from)?;
            Ok(())
        })
        .await
        .unwrap();
    let (status, got) = test.read(&format!("{}/plain", views_path(&project))).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["kind"], "events");
    assert_eq!(got["document"]["kind"], "events");
}

#[tokio::test]
async fn a_project_holds_at_most_one_hundred_views_across_both_kinds() {
    let test = Test::new();
    let project = test.project("Shop").await;
    for i in 0..60 {
        let (status, body) = test.save(&project, event_view(&format!("Event {i}"))).await;
        assert_eq!(status, 200, "{body}");
    }
    for i in 0..40 {
        let (status, body) = test.save(&project, log_view(&format!("Log {i}"))).await;
        assert_eq!(status, 200, "{body}");
    }
    for document in [event_view("One more"), log_view("One more")] {
        let (status, body) = test.save(&project, document).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["code"], "limit");
    }
    // Another project is unaffected, and deleting frees a place.
    let other = test.project("Blog").await;
    let (status, _) = test.save(&other, event_view("Fine")).await;
    assert_eq!(status, 200);
    let (status, _) = test
        .manage(
            "DELETE",
            &format!("/api/products/{}/views/event-0", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 204);
    let (status, _) = test.save(&project, log_view("One more")).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn products_list_view_links_by_name_with_their_kind() {
    let test = Test::new();
    let project = test.project("Shop").await;
    test.save(&project, event_view("Zeta")).await;
    test.save(&project, log_view("Beta")).await;
    test.save(&project, event_view("Alpha")).await;
    let (status, products) = test.read("/api/read/products").await;
    assert_eq!(status, 200);
    let views = products
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == project["id"])
        .unwrap()["views"]
        .as_array()
        .unwrap()
        .clone();
    let names: Vec<_> = views.iter().map(|v| v["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Alpha", "Beta", "Zeta"]);
    assert_eq!(views[1]["kind"], "logs");
    assert_eq!(views[0]["slug"], "alpha");
    assert!(views[0]["id"].is_string());
    assert!(views[0].get("document").is_none());
}

#[tokio::test]
async fn view_writes_need_the_marker_and_reads_do_not() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let path = format!("/api/products/{}/views", id(&project));
    let (status, _) = test
        .send("POST", &path, json!({"document": event_view("A")}), &[])
        .await;
    assert_eq!(status, 403);
    let (_, created) = test.save(&project, event_view("A")).await;
    let item = format!("{path}/{}", created["id"].as_str().unwrap());
    let (status, _) = test
        .send("PUT", &item, json!({"document": event_view("B")}), &[])
        .await;
    assert_eq!(status, 403);
    let (status, _) = test.send("DELETE", &item, Value::Null, &[]).await;
    assert_eq!(status, 403);
    let (status, _) = test.read(&views_path(&project)).await;
    assert_eq!(status, 200);
    let (status, _) = test.read("/api/read/products/nope/views").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn view_writes_emit_the_dashboards_signal_and_share_the_write_limit() {
    let mut test = Test::new();
    let project = test.project("Shop").await;
    let mut changes = test.state.store.changes.subscribe();
    let (status, _) = test.save(&project, event_view("Live")).await;
    assert_eq!(status, 200);
    let seen = tokio::time::timeout(std::time::Duration::from_secs(2), changes.recv())
        .await
        .expect("a change arrives");
    assert_eq!(seen.unwrap().1, piko::changes::Signal::Dashboards);

    test.state.write_limit = std::sync::Arc::new(piko::dashboards::limit::WriteLimit::new(
        1,
        std::time::Duration::from_secs(60),
    ));
    let (status, _) = test.save(&project, event_view("One")).await;
    assert_eq!(status, 200);
    let (status, body) = test.save(&project, event_view("Two")).await;
    assert_eq!(status, 429, "{body}");
    assert_eq!(body["code"], "rate_limited");
}

#[tokio::test]
async fn invalid_view_documents_say_view_not_dashboard() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let mut doc = event_view("Bad");
    doc["extra"] = json!(1);
    let (status, body) = test.save(&project, doc).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Invalid view document");
    assert_eq!(body["code"], "invalid_document");
    let (_, created) = test.save(&project, event_view("Good")).await;
    let (status, body) = test
        .manage(
            "PUT",
            &format!(
                "/api/products/{}/views/{}",
                id(&project),
                created["id"].as_str().unwrap()
            ),
            json!({"document": event_view("")}),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Invalid view document");
}

#[tokio::test]
async fn a_bad_kind_is_a_structured_error_that_lists_the_kinds() {
    let test = Test::new();
    let project = test.project("Shop").await;
    for path in [
        format!("{}?kind=metrics", views_path(&project)),
        format!("{}/anything?kind=metrics", views_path(&project)),
    ] {
        let (status, body) = test.read(&path).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["code"], "invalid_kind");
        assert_eq!(body["errors"][0]["path"], "kind");
        let hint = body["errors"][0]["hint"].as_str().unwrap();
        assert!(hint.contains("events") && hint.contains("logs"), "{hint}");
    }
    let (status, body) = test
        .manage(
            "DELETE",
            &format!("/api/products/{}/views/anything?kind=metrics", id(&project)),
            Value::Null,
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errors"][0]["path"], "kind");
}

#[tokio::test]
async fn replacing_a_slug_that_exists_as_the_other_kind_is_a_404_naming_it() {
    let test = Test::new();
    let project = test.project("Shop").await;
    test.save(&project, log_view("Errors")).await;
    let path = format!("/api/products/{}/views/errors", id(&project));
    // The document names no kind, so it is an events view.
    let (status, body) = test
        .manage("PUT", &path, json!({"document": event_view("Errors")}))
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["code"], "not_found");
    assert!(
        body["errors"][0]["hint"].as_str().unwrap().contains("logs"),
        "{body}"
    );
    // A kind that is written but wrong gets the same answer.
    let mut doc = event_view("Errors");
    doc["kind"] = json!("events");
    let (status, body) = test.manage("PUT", &path, json!({"document": doc})).await;
    assert_eq!(status, 404, "{body}");
    assert!(
        body["errors"][0]["hint"].as_str().unwrap().contains("logs"),
        "{body}"
    );
    // The right kind replaces it.
    let (status, body) = test
        .manage("PUT", &path, json!({"document": log_view("Errors")}))
        .await;
    assert_eq!(status, 200, "{body}");
    // A GET with the wrong kind says where the view is.
    let (status, body) = test
        .read(&format!("{}/errors?kind=events", views_path(&project)))
        .await;
    assert_eq!(status, 404);
    assert!(
        body["errors"][0]["hint"].as_str().unwrap().contains("logs"),
        "{body}"
    );
}

#[tokio::test]
async fn a_slug_shared_by_both_kinds_needs_a_kind() {
    let test = Test::new();
    let project = test.project("Shop").await;
    let (_, events) = test.save(&project, event_view("Both")).await;
    let (_, logs) = test.save(&project, log_view("Both")).await;
    assert_eq!(events["slug"], logs["slug"]);
    let read = format!("{}/both", views_path(&project));
    let write = format!("/api/products/{}/views/both", id(&project));

    let (status, body) = test.read(&read).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "ambiguous_view");
    let hint = body["errors"][0]["hint"].as_str().unwrap();
    assert!(
        hint.contains("?kind=events") && hint.contains("?kind=logs"),
        "{hint}"
    );

    // A document that names no kind cannot say which view it replaces.
    let (status, body) = test
        .manage("PUT", &write, json!({"document": event_view("Both")}))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "ambiguous_view");
    // A replace takes its kind from the document, so the hint says to write it there.
    let hint = body["errors"][0]["hint"].as_str().unwrap();
    assert!(
        hint.contains("\"kind\"") && !hint.contains("?kind="),
        "{hint}"
    );
    let (status, body) = test.manage("DELETE", &write, Value::Null).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "ambiguous_view");

    // Naming the kind settles each of them.
    let mut doc = event_view("Both");
    doc["kind"] = json!("events");
    let (status, body) = test.manage("PUT", &write, json!({"document": doc})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["id"], events["id"]);
    let (status, _) = test.read(&format!("{read}?kind=logs")).await;
    assert_eq!(status, 200);
    let (status, _) = test
        .manage("DELETE", &format!("{write}?kind=events"), Value::Null)
        .await;
    assert_eq!(status, 204);
    // With one left, the slug is no longer ambiguous.
    let (status, body) = test.read(&read).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["id"], logs["id"]);
}

#[tokio::test]
async fn an_unknown_view_suggests_the_nearest_slug() {
    let test = Test::new();
    let project = test.project("Shop").await;
    test.save(&project, event_view("Checkout")).await;
    let (status, body) = test
        .read(&format!("{}/chekout", views_path(&project)))
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["code"], "not_found");
    assert_eq!(body["errors"][0]["hint"], "did you mean `checkout`?");
}
