use chrono::{DateTime, Utc};

use super::{GitHubClient, Runs, get};
use crate::{
    error::IntegrationError,
    model::{Health, WorkflowRun},
};

pub async fn collect(
    client: &GitHubClient,
    repository: &str,
) -> Result<Option<WorkflowRun>, IntegrationError> {
    let runs: Runs = get(
        client,
        &format!("/repos/{repository}/actions/workflows/application_health.yml/runs"),
        &[("branch", "main".into()), ("per_page", "1".into())],
    )
    .await?;
    Ok(runs
        .workflow_runs
        .into_iter()
        .next()
        .map(|run| WorkflowRun {
            status: if run.status == "completed" {
                run.conclusion.unwrap_or_else(|| "unknown".into())
            } else {
                run.status
            },
            url: run.html_url,
            updated_at: run.updated_at,
        }))
}

pub fn health(workload: Health, run: Option<&WorkflowRun>) -> Health {
    let browser = run
        .and_then(|run| {
            let timestamp = DateTime::parse_from_rfc3339(&run.updated_at).ok()?;
            let age = Utc::now().signed_duration_since(timestamp);
            if age < chrono::Duration::zero() || age >= chrono::Duration::minutes(30) {
                return None;
            }
            match run.status.as_str() {
                "success" => Some(Health::Healthy),
                "failure" | "timed_out" => Some(Health::Unhealthy),
                _ => None,
            }
        })
        .unwrap_or(Health::Unknown);
    match (workload, browser) {
        (Health::Unhealthy, _) | (_, Health::Unhealthy) => Health::Unhealthy,
        (Health::Degraded, _) => Health::Degraded,
        (Health::NotDeployed, _) => Health::NotDeployed,
        (Health::Healthy, Health::Healthy) => Health::Healthy,
        _ => Health::Unknown,
    }
}
