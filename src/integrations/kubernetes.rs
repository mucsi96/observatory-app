use std::time::Duration;

use k8s_openapi::api::apps::v1::Deployment;
use kube::{Api, Client, Config, api::ListParams};

use crate::{
    error::IntegrationError,
    model::{Health, Workload, WorkloadStatus},
};

#[derive(Clone)]
pub struct Kubernetes {
    client: Option<Client>,
}

impl Kubernetes {
    pub fn in_cluster() -> anyhow::Result<Self> {
        // Local development must not accidentally query the user's kubeconfig.
        if !std::path::Path::new("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").exists() {
            return Ok(Self { client: None });
        }
        let mut config = Config::incluster()?;
        config.connect_timeout = Some(Duration::from_secs(10));
        config.read_timeout = Some(Duration::from_secs(10));
        Ok(Self {
            client: Some(Client::try_from(config)?),
        })
    }

    pub fn new(client: Option<Client>) -> Self {
        Self { client }
    }

    pub async fn collect(
        &self,
        namespace: &str,
    ) -> Result<(Health, Vec<Workload>), IntegrationError> {
        let client = self.client.clone().ok_or(IntegrationError::NotInCluster)?;
        let deployments: Api<Deployment> = Api::namespaced(client, namespace);
        let mut workloads = Vec::new();
        let mut params = ListParams::default().limit(100);
        loop {
            let page = deployments.list(&params).await?;
            workloads.extend(page.items.into_iter().map(workload));
            match page.metadata.continue_.filter(|token| !token.is_empty()) {
                Some(token) => params = params.continue_token(&token),
                None => break,
            }
        }
        let health = if workloads.is_empty() {
            Health::NotDeployed
        } else if workloads
            .iter()
            .any(|w| w.status == WorkloadStatus::Unhealthy)
        {
            Health::Unhealthy
        } else if workloads
            .iter()
            .any(|w| w.status != WorkloadStatus::Healthy)
        {
            Health::Degraded
        } else {
            Health::Healthy
        };
        Ok((health, workloads))
    }
}

pub fn workload(deployment: Deployment) -> Workload {
    let spec = deployment.spec.unwrap_or_default();
    let status = deployment.status.unwrap_or_default();
    let desired = spec.replicas.unwrap_or(1);
    let ready = status.available_replicas.unwrap_or_default();
    let mut state = WorkloadStatus::Deploying;

    if status.observed_generation.unwrap_or_default()
        >= deployment.metadata.generation.unwrap_or_default()
    {
        if desired == 0 {
            state = WorkloadStatus::ScaledDown;
        } else if ready >= desired
            && status.updated_replicas.unwrap_or_default() == desired
            && status.replicas.unwrap_or_default() == desired
        {
            state = WorkloadStatus::Healthy;
        }
        if status
            .conditions
            .unwrap_or_default()
            .iter()
            .any(|condition| {
                (condition.type_ == "Progressing" && condition.status == "False")
                    || (condition.type_ == "ReplicaFailure" && condition.status == "True")
            })
        {
            state = WorkloadStatus::Unhealthy;
        }
    }

    Workload {
        name: deployment.metadata.name.unwrap_or_default(),
        images: spec
            .template
            .spec
            .map(|pod| {
                pod.containers
                    .into_iter()
                    .map(|c| c.image.unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default(),
        ready,
        desired,
        status: state,
    }
}
