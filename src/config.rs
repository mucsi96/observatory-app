use std::{collections::HashSet, path::Path, sync::LazyLock};

use anyhow::{Context, bail};
use regex::Regex;
use serde::Deserialize;
use url::Url;

use crate::model::Application;

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub environment: String,
    pub apps: Vec<Application>,
}

pub async fn load(path: impl AsRef<Path>) -> anyhow::Result<Config> {
    let bytes = tokio::fs::read(path).await.context("read configuration")?;
    let config: Config = serde_json::from_slice(&bytes).context("parse configuration")?;
    validate(&config)?;
    Ok(config)
}

pub fn validate(config: &Config) -> anyhow::Result<()> {
    static NAMESPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$").unwrap());
    static REPOSITORY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
    static WORKFLOW: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+\.ya?ml$").unwrap());

    if config.environment.trim().is_empty() || config.apps.is_empty() {
        bail!("environment and apps are required");
    }
    let mut namespaces = HashSet::new();
    for app in &config.apps {
        let valid_url = Url::parse(&app.url).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        });
        if app.name.trim().is_empty()
            || app.namespace.len() > 63
            || !NAMESPACE.is_match(&app.namespace)
            || !namespaces.insert(&app.namespace)
            || (!app.repository.is_empty() && !REPOSITORY.is_match(&app.repository))
            || (!app.deployment_workflow.is_empty() && !WORKFLOW.is_match(&app.deployment_workflow))
            || [&app.stack.frontend, &app.stack.backend]
                .into_iter()
                .flatten()
                .any(|label| label.trim().is_empty() || label.len() > 120)
            || !valid_url
        {
            bail!("invalid app configuration: {:?}", app.name);
        }
    }
    Ok(())
}

pub fn https_endpoint(value: &str) -> anyhow::Result<Url> {
    let url = Url::parse(value).context("invalid upstream endpoint")?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "upstream endpoints must use HTTPS without credentials, query strings, or fragments"
    );
    Ok(url)
}
