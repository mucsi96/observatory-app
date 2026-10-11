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

impl Config {
    pub async fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let bytes = tokio::fs::read(path).await.context("read configuration")?;
        let config: Self = serde_json::from_slice(&bytes).context("parse configuration")?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        static NAMESPACE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$").unwrap());
        static REPOSITORY: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").unwrap());
        static WORKFLOW: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+\.ya?ml$").unwrap());

        if self.environment.trim().is_empty() || self.apps.is_empty() {
            bail!("environment and apps are required");
        }
        let mut namespaces = HashSet::new();
        for app in &self.apps {
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
                || (!app.deployment_workflow.is_empty()
                    && !WORKFLOW.is_match(&app.deployment_workflow))
                || !valid_url
            {
                bail!("invalid app configuration: {:?}", app.name);
            }
        }
        Ok(())
    }
}
