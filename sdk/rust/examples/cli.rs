//! A CLI that reports each command run, best effort and bounded: delivery has an 800 ms budget
//! (`PIKO_TELEMETRY_TIMEOUT_MS`, 1–5000), all attempts included, and never fails the command.
//! It sends only with explicit opt-in: `PIKO_TELEMETRY=1`, an endpoint and a key, and not
//! `DO_NOT_TRACK=1`. No installation ID is created; set `PIKO_INSTALLATION_ID` only to a random
//! ID chosen under your application's telemetry preference.
//!
//! ```sh
//! PIKO_TELEMETRY=1 PIKO_ENDPOINT=http://127.0.0.1:3001 PIKO_INGESTION_KEY=pk_… \
//!   cargo run -p piko-sdk --example cli -- build
//! ```
use piko_sdk::{Event, IdentityKind, Options, Piko};
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    let command = std::env::args().nth(1).unwrap_or_else(|| "build".into());
    let start = Instant::now();
    // Your actual command runs here, independently of telemetry configuration.
    tokio::time::sleep(Duration::from_millis(75)).await;
    let success = command != "fail";
    println!("{command}: {}", if success { "complete" } else { "failed" });
    if std::env::var("PIKO_TELEMETRY").as_deref() == Ok("1")
        && std::env::var("DO_NOT_TRACK").as_deref() != Ok("1")
        && let (Ok(endpoint), Ok(key)) = (
            std::env::var("PIKO_ENDPOINT"),
            std::env::var("PIKO_INGESTION_KEY"),
        )
        && !endpoint.trim().is_empty()
        && !key.trim().is_empty()
    {
        let timeout = Duration::from_millis(
            std::env::var("PIKO_TELEMETRY_TIMEOUT_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(800)
                .clamp(1, 5000),
        );
        let options = Options {
            timeout,
            ..Options::default()
        };
        if let Ok(client) = Piko::with_options(endpoint, key, options) {
            let name = match command.as_str() {
                "build" | "fail" | "check" | "init" | "dev" | "deploy" => command.as_str(),
                _ => "other",
            };
            let mut event = Event::new("command_run", "cli")
                .property("command", name)
                .property("version", env!("CARGO_PKG_VERSION"))
                .property("os", std::env::consts::OS)
                .property("arch", std::env::consts::ARCH)
                .property("success", success)
                .property("duration_ms", start.elapsed().as_millis() as u64);
            if let Some(id) = std::env::var("PIKO_INSTALLATION_ID")
                .ok()
                .filter(|id| !id.is_empty())
            {
                event.actor_id = Some(id);
                event.identity_kind = Some(IdentityKind::Installation);
            }
            // Analytics is best effort for the application; a failed send never fails its work.
            let _ = client.send(&event).await;
        }
    }
    if !success {
        std::process::exit(1);
    }
}
