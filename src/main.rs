use std::{env, future::IntoFuture, path::Path, time::Duration};

use anyhow::Context;
use observatory::{
    collector, config,
    integrations::{github, kubernetes},
    web,
};
use tokio::{net::TcpListener, sync::watch};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("observatory=info,tower_http=info")),
        )
        .init();
    let config =
        config::load(env::var("CONFIG_FILE").unwrap_or_else(|_| "config.json".into())).await?;
    let kube_url = env::var("KUBERNETES_API_URL").ok();
    let kube_ca = env::var("KUBERNETES_CA_FILE").ok();
    let kube_token = env::var("KUBERNETES_TOKEN_FILE").ok();
    let kube = kubernetes::client(
        kube_url.as_deref(),
        kube_ca.as_deref().map(Path::new),
        kube_token.as_deref().map(Path::new),
    )?;
    let github_ca = env::var("GITHUB_CA_FILE").ok();
    let github = github::client(
        &env::var("GITHUB_API_URL").unwrap_or_else(|_| "https://api.github.com".into()),
        env::var("GITHUB_TOKEN").unwrap_or_default(),
        github_ca.as_deref().map(Path::new),
    )?;
    let addr = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let addr = if addr.starts_with(':') {
        format!("0.0.0.0{addr}")
    } else {
        addr
    };
    let listener = TcpListener::bind(&addr)
        .await
        .context("bind HTTP listener")?;
    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "frontend/dist".into());
    anyhow::ensure!(
        std::path::Path::new(&static_dir)
            .join("index.html")
            .is_file(),
        "frontend build missing; run npm ci && npm run build in frontend/"
    );
    let (sender, snapshots) = watch::channel(None);
    let stop = CancellationToken::new();
    let collection = tokio::spawn(collector::run(config, kube, github, sender, stop.clone()));
    let shutdown_token = stop.clone();
    let signals = tokio::spawn(async move {
        shutdown_signal().await;
        shutdown_token.cancel();
    });
    tracing::info!(%addr, "Observatory listening");
    let server = axum::serve(listener, web::router(snapshots, static_dir))
        .with_graceful_shutdown(stop.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result,
        _ = stop.cancelled() => {
            tokio::time::timeout(Duration::from_secs(10), &mut server).await
                .unwrap_or_else(|_| {
                    tracing::warn!("HTTP shutdown deadline exceeded");
                    Ok(())
                })
        }
    };
    stop.cancel();
    signals.abort();
    tokio::time::timeout(Duration::from_secs(10), collection)
        .await
        .context("stop collector")??;
    result.context("serve HTTP")
}

async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = interrupt => {}, _ = terminate => {} }
}
