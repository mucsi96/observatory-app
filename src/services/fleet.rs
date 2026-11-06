use std::{sync::Arc, time::Duration};

use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    collector::{self, SnapshotReceiver},
    config::Config,
    integrations::github::GitHubClient,
};

/// One collector per HTTP process, sharing immutable snapshots with all readers.
pub struct Collection {
    pub refresh: mpsc::Sender<oneshot::Sender<Arc<crate::model::Snapshot>>>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

impl Collection {
    pub fn start(
        inventory: Config,
        kube: Option<kube::Client>,
        github: GitHubClient,
    ) -> (Self, SnapshotReceiver) {
        let (sender, receiver) = watch::channel(None);
        let stop = CancellationToken::new();
        let (refresh, requests) = mpsc::channel(32);
        let task = tokio::spawn(collector::run(
            inventory,
            kube,
            github,
            sender,
            stop.clone(),
            requests,
        ));
        (
            Self {
                stop,
                task,
                refresh,
            },
            receiver,
        )
    }

    pub async fn shutdown(mut self) {
        self.stop.cancel();
        match tokio::time::timeout(Duration::from_secs(10), &mut self.task).await {
            Ok(Ok(())) => tracing::info!("fleet collector stopped"),
            Ok(Err(error)) => tracing::error!(%error, "fleet collector failed"),
            Err(_) => tracing::warn!("collector shutdown deadline exceeded"),
        }
    }
}

impl Drop for Collection {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}

#[derive(Clone)]
pub struct Fleet {
    pub refresh: mpsc::Sender<oneshot::Sender<Arc<crate::model::Snapshot>>>,
    pub snapshots: SnapshotReceiver,
    pub issues: super::issues::Issues,
}

impl Fleet {
    pub fn snapshot(&self) -> Option<Arc<crate::model::Snapshot>> {
        self.snapshots.borrow().clone()
    }
}
