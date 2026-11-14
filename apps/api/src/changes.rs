use anyhow::{Context, Result, ensure};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use tokio::{sync::broadcast, task::JoinHandle};

const CAPACITY: usize = 128;
const MAX_PRODUCTS: usize = 64;
const COALESCE: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(800);

/// The kind of data a live hint refers to. Hints never carry the data itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Signal {
    Events,
    Logs,
    Dashboards,
}

#[derive(Clone)]
pub struct Changes {
    tx: broadcast::Sender<(String, Signal)>,
}
impl Default for Changes {
    fn default() -> Self {
        let (tx, _) = broadcast::channel(CAPACITY);
        Self { tx }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEnvelope {
    pub version: u8,
    pub changes: Option<Vec<Change>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub product: String,
    pub signals: Vec<Signal>,
}

type Pending = Option<BTreeMap<String, BTreeSet<Signal>>>;

pub struct ChangeDelivery {
    endpoint: Url,
    token: String,
}
impl ChangeDelivery {
    pub fn new(endpoint: &str, token: String) -> Result<Self> {
        let endpoint = Url::parse(endpoint).context("PIKO_CHANGE_URL must be an absolute URL")?;
        ensure!(
            matches!(endpoint.scheme(), "http" | "https")
                && endpoint.host_str().is_some()
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none(),
            "PIKO_CHANGE_URL must be HTTP(S), without credentials, query, or fragment"
        );
        ensure!(
            !token.is_empty(),
            "PIKO_CHANGE_TOKEN is required with PIKO_CHANGE_URL"
        );
        Ok(Self { endpoint, token })
    }
}

impl Changes {
    pub fn subscribe(&self) -> broadcast::Receiver<(String, Signal)> {
        self.tx.subscribe()
    }

    pub(crate) fn changed(&self, product: &str, signal: Signal) {
        let _ = self.tx.send((product.to_owned(), signal));
    }

    pub fn start_delivery(&self, config: ChangeDelivery) -> Result<JoinHandle<()>> {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::none())
            .build()?;
        let receiver = self.subscribe();
        Ok(tokio::spawn(deliver(receiver, client, config)))
    }
}

// None means a full resync, including changes lost to queue lag or a failed delivery.
fn add_change(pending: &mut Pending, product: String, signal: Signal) {
    if let Some(changes) = pending {
        changes.entry(product).or_default().insert(signal);
        if changes.len() > MAX_PRODUCTS {
            *pending = None;
        }
    }
}

fn envelope(pending: &Pending) -> ChangeEnvelope {
    ChangeEnvelope {
        version: 2,
        changes: pending.as_ref().map(|changes| {
            changes
                .iter()
                .map(|(product, signals)| Change {
                    product: product.clone(),
                    signals: signals.iter().copied().collect(),
                })
                .collect()
        }),
    }
}

async fn deliver(
    mut receiver: broadcast::Receiver<(String, Signal)>,
    client: Client,
    config: ChangeDelivery,
) {
    let mut pending: Pending = None;
    let mut backoff = Duration::from_secs(1);
    loop {
        if pending.as_ref().is_some_and(BTreeMap::is_empty) {
            match receiver.recv().await {
                Ok((product, signal)) => add_change(&mut pending, product, signal),
                Err(broadcast::error::RecvError::Lagged(_)) => pending = None,
                Err(broadcast::error::RecvError::Closed) => return,
            }
            tokio::time::sleep(COALESCE).await;
        }
        loop {
            match receiver.try_recv() {
                Ok((product, signal)) => add_change(&mut pending, product, signal),
                Err(broadcast::error::TryRecvError::Lagged(_)) => pending = None,
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(broadcast::error::TryRecvError::Closed) => return,
            }
        }
        let envelope = envelope(&pending);
        let sent = client
            .post(config.endpoint.clone())
            .bearer_auth(&config.token)
            .json(&envelope)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        if sent {
            pending = Some(BTreeMap::new());
            backoff = Duration::from_secs(1);
        } else {
            tracing::warn!(
                retry_seconds = backoff.as_secs(),
                "Change delivery failed; retrying a full refresh"
            );
            pending = None;
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn envelope_coalesces_signals_per_product() {
        let (a, b) = ("a-product".to_string(), "b-product".to_string());
        let mut pending = Some(BTreeMap::new());
        add_change(&mut pending, b.clone(), Signal::Dashboards);
        add_change(&mut pending, a.clone(), Signal::Logs);
        add_change(&mut pending, a.clone(), Signal::Events);
        add_change(&mut pending, a.clone(), Signal::Logs);
        assert_eq!(
            envelope(&pending),
            ChangeEnvelope {
                version: 2,
                changes: Some(vec![
                    Change {
                        product: a,
                        signals: vec![Signal::Events, Signal::Logs]
                    },
                    Change {
                        product: b,
                        signals: vec![Signal::Dashboards]
                    },
                ])
            }
        );
        assert_eq!(
            serde_json::to_value(envelope(&pending)).unwrap()["changes"][0]["signals"],
            serde_json::json!(["events", "logs"])
        );
    }

    #[test]
    fn lag_or_overflow_sends_null() {
        let mut pending = Some(BTreeMap::new());
        for _ in 0..1000 {
            add_change(
                &mut pending,
                uuid::Uuid::new_v4().to_string(),
                Signal::Events,
            );
        }
        assert!(pending.is_none());
        assert_eq!(
            serde_json::to_value(envelope(&pending)).unwrap(),
            serde_json::json!({"version": 2, "changes": null})
        );
        let changes = Changes::default();
        let mut receiver = changes.subscribe();
        for _ in 0..1000 {
            changes.changed(&uuid::Uuid::new_v4().to_string(), Signal::Events);
        }
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let mut retained = 0;
        while receiver.try_recv().is_ok() {
            retained += 1;
        }
        assert!(retained <= CAPACITY);
    }

    #[tokio::test]
    async fn failed_delivery_retries_global_then_coalesces_product_hints() {
        let calls = Arc::new(AtomicUsize::new(0));
        let attempts = calls.clone();
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let app = Router::new().route(
            "/changes",
            post(
                move |headers: HeaderMap, Json(message): Json<ChangeEnvelope>| {
                    let tx = tx.clone();
                    let attempts = attempts.clone();
                    async move {
                        assert_eq!(headers["authorization"], "Bearer test-only-token");
                        tx.send(message).await.unwrap();
                        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                            StatusCode::SERVICE_UNAVAILABLE
                        } else {
                            StatusCode::NO_CONTENT
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let changes = Changes::default();
        let delivery = changes
            .start_delivery(
                ChangeDelivery::new(
                    &format!("http://{address}/changes"),
                    "test-only-token".into(),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(rx.recv().await.unwrap().changes, None);
        let a = uuid::Uuid::new_v4().to_string();
        changes.changed(&a, Signal::Events);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap()
                .changes,
            None
        );
        // Let the successful response settle before checking the next coalesced batch.
        tokio::time::sleep(Duration::from_millis(30)).await;
        let b = uuid::Uuid::new_v4().to_string();
        changes.changed(&a, Signal::Events);
        changes.changed(&a, Signal::Logs);
        changes.changed(&b, Signal::Events);
        let result = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let mut expected = vec![
            Change {
                product: a,
                signals: vec![Signal::Events, Signal::Logs],
            },
            Change {
                product: b,
                signals: vec![Signal::Events],
            },
        ];
        expected.sort_by(|x, y| x.product.cmp(&y.product));
        assert_eq!(
            result,
            ChangeEnvelope {
                version: 2,
                changes: Some(expected)
            }
        );
        delivery.abort();
        server.abort();
    }

    #[tokio::test]
    async fn hanging_delivery_has_a_short_deadline() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let app = Router::new().route(
            "/changes",
            post(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { std::future::pending::<StatusCode>().await }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let changes = Changes::default();
        let delivery = changes
            .start_delivery(
                ChangeDelivery::new(
                    &format!("http://{address}/changes"),
                    "test-only-token".into(),
                )
                .unwrap(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while attempts.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("request must time out and retry without waiting for the server");
        delivery.abort();
        server.abort();
    }
}
