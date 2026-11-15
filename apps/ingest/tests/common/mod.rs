//! Shared helpers for the ingest app's integration tests. They run against the test ClickHouse
//! that `bun scripts/clickhouse.ts test-up` starts and migrates.
#![allow(dead_code)]
use axum::{Router, body::Body, http::Request};
use http_body_util::BodyExt;
use piko_ingest::{ClickHouseConfig, Config};
use serde_json::Value;
use std::{
    net::SocketAddr,
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::net::{TcpListener, TcpStream};
use tower::ServiceExt;

pub const ADMIN_PASSWORD: &str = "piko-test";
pub const INGEST_PASSWORD: &str = "piko-ingest-test";

pub struct TestCh {
    pub url: String,
}

/// The test ClickHouse, started (or reused) once per test binary.
pub fn clickhouse() -> &'static TestCh {
    static SERVER: OnceLock<TestCh> = OnceLock::new();
    SERVER.get_or_init(|| {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let output = Command::new("bun")
            .args(["scripts/clickhouse.ts", "test-up"])
            .current_dir(root)
            .output()
            .expect("start the test ClickHouse with `bun scripts/clickhouse.ts test-up` (needs bun and Docker)");
        assert!(
            output.status.success(),
            "start the test ClickHouse with `bun scripts/clickhouse.ts test-up`: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let url = String::from_utf8_lossy(&output.stdout)
            .lines()
            .last()
            .expect("test-up prints the URL")
            .trim()
            .to_string();
        TestCh { url }
    })
}

pub fn config(url: &str) -> Config {
    Config {
        clickhouse: ClickHouseConfig {
            url: url.into(),
            user: "piko_ingest".into(),
            password: INGEST_PASSWORD.into(),
        },
        queue_capacity: 64,
        tracker_path: None,
    }
}

/// Runs SQL as the ClickHouse admin and returns the result rows.
pub async fn admin_query(sql: &str) -> Vec<Value> {
    let url = &clickhouse().url;
    let response = reqwest::Client::new()
        .post(format!("{url}/?default_format=JSON&wait_end_of_query=1"))
        .header("X-ClickHouse-User", "piko_admin")
        .header("X-ClickHouse-Key", ADMIN_PASSWORD)
        .body(sql.to_string())
        .send()
        .await
        .expect("reach the test ClickHouse");
    let status = response.status();
    let text = response.text().await.unwrap();
    assert!(status.is_success(), "{sql}: {text}");
    if text.trim().is_empty() {
        return vec![];
    }
    let parsed: Value = serde_json::from_str(&text).unwrap();
    parsed["data"].as_array().cloned().unwrap_or_default()
}

/// A stand-in ClickHouse that reports `version` and contract `contract`.
pub async fn stub_clickhouse(version: &'static str, contract: u32) -> String {
    use axum::routing::post;
    let app = Router::new().route(
        "/",
        post(move |body: String| async move {
            let row = if body.contains("ingest_contract") {
                serde_json::json!({ "version": contract })
            } else {
                serde_json::json!({ "version": version })
            };
            axum::Json(serde_json::json!({ "meta": [], "data": [row], "rows": 1 }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

/// A TCP forwarder to the test ClickHouse that a test can cut and restore.
#[derive(Clone)]
pub struct CutProxy {
    pub url: String,
    open: Arc<AtomicBool>,
}

impl CutProxy {
    pub async fn start() -> Self {
        let target: SocketAddr = clickhouse()
            .url
            .trim_start_matches("http://")
            .parse()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let open = Arc::new(AtomicBool::new(true));
        let gate = open.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut inbound, _)) = listener.accept().await else {
                    return;
                };
                let gate = gate.clone();
                tokio::spawn(async move {
                    if !gate.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(mut outbound) = TcpStream::connect(target).await else {
                        return;
                    };
                    let (mut ri, mut wi) = inbound.split();
                    let (mut ro, mut wo) = outbound.split();
                    let forward = async {
                        let mut up = [0u8; 16 * 1024];
                        let mut down = [0u8; 16 * 1024];
                        loop {
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            tokio::select! {
                                read = ri.read(&mut up) => match read {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => if wo.write_all(&up[..n]).await.is_err() { return },
                                },
                                read = ro.read(&mut down) => match read {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => if wi.write_all(&down[..n]).await.is_err() { return },
                                },
                                _ = async {
                                    while gate.load(Ordering::SeqCst) {
                                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                                    }
                                } => return,
                            }
                        }
                    };
                    forward.await;
                });
            }
        });
        Self { url, open }
    }
    pub fn cut(&self) {
        self.open.store(false, Ordering::SeqCst);
    }
    pub fn restore(&self) {
        self.open.store(true, Ordering::SeqCst);
    }
}

pub struct Reply {
    pub status: u16,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub async fn send(app: &Router, request: Request<Body>) -> Reply {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

pub async fn get(app: &Router, path: &str) -> Reply {
    send(app, Request::get(path).body(Body::empty()).unwrap()).await
}
