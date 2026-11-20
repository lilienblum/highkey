mod common;
use common::{clickhouse, config, get, stub_clickhouse};
use highkey_ingest::{contract::ContractError, router, start};

#[tokio::test]
async fn refuses_a_clickhouse_older_than_the_minimum() {
    let url = stub_clickhouse("24.3.1.1", 1).await;
    let error = start(config(&url)).await.err().expect("start refuses");
    let contract = error
        .downcast_ref::<ContractError>()
        .expect("a contract error");
    assert!(
        matches!(contract, ContractError::ServerTooOld { .. }),
        "{contract}"
    );
    assert!(error.to_string().contains("25.8"), "{error}");
}

#[tokio::test]
async fn refuses_an_older_contract() {
    let url = stub_clickhouse("26.8.37.168", 0).await;
    let error = start(config(&url)).await.err().expect("start refuses");
    let contract = error
        .downcast_ref::<ContractError>()
        .expect("a contract error");
    assert!(
        matches!(
            contract,
            ContractError::ContractTooOld {
                found: 0,
                required: 3
            }
        ),
        "{contract}"
    );
    assert!(error.to_string().contains("migrat"), "{error}");
}

#[tokio::test]
async fn accepts_a_newer_contract() {
    let url = stub_clickhouse("26.8.37.168", 4).await;
    assert!(start(config(&url)).await.is_ok());
}

#[tokio::test]
async fn starts_against_the_test_clickhouse_and_reports_health() {
    let state = start(config(&clickhouse().url)).await.expect("starts");
    let reply = get(&router(state), "/health").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["status"], "ok");
}

#[tokio::test]
async fn serves_the_tracker_with_its_headers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tracker.js");
    std::fs::write(&path, "export const highkey = 1;\n").unwrap();
    let mut settings = config(&clickhouse().url);
    settings.tracker_path = Some(path);
    let reply = get(&router(start(settings).await.unwrap()), "/tracker.js").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "export const highkey = 1;\n");
    for (name, value) in [
        ("content-type", "application/javascript; charset=utf-8"),
        ("access-control-allow-origin", "*"),
        ("cache-control", "public, max-age=3600"),
        ("x-content-type-options", "nosniff"),
    ] {
        assert_eq!(
            reply.headers.get(name).and_then(|v| v.to_str().ok()),
            Some(value),
            "{name}"
        );
    }
}

#[tokio::test]
async fn tracker_is_404_when_not_configured() {
    let reply = get(
        &router(start(config(&clickhouse().url)).await.unwrap()),
        "/tracker.js",
    )
    .await;
    assert_eq!(reply.status, 404);
}
