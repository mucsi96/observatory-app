use std::{collections::HashSet, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    config::Config,
    error::IntegrationError,
    integrations::github::{self, GitHubClient},
};

#[derive(Clone)]
pub struct Issues {
    repositories: Arc<HashSet<String>>,
    github: GitHubClient,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewIssue {
    repository: String,
    title: String,
    description: String,
}

#[derive(Serialize)]
pub struct CreatedIssue {
    number: u64,
    url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IssueError {
    #[error("Select a configured application repository.")]
    Repository,
    #[error("Provide a title of 1–256 characters and a description of at most 64 KiB.")]
    Payload,
    #[error(
        "Issue creation is not configured. Ask an administrator to configure a GitHub token with Issues write permission."
    )]
    Unconfigured,
    #[error(
        "GitHub denied issue creation. Ask an administrator to check token access, Issues write permission, and whether issues are enabled."
    )]
    Denied,
    #[error("GitHub rejected the issue. Check the title and description.")]
    Rejected,
    #[error("GitHub rate limit reached. Try again later.")]
    RateLimited,
    #[error(
        "Could not confirm issue creation. Check the repository before trying again to avoid a duplicate."
    )]
    Unconfirmed,
}

impl Issues {
    pub fn new(config: &Config, github: GitHubClient) -> Self {
        Self {
            repositories: Arc::new(
                config
                    .apps
                    .iter()
                    .map(|app| app.repository.clone())
                    .filter(|repo| !repo.is_empty())
                    .collect(),
            ),
            github,
        }
    }

    pub async fn create(&self, issue: NewIssue) -> Result<CreatedIssue, IssueError> {
        if !self.repositories.contains(&issue.repository)
            || issue
                .repository
                .split('/')
                .any(|part| part == "." || part == "..")
        {
            return Err(IssueError::Repository);
        }
        let title = issue.title.trim();
        if title.is_empty() || title.chars().count() > 256 || issue.description.len() > 65536 {
            return Err(IssueError::Payload);
        }
        let number =
            github::create_issue(&self.github, &issue.repository, title, &issue.description)
                .await
                .map_err(|error| match error {
                    IntegrationError::MissingGithubToken => IssueError::Unconfigured,
                    IntegrationError::Http(401 | 403 | 404 | 410) => IssueError::Denied,
                    IntegrationError::Http(422) => IssueError::Rejected,
                    IntegrationError::Http(429) => IssueError::RateLimited,
                    _ => IssueError::Unconfirmed,
                })?;
        Ok(CreatedIssue {
            number,
            url: format!("https://github.com/{}/issues/{number}", issue.repository),
        })
    }
}
