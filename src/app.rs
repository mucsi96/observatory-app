use std::{env, future::IntoFuture, time::Duration};

use async_trait::async_trait;
use axum::{Extension, Router};
use loco_rs::{
    Result,
    app::{AppContext, Hooks},
    bgworker::Queue,
    boot::{self, BootResult, ServeParams, StartMode},
    config::Config,
    controller::AppRoutes,
    environment::Environment,
    task::Tasks,
};

use crate::{
    auth::Auth,
    config, controllers,
    integrations::{github, kubernetes},
    services::{
        fleet::{Collection, Fleet},
        issues::Issues,
    },
    settings::Settings,
};

pub struct App;

#[async_trait]
impl Hooks for App {
    fn app_name() -> &'static str {
        env!("CARGO_PKG_NAME")
    }

    fn app_version() -> String {
        env!("CARGO_PKG_VERSION").into()
    }

    async fn load_config(environment: &Environment) -> Result<Config> {
        let mut config = environment.load()?;
        // Preserve the chart's existing address contract, including :8080.
        if let Ok(addr) = env::var("LISTEN_ADDR") {
            let addr = if addr.starts_with(':') {
                format!("0.0.0.0{addr}")
            } else {
                addr
            };
            let (binding, port) = addr.rsplit_once(':').ok_or_else(|| {
                loco_rs::Error::Message("LISTEN_ADDR must contain a host and port".into())
            })?;
            config.server.binding = binding.into();
            config.server.port = port.parse().map_err(loco_rs::Error::wrap)?;
        }
        let settings = Settings::from_config(&config).map_err(|e| loco_rs::Error::Any(e.into()))?;
        config.settings = Some(serde_json::to_value(settings)?);
        Ok(config)
    }

    async fn boot(
        mode: StartMode,
        environment: &Environment,
        config: Config,
    ) -> Result<BootResult> {
        boot::create_app::<Self>(mode, environment, config).await
    }

    async fn after_context(ctx: AppContext) -> Result<AppContext> {
        let settings: Settings = ctx.config.settings()?;
        let auth = Auth::new(settings.oidc_issuer.clone(), settings.api_client_id.clone())
            .await
            .map_err(|e| loco_rs::Error::Any(e.into()))?;
        ctx.shared_store.insert(auth);
        Ok(ctx)
    }

    fn routes(ctx: &AppContext) -> AppRoutes {
        AppRoutes::empty().add_route(controllers::routes(
            ctx.shared_store.get::<Auth>().expect("auth initialized"),
        ))
    }

    async fn after_routes(router: Router, _ctx: &AppContext) -> Result<Router> {
        Ok(controllers::middleware(router))
    }

    async fn serve(router: Router, ctx: &AppContext, params: &ServeParams) -> Result<()> {
        let settings: Settings = ctx.config.settings()?;
        let inventory = config::load(&settings.inventory)
            .await
            .map_err(|e| loco_rs::Error::Any(e.into()))?;
        let kube = kubernetes::client(
            settings.kubernetes_api_url.as_deref(),
            settings.kubernetes_ca_file.as_deref(),
            settings.kubernetes_token_file.as_deref(),
        )
        .map_err(|e| loco_rs::Error::Any(e.into()))?;
        let github = github::client(
            &settings.github_api_url,
            settings
                .github_token()
                .await
                .map_err(|e| loco_rs::Error::Any(e.into()))?,
            settings.github_ca_file.as_deref(),
        )
        .map_err(|e| loco_rs::Error::Any(e.into()))?;
        let listener =
            tokio::net::TcpListener::bind(format!("{}:{}", params.binding, params.port)).await?;
        let issues = Issues::new(&inventory, github.clone());
        let (collection, snapshots) = Collection::start(inventory, kube, github);
        let refresh = collection.refresh.clone();
        ctx.shared_store.insert(collection);
        let router = router.layer(Extension(Fleet {
            snapshots,
            issues,
            refresh,
        }));
        let shutdown = tokio_util::sync::CancellationToken::new();
        let signal = shutdown.clone();
        let signals = tokio::spawn(async move {
            boot::shutdown_signal().await;
            signal.cancel();
        });
        let server = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.clone().cancelled_owned())
            .into_future();
        tokio::pin!(server);
        tracing::info!(binding = %params.binding, port = params.port, "Observatory listening");
        let result = tokio::select! {
            result = &mut server => result,
            _ = shutdown.cancelled() => {
                Self::on_shutdown(ctx).await;
                tokio::time::timeout(Duration::from_secs(10), &mut server).await
                    .unwrap_or_else(|_| {
                        tracing::warn!("HTTP shutdown deadline exceeded");
                        Ok(())
                    })
            }
        };
        signals.abort();
        Self::on_shutdown(ctx).await;
        result.map_err(loco_rs::Error::from)
    }

    async fn on_shutdown(ctx: &AppContext) {
        if let Some(collection) = ctx.shared_store.remove::<Collection>() {
            collection.shutdown().await;
        }
    }

    async fn connect_workers(_ctx: &AppContext, _queue: &Queue) -> Result<()> {
        Ok(())
    }
    fn register_tasks(_tasks: &mut Tasks) {}
}
