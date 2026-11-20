mod common;
use common::{Kind, admin_query, clickhouse, config, hash, post, seed_key, write_key};
use highkey_ingest::{keys::FOUND_TTL, router, start};
use serde_json::{Value, json};

async fn policy(key: &str, project: &str, server: bool, browser: bool) {
    let row = json!({"hash":hash(key),"product_id":project,"server_key":u8::from(server),"allow_browser_revenue":u8::from(browser)});
    admin_query(&format!(
        "INSERT INTO highkey.ingest_key_policies FORMAT JSONEachRow {row}"
    ))
    .await;
}

fn event(id: &str, cents: Value) -> Value {
    json!({"event_id":id,"name":"purchase","source":"server","properties":{"revenue":cents}})
}

#[tokio::test]
async fn revenue_requires_opt_in_and_revocation_takes_effect() {
    let project = uuid::Uuid::new_v4().to_string();
    let key = seed_key(Kind::Events, &project, &project, &[], 30, false).await;
    let app = router(start(config(&clickhouse().url)).await.unwrap());
    // Even a caller without Origin cannot turn a public key into a server key.
    for origin in [None, Some("https://shop.example")] {
        let rejected = post(
            &app,
            "/api/ingest",
            Some(&key),
            origin,
            &event("purchase", json!(2500)),
        )
        .await;
        assert_eq!(rejected.status, 403, "{}", rejected.text());
    }
    policy(&key, &project, false, true).await;
    tokio::time::sleep(FOUND_TTL + std::time::Duration::from_millis(50)).await;
    let accepted = post(
        &app,
        "/api/ingest",
        Some(&key),
        Some("https://shop.example"),
        &event("purchase", json!(2500)),
    )
    .await;
    assert_eq!(accepted.status, 200, "{}", accepted.text());
    policy(&key, &project, false, false).await;
    tokio::time::sleep(FOUND_TTL + std::time::Duration::from_millis(50)).await;
    assert_eq!(
        post(
            &app,
            "/api/ingest",
            Some(&key),
            None,
            &event("later", json!(1))
        )
        .await
        .status,
        403
    );
}

#[tokio::test]
async fn server_keys_reject_browsers_and_invalid_money_and_deduplicate_retries() {
    let project = uuid::Uuid::new_v4().to_string();
    let key = format!("sk_{}", uuid::Uuid::new_v4().simple());
    write_key(
        Kind::Events,
        &hash(&key),
        &project,
        &project,
        &[],
        30,
        false,
    )
    .await;
    let app = router(start(config(&clickhouse().url)).await.unwrap());
    // Incomplete mirroring fails closed.
    assert_eq!(
        post(
            &app,
            "/api/ingest",
            Some(&key),
            None,
            &event("missing-policy", json!(1))
        )
        .await
        .status,
        401
    );
    policy(&key, &project, true, false).await;
    let app = router(start(config(&clickhouse().url)).await.unwrap());
    for origin in ["https://shop.example", "null", "not-an-origin"] {
        assert_eq!(
            post(
                &app,
                "/api/ingest",
                Some(&key),
                Some(origin),
                &event("browser", json!(10))
            )
            .await
            .status,
            403
        );
    }
    for cents in [
        json!("100"),
        json!(true),
        json!(1.5),
        json!(9_007_199_254_740_992_i64),
        json!(null),
    ] {
        let batch = json!({"events":[event("must-not-commit", json!(10)), event("bad", cents)]});
        let reply = post(&app, "/api/ingest", Some(&key), None, &batch).await;
        assert_eq!(reply.status, 400, "{}", reply.text());
    }
    let batch = json!({"events":[event("sale", json!(2500)), event("refund", json!(-500)), event("free", json!(0))]});
    let accepted = post(&app, "/api/ingest", Some(&key), None, &batch).await;
    assert_eq!(
        accepted.json(),
        json!({"accepted":3,"duplicates":0}),
        "{}",
        accepted.text()
    );
    assert_eq!(
        post(&app, "/api/ingest", Some(&key), None, &batch)
            .await
            .json(),
        json!({"accepted":0,"duplicates":3})
    );
    let stored = admin_query(&format!("SELECT count() AS n, sum(properties.revenue.:Int64) AS cents FROM highkey.events FINAL WHERE product_id = '{project}'")).await;
    assert_eq!(stored[0], json!({"n":3,"cents":2000}));
    write_key(Kind::Events, &hash(&key), &project, &project, &[], 30, true).await;
    tokio::time::sleep(FOUND_TTL + std::time::Duration::from_millis(50)).await;
    assert_eq!(
        post(
            &app,
            "/api/ingest",
            Some(&key),
            None,
            &event("revoked", json!(1))
        )
        .await
        .status,
        401
    );
}
