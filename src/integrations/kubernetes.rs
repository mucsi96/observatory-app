use std::{path::Path, time::Duration};

use k8s_openapi::api::apps::v1::Deployment;
use kube::{Api, Client, Config, api::ListParams};

use crate::{
    error::IntegrationError,
    model::{Health, Workload, WorkloadStatus},
};

pub fn client(
    endpoint: Option<&str>,
    ca_file: Option<&Path>,
    token_file: Option<&Path>,
) -> anyhow::Result<Option<Client>> {
    // Local development must not accidentally query the user's kubeconfig.
    let mut config = if let Some(endpoint) = endpoint {
        let url = crate::config::https_endpoint(endpoint)?;
        let mut config = Config::new(url.as_str().parse()?);
        config.root_cert_file = Some(
            ca_file
                .unwrap_or(Path::new(
                    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
                ))
                .to_owned(),
        );
        config.auth_info.token_file = Some(
            token_file
                .unwrap_or(Path::new(
                    "/var/run/secrets/kubernetes.io/serviceaccount/token",
                ))
                .to_string_lossy()
                .into_owned(),
        );
        config
    } else {
        if !Path::new("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt").exists() {
            return Ok(None);
        }
        Config::incluster()?
    };
    config.connect_timeout = Some(Duration::from_secs(10));
    config.read_timeout = Some(Duration::from_secs(10));
    Ok(Some(Client::try_from(config)?))
}

pub async fn collect(
    client: &Option<Client>,
    namespace: &str,
) -> Result<(Health, Vec<Workload>), IntegrationError> {
    let client = client.clone().ok_or(IntegrationError::NotInCluster)?;
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
