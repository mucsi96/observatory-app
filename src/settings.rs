use std::{env, path::PathBuf};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};

/// Application settings in Loco's `settings` block. Deployed environment variables
/// take precedence; secret contents are read only when constructing the clients.
#[derive(Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub inventory: PathBuf,
    pub oidc_issuer: String,
    pub api_client_id: String,
    pub github_api_url: String,
    pub github_ca_file: Option<PathBuf>,
    pub github_token_file: Option<PathBuf>,
    pub kubernetes_api_url: Option<String>,
    pub kubernetes_ca_file: Option<PathBuf>,
    pub kubernetes_token_file: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            inventory: "config.json".into(),
            oidc_issuer: String::new(),
            api_client_id: String::new(),
            github_api_url: "https://api.github.com".into(),
            github_ca_file: None,
            github_token_file: None,
            kubernetes_api_url: None,
            kubernetes_ca_file: None,
            kubernetes_token_file: None,
        }
    }
}

impl Settings {
    pub fn from_config(config: &loco_rs::config::Config) -> anyhow::Result<Self> {
        let mut settings: Self = config.settings()?;
        if let Ok(value) = env::var("CONFIG_FILE") {
            settings.inventory = value.into();
        }
        if let Ok(value) = env::var("OIDC_ISSUER") {
            settings.oidc_issuer = value;
        }
        if let Ok(value) = env::var("API_CLIENT_ID") {
            settings.api_client_id = value;
        }
        if let Ok(value) = env::var("GITHUB_API_URL") {
            settings.github_api_url = value;
        }
        if let Ok(value) = env::var("GITHUB_CA_FILE") {
            settings.github_ca_file = Some(value.into());
        }
        if let Ok(value) = env::var("GITHUB_TOKEN_FILE") {
            settings.github_token_file = Some(value.into());
        }
        if let Ok(value) = env::var("KUBERNETES_API_URL") {
            settings.kubernetes_api_url = Some(value);
        }
        if let Ok(value) = env::var("KUBERNETES_CA_FILE") {
            settings.kubernetes_ca_file = Some(value.into());
        }
        if let Ok(value) = env::var("KUBERNETES_TOKEN_FILE") {
            settings.kubernetes_token_file = Some(value.into());
        }
        ensure!(
            !settings.oidc_issuer.trim().is_empty(),
            "OIDC_ISSUER is required"
        );
        ensure!(
            !settings.api_client_id.trim().is_empty(),
            "API_CLIENT_ID is required"
        );
        crate::config::https_endpoint(&settings.github_api_url)?;
        if let Some(url) = &settings.kubernetes_api_url {
            crate::config::https_endpoint(url)?;
        }
        Ok(settings)
    }

    pub async fn github_token(&self) -> anyhow::Result<String> {
        match &self.github_token_file {
            Some(path) => tokio::fs::read_to_string(path)
                .await
                .context("read GitHub token file"),
            None => Ok(env::var("GITHUB_TOKEN").unwrap_or_default()),
        }
    }
}
