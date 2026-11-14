//! The examples in `docs/dashboards.md` are the ones agents and people copy, so they must
//! stay valid: against the published JSON Schema, against the validation rules, and (for the
//! SQL in them) against a real DuckDB dry run.
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use piko::{
    AppState, Config,
    dashboards::{
        spec,
        validate::{check_document, parse_document},
    },
    router,
    views::{check_view, parse_view},
};
use serde_json::{Value, json};
use tower::ServiceExt;

const DOCS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/dashboards.md");

/// The JSON of every fenced block whose info string is exactly `json <tag>`.
fn blocks(tag: &str) -> Vec<(usize, String)> {
    let text = std::fs::read_to_string(DOCS).expect("docs/dashboards.md exists");
    let fence = format!("```json {tag}");
    let mut found = Vec::new();
    let mut open: Option<(usize, String)> = None;
    for (n, line) in text.lines().enumerate() {
        match &mut open {
            None if line.trim_end() == fence => open = Some((n + 1, String::new())),
            Some(_) if line.trim_end() == "```" => found.extend(open.take()),
            Some((_, body)) => {
                body.push_str(line);
                body.push('\n');
            }
            None => {}
        }
    }
    assert!(open.is_none(), "an unclosed ```json {tag} block");
    found
}

fn json_of(line: usize, text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("block at line {line} is not JSON: {e}"))
}

#[test]
fn docs_examples_validate_against_schema_and_rules() {
    let schema = jsonschema::validator_for(&spec::schema()).expect("the schema compiles");
    let dashboards = blocks("piko-dashboard");
    assert!(
        dashboards.len() >= 4,
        "expected at least 4 piko-dashboard examples, found {}",
        dashboards.len()
    );
    let mut sql = 0;
    for (line, text) in &dashboards {
        let value = json_of(*line, text);
        let errors: Vec<String> = schema
            .iter_errors(&value)
            .map(|e| format!("{} at {}", e, e.instance_path()))
            .collect();
        assert!(
            errors.is_empty(),
            "dashboard at line {line} breaks the schema: {errors:?}"
        );
        sql += text.matches("\"signal\": \"sql\"").count();
        let doc = parse_document(value)
            .unwrap_or_else(|r| panic!("dashboard at line {line} does not parse: {:?}", r.errors));
        let report = check_document(&doc);
        assert!(
            report.errors.is_empty(),
            "dashboard at line {line} breaks a rule: {:?}",
            report.errors
        );
    }
    assert!(sql >= 1, "expected an example with a SQL query");

    let views = blocks("piko-view");
    assert!(
        views.len() >= 2,
        "expected at least 2 piko-view examples, found {}",
        views.len()
    );
    let mut kinds = std::collections::BTreeSet::new();
    for (line, text) in &views {
        let doc = parse_view(json_of(*line, text))
            .unwrap_or_else(|r| panic!("view at line {line} does not parse: {:?}", r.errors));
        let report = check_view(&doc);
        assert!(
            report.errors.is_empty(),
            "view at line {line} breaks a rule: {:?}",
            report.errors
        );
        kinds.insert(format!("{:?}", doc.kind()));
    }
    assert_eq!(kinds.len(), 2, "expected one view of each kind: {kinds:?}");
}

#[tokio::test]
async fn docs_dashboards_pass_the_server_validation() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::open(&Config {
        data_dir: directory.path().into(),
        query_concurrency: 4,
        queue_capacity: 16,
    })
    .unwrap();
    let app = router(state);
    let call = |method: &str, path: &str, body: Value, admin: bool| {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if admin {
            request = request.header("x-piko-admin", "1");
        }
        let request = request.body(Body::from(body.to_string())).unwrap();
        let app = app.clone();
        async move {
            let response = app.oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
                .await
                .unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap())
        }
    };
    let (status, project) = call(
        "POST",
        "/api/products",
        json!({"name": "Docs", "retention_days": 365}),
        true,
    )
    .await;
    assert_eq!(status, 200, "{project}");
    let validate = format!(
        "/api/read/products/{}/dashboards/validate",
        project["id"].as_str().unwrap()
    );
    for (line, text) in blocks("piko-dashboard") {
        let (status, body) = call(
            "POST",
            &validate,
            json!({"document": json_of(line, &text)}),
            false,
        )
        .await;
        assert_eq!(status, 200, "dashboard at line {line}: {body}");
        assert_eq!(body["valid"], true, "dashboard at line {line}: {body}");
    }
}
