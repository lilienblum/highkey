use super::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    task::{Context, Poll, Wake, Waker},
};

// Mock transports have no I/O; tests need no async runtime.
fn run<F: Future>(future: F) -> F::Output {
    struct Notify(std::thread::Thread);
    impl Wake for Notify {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Notify(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}

#[derive(Default)]
struct Mock {
    responses: Mutex<VecDeque<Result<Response, Error>>>,
    bodies: Mutex<Vec<String>>,
    sleeps: Mutex<Vec<Duration>>,
}
impl Mock {
    fn new(responses: Vec<Result<Response, Error>>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            ..Self::default()
        }
    }
}
impl Transport for Mock {
    async fn post(&self, request: Request<'_>) -> Result<Response, Error> {
        assert_eq!(request.url, "https://highkey.example/prefix/api/ingest");
        assert_eq!(request.key, "pk_test");
        assert!(!request.remaining().is_zero());
        self.bodies.lock().unwrap().push(request.body.into());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected retry")
    }
    async fn sleep(&self, delay: Duration) {
        self.sleeps.lock().unwrap().push(delay);
    }
}
fn response(status: u16, body: &str) -> Result<Response, Error> {
    Ok(Response {
        status,
        body: body.into(),
        retry_after: None,
    })
}
fn client(mock: Mock) -> Highkey<Mock> {
    Highkey::with_transport("https://highkey.example/prefix///", "pk_test", mock).unwrap()
}
fn event() -> Event {
    Event::new("command_run", "cli")
}

#[test]
fn entity_mutations_validate_before_delivery_and_preserve_types() {
    let events = [
        Event::identify("server", "user-1")
            .trait_value("paid", true)
            .increment("credits", -2.0),
        Event::group("server", "team", "team-1").trait_value("seats", 10_i64),
    ];
    let json: serde_json::Value =
        serde_json::from_str(&event::encode_batch(&events).unwrap()).unwrap();
    assert_eq!(json["events"][0]["record_type"], "identify");
    assert_eq!(json["events"][0]["traits"]["paid"], true);
    assert_eq!(json["events"][0]["increments"]["credits"], -2.0);
    assert_eq!(json["events"][1]["traits"]["seats"], 10);
    for invalid in [
        Event::identify("server", ""),
        Event::group("server", "bad type", "id"),
        Event::identify("server", "id").increment("credits", f64::INFINITY),
        Event::new("ordinary", "server").trait_value("private", "value"),
    ] {
        assert!(event::encode_batch(&[invalid]).is_err());
    }
}

#[test]
fn retries_preserve_bytes_and_return_durable_ack() {
    let mock = Mock::new(vec![
        response(503, "busy"),
        response(200, r#"{"duplicates":1,"accepted":0}"#),
    ]);
    let client = client(mock);
    let event = event()
        .property("version", "1")
        .property("success", true)
        .property("duration_ms", 12.5);
    assert_eq!(
        run(client.send(&event)).unwrap(),
        Ack {
            accepted: 0,
            duplicates: 1
        }
    );
    let bodies = client.transport.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert!(bodies[0].contains(r#""duration_ms":12.5,"success":true,"version":"1""#));
    assert!(!bodies[0].contains("actor_id"));
}

#[test]
fn network_errors_retry_but_permanent_failures_do_not() {
    let client = client(Mock::new(vec![
        Err(Error::Transport("offline".into())),
        response(200, r#"{"accepted":1,"duplicates":0}"#),
    ]));
    run(client.send(&event())).unwrap();
    for status in [301, 307, 400, 401, 403, 413, 422] {
        let client = super::tests::client(Mock::new(vec![response(status, "rejected")]));
        assert!(
            matches!(run(client.send(&event())), Err(Error::Http { status: s, .. }) if s == status)
        );
        assert_eq!(client.transport.bodies.lock().unwrap().len(), 1);
    }
}

#[test]
fn retry_after_is_respected_and_cannot_extend_budget() {
    for seconds in [0, 10] {
        let client = client(Mock::new(vec![
            Ok(Response {
                status: 429,
                body: "busy".into(),
                retry_after: Some(Duration::from_secs(seconds)),
            }),
            response(200, r#"{"accepted":1,"duplicates":0}"#),
        ]));
        let result = run(client.send(&event()));
        if seconds == 0 {
            assert!(result.is_ok());
            assert_eq!(
                *client.transport.sleeps.lock().unwrap(),
                vec![Duration::from_millis(50)]
            );
        } else {
            assert!(matches!(result, Err(Error::Http { status: 429, .. })));
            assert!(client.transport.sleeps.lock().unwrap().is_empty());
            assert_eq!(client.transport.bodies.lock().unwrap().len(), 1);
        }
    }
}

#[test]
fn invalid_acknowledgments_are_not_success_or_retried() {
    for body in [
        "null",
        "{}",
        r#"{"accepted":2,"duplicates":0}"#,
        r#"{"accepted":1,"accepted":1,"duplicates":0}"#,
        r#"{"accepted":-1,"duplicates":2}"#,
        r#"{"accepted":1.0,"duplicates":0}"#,
        r#"{"accepted":01,"duplicates":0}"#,
        r#"{"accepted":1,"duplicates":0} trailing"#,
    ] {
        let client = client(Mock::new(vec![response(200, body)]));
        assert!(
            matches!(run(client.send(&event())), Err(Error::InvalidAck)),
            "{body}"
        );
        assert_eq!(client.transport.bodies.lock().unwrap().len(), 1);
    }
    assert_eq!(
        parse_ack(" \n{\"duplicates\" : 0, \"accepted\" : 1 }\r\n"),
        Some(Ack {
            accepted: 1,
            duplicates: 0
        })
    );
}

#[test]
fn validation_prevents_requests_and_preserves_scalar_types() {
    let client = client(Mock::default());
    assert!(run(client.send_batch(&[])).is_err());
    assert!(run(client.send_batch(&vec![event(); 101])).is_err());
    for invalid in [
        Event::new("", "cli"),
        event().property("bad key", true),
        event().property("nan", f64::NAN),
        event().property("large", "x".repeat(2049)),
    ] {
        assert!(run(client.send(&invalid)).is_err());
    }
    let mut invalid = event();
    invalid.actor_id = Some("id".into());
    assert!(run(client.send(&invalid)).is_err());
    invalid.identity_kind = Some(IdentityKind::Installation);
    invalid.session_id = Some("session".into());
    assert!(run(client.send(&invalid)).is_err());
    assert!(client.transport.bodies.lock().unwrap().is_empty());
    let encoded = event::encode_batch(&[event()
        .property("signed", i64::MIN)
        .property("unsigned", u64::MAX)
        .property("text", "\"\\\n\t\0東京")])
    .unwrap();
    assert!(encoded.contains("-9223372036854775808"));
    assert!(encoded.contains("18446744073709551615"));
    let parsed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(parsed["events"][0]["properties"]["text"], "\"\\\n\t\0東京");
}

#[test]
fn event_defaults_and_json_round_trip_preserve_identity_and_types() {
    let first = event();
    let second = event();
    assert_ne!(first.event_id, second.event_id);
    assert!(uuid::Uuid::parse_str(&first.event_id).is_ok());
    let mut event = first
        .property("text", "\"\\\n\t\0東京")
        .property("count", u64::MAX)
        .property("success", true);
    event.timestamp = chrono::DateTime::from_timestamp(1_709_251_199, 123_000_000).unwrap();
    event.actor_id = Some("opaque-visitor".into());
    event.identity_kind = Some(IdentityKind::Visitor);
    event.session_id = Some("session".into());
    let body: serde_json::Value =
        serde_json::from_str(&event::encode_batch(&[event]).unwrap()).unwrap();
    assert_eq!(body["events"][0]["timestamp"], "2024-02-29T23:59:59.123Z");
    assert_eq!(body["events"][0]["identity_kind"], "visitor");
    assert_eq!(
        body["events"][0]["properties"]["count"].as_u64(),
        Some(u64::MAX)
    );
    assert_eq!(body["events"][0]["properties"]["text"], "\"\\\n\t\0東京");
    assert_eq!(body["events"][0]["properties"]["success"], true);
}

#[test]
fn total_deadline_includes_transport_and_backoff() {
    struct Slow;
    impl Transport for Slow {
        async fn post(&self, _: Request<'_>) -> Result<Response, Error> {
            std::thread::sleep(Duration::from_millis(15));
            response(200, r#"{"accepted":1,"duplicates":0}"#)
        }
        async fn sleep(&self, _: Duration) {
            panic!("must not retry after deadline");
        }
    }
    let client = Highkey::with_transport_options(
        "https://highkey.example",
        "pk_test",
        Slow,
        Options {
            timeout: Duration::from_millis(1),
            retries: 10,
        },
    )
    .unwrap();
    assert!(matches!(run(client.send(&event())), Err(Error::Timeout)));
}

#[test]
fn invalid_configuration_and_oversized_batches_fail_locally() {
    for endpoint in [
        "",
        "ftp://example.com",
        "https://",
        "https://example:bad-port",
        "https://a@b",
        "https://example/?q=1",
        "https://example/#fragment",
        "https://example/\r\n",
    ] {
        assert!(Highkey::with_transport(endpoint, "key", Mock::default()).is_err());
    }
    assert!(Highkey::with_transport("https://example", "\r\n", Mock::default()).is_err());
    let mut big = event();
    for n in 0..32 {
        big.properties
            .insert(format!("k{n}"), "x".repeat(2048).into());
    }
    assert!(event::encode_batch(&vec![big; 5]).is_err());
    assert!(event::encode_batch(&vec![event(); 100]).is_ok());
}

#[test]
fn a_503_retry_after_longer_than_the_budget_is_shortened_to_fit() {
    let client = client(Mock::new(vec![
        Ok(Response {
            status: 503,
            body: "busy".into(),
            retry_after: Some(Duration::from_secs(1)),
        }),
        response(200, r#"{"accepted":1,"duplicates":0}"#),
    ]));
    assert!(run(client.send(&event())).is_ok());
    let sleeps = client.transport.sleeps.lock().unwrap().clone();
    assert_eq!(sleeps.len(), 1);
    // Half of what remains of the 800 ms budget, so the retry has time to finish.
    assert!(sleeps[0] > Duration::from_millis(300) && sleeps[0] <= Duration::from_millis(400));
}
