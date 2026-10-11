use std::{sync::Arc, time::Duration};

use chrono::Utc;
use futures::{StreamExt, stream};
use kube::Client;
use tokio::{
    sync::watch,
    time::{Instant, sleep, timeout_at},
};
use tokio_util::sync::CancellationToken;

use crate::{
    config::Config,
    error::IntegrationError,
    integrations::{
        github::{self, GitHubClient},
        kubernetes,
    },
    model::{Application, ApplicationSignals, Snapshot, empty_signals},
};

pub const COLLECTION_DEADLINE: Duration = Duration::from_secs(50);
pub const COLLECTION_INTERVAL: Duration = Duration::from_secs(60);
pub type SnapshotReceiver = watch::Receiver<Option<Arc<Snapshot>>>;

pub async fn collect(
    config: &Config,
    kube: &Option<Client>,
    github: &GitHubClient,
    budget: Duration,
) -> Snapshot {
    let deadline = Instant::now() + budget;
    let mut results: Vec<_> = stream::iter(config.apps.iter().cloned().enumerate())
        .map(|(index, app)| async move { (index, application(app, kube, github, deadline).await) })
        .buffer_unordered(4)
        .collect()
        .await;
    results.sort_by_key(|(index, _)| *index);
    Snapshot {
        environment: config.environment.clone(),
        updated_at: Utc::now(),
        apps: results.into_iter().map(|(_, result)| result).collect(),
    }
}

async fn application(
    app: Application,
    kube: &Option<Client>,
    github: &GitHubClient,
    deadline: Instant,
) -> ApplicationSignals {
    let mut result = empty_signals(app);
    let cluster = async {
        timeout_at(
            deadline,
            kubernetes::collect(kube, &result.application.namespace),
        )
        .await
        .unwrap_or(Err(IntegrationError::Deadline))
    };
    let repository = async {
        if result.application.repository.is_empty() {
            return None;
        }
        Some(
            timeout_at(
                deadline,
                github::repository(
                    github,
                    &result.application.repository,
                    &result.application.deployment_workflow,
                ),
            )
            .await
            .unwrap_or(Err(IntegrationError::Deadline)),
        )
    };
    let (cluster, repository) = tokio::join!(cluster, repository);
    match cluster {
        Ok((health, workloads)) => {
            result.health = health;
            result.workloads = workloads;
        }
        Err(error) => result.errors.push(format!("Kubernetes: {error}")),
    }
    if let Some(repository) = repository {
        match repository {
            Ok(mut data) => {
                if let Err(error) = timeout_at(
                    deadline,
                    github::dependency_update(
                        github,
                        &result.application.repository,
                        &mut data.dependency_update,
                    ),
                )
                .await
                .unwrap_or(Err(IntegrationError::Deadline))
                {
                    let message = format!("Dependency updates: {error}");
                    data.dependency_update.error = Some(message.clone());
                    result.errors.push(message);
                }
                result.repository_data = Some(data);
            }
            Err(error) => result.errors.push(format!("GitHub: {error}")),
        }
    }
    result
}

pub async fn run(
    config: Config,
    kube: Option<Client>,
    github: GitHubClient,
    snapshots: watch::Sender<Option<Arc<Snapshot>>>,
    stop: CancellationToken,
) {
    loop {
        let snapshot = tokio::select! {
            _ = stop.cancelled() => break,
            snapshot = collect(&config, &kube, &github, COLLECTION_DEADLINE) => snapshot,
        };
        tracing::info!(apps = snapshot.apps.len(), "fleet snapshot collected");
        snapshots.send_replace(Some(Arc::new(snapshot)));
        tokio::select! {
            _ = stop.cancelled() => break,
            _ = sleep(COLLECTION_INTERVAL) => {}
        }
    }
}
