use piko_ingest::{Config, changes::ChangeDelivery, router, start};
use std::env;

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "piko_ingest=info".into()),
        )
        .init();
    let managed = ["TAKO_DATA_DIR", "TAKO_BUILD", "TAKO_BOOTSTRAP_DATA"]
        .iter()
        .any(|name| env::var_os(name).is_some());
    // Bootstrap owns fd 3 in Tako. Read it before Tokio can allocate its own I/O
    // descriptor there, and never inspect inherited descriptors in standalone mode.
    if managed {
        tako::bootstrap()?;
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(managed))
}

fn secret(managed: bool, name: &str) -> Option<String> {
    if managed {
        tako::secret(name).or_else(|| env::var(name).ok())
    } else {
        env::var(name).ok()
    }
}

async fn run(managed: bool) -> anyhow::Result<()> {
    let delivery = env::var("PIKO_CHANGE_URL")
        .ok()
        .map(|url| {
            ChangeDelivery::new(
                &url,
                secret(managed, "PIKO_CHANGE_TOKEN").unwrap_or_default(),
            )
        })
        .transpose()?;
    let mut config = Config::from_env()?;
    if managed {
        config.clickhouse.password =
            piko_ingest::config::ingest_password(|name| secret(managed, name));
    }
    let state = start(config).await?;
    let notifications = delivery
        .map(|delivery| state.changes.start_delivery(delivery))
        .transpose()?;
    let listener = if managed {
        tako::listener().await?
    } else {
        let address = env::var("PIKO_BIND").unwrap_or_else(|_| "127.0.0.1:3001".into());
        tokio::net::TcpListener::bind(&address).await?
    };
    tracing::info!(address = %listener.local_addr()?, managed, "Piko ingest is ready");
    let app = router(state.clone());
    let app = if managed {
        tako::axum::router(app)
    } else {
        app
    };
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await;
    if let Some(notifications) = notifications {
        notifications.abort();
    }
    result?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
