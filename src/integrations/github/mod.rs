pub mod logs;
pub mod stack;

use std::{path::Path, sync::Arc, time::Duration};

use futures::StreamExt;
use reqwest::{Client, Response, StatusCode, Url, header};
use serde::{Deserialize, de::DeserializeOwned};

use crate::{
    error::IntegrationError,
    model::{
        DependencyOutcome, DependencyPullRequest, DependencyUpdate, PipelineStatus, PullRequest,
        RepositorySignals, WorkflowRun,
    },
};
use logs::{LOG_LIMIT, affected_pull_requests};

const JSON_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct GitHubClient {
    client: Client,
    base_url: String,
    token: String,
    stack_cache: Arc<stack::ManifestCache>,
}

pub fn client(
    base_url: &str,
    token: String,
    ca_file: Option<&Path>,
) -> anyhow::Result<GitHubClient> {
    let base_url = crate::config::https_endpoint(base_url)?;
    // Reqwest and kube-rs share one explicit TLS provider. Installation is
    // process-wide and returns Err only when a provider is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = Client::builder()
        .user_agent(concat!("observatory/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(ca_file) = ca_file {
        builder =
            builder.add_root_certificate(reqwest::Certificate::from_pem(&std::fs::read(ca_file)?)?);
    }
    Ok(GitHubClient {
        client: builder.build()?,
        base_url: base_url.as_str().trim_end_matches('/').to_owned(),
        token,
        stack_cache: Arc::default(),
    })
}

async fn get<T: DeserializeOwned>(
    github: &GitHubClient,
    path: &str,
    query: &[(&str, String)],
) -> Result<T, IntegrationError> {
    let bytes = get_body(
        github,
        path,
        query,
        "application/vnd.github+json",
        JSON_LIMIT,
    )
    .await?;
    serde_json::from_slice(&bytes).map_err(|_| IntegrationError::InvalidResponse)
}

async fn get_body(
    github: &GitHubClient,
    path: &str,
    query: &[(&str, String)],
    accept: &str,
    limit: usize,
) -> Result<Vec<u8>, IntegrationError> {
    if github.token.is_empty() {
        return Err(IntegrationError::MissingGithubToken);
    }
    let response = github
        .client
        .get(format!("{}{path}", github.base_url))
        .bearer_auth(&github.token)
        .header(header::ACCEPT, accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .query(query)
        .send()
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
    bounded_body(response, limit).await
}

pub async fn repository(
    github: &GitHubClient,
    repository: &str,
    workflow: &str,
) -> Result<RepositorySignals, IntegrationError> {
    let search: IssueSearch = get(
        github,
        "/search/issues",
        &[
            (
                "q",
                format!("repo:{repository} is:open is:issue NOT \"Dependency Dashboard\" in:title"),
            ),
            ("per_page", "1".into()),
        ],
    )
    .await?;
    if search.incomplete_results {
        return Err(IntegrationError::IncompleteSearch);
    }

    let mut mrs = Vec::new();
    for page in 1.. {
        let prs: Vec<ApiPullRequest> = get(
            github,
            &format!("/repos/{repository}/pulls"),
            &[
                ("state", "open".into()),
                ("per_page", "100".into()),
                ("page", page.to_string()),
            ],
        )
        .await?;
        let count = prs.len();
        for pr in prs {
            let pipeline = pipeline(github, repository, &pr.head.sha)
                .await
                .unwrap_or(PipelineStatus::Unknown);
            mrs.push(PullRequest {
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                draft: pr.draft,
                pipeline,
            });
        }
        if count < 100 {
            break;
        }
    }

    let deployment = deployment(github, repository, workflow).await?;
    Ok(RepositorySignals {
        open_mrs: mrs.len(),
        issues: search.total_count,
        mrs,
        deployment,
        dependency_update: DependencyUpdate::default(),
    })
}

pub async fn pipeline(
    github: &GitHubClient,
    repository: &str,
    sha: &str,
) -> Result<PipelineStatus, IntegrationError> {
    let base = format!("/repos/{repository}/commits/{sha}");
    let status: CommitStatus = get(github, &format!("{base}/status"), &[]).await?;
    let mut failed = matches!(status.state.as_str(), "failure" | "error");
    let mut pending = status.total_count > 0 && status.state == "pending";
    let mut count = status.total_count;
    for page in 1.. {
        let checks: CheckRuns = get(
            github,
            &format!("{base}/check-runs"),
            &[
                ("filter", "latest".into()),
                ("per_page", "100".into()),
                ("page", page.to_string()),
            ],
        )
        .await?;
        let page_count = checks.check_runs.len();
        for check in checks.check_runs {
            count += 1;
            if check.status != "completed" {
                pending = true;
            } else if !matches!(
                check.conclusion.as_deref(),
                Some("success" | "neutral" | "skipped")
            ) {
                failed = true;
            }
        }
        if page_count < 100 {
            break;
        }
    }
    Ok(if failed {
        PipelineStatus::Failed
    } else if pending {
        PipelineStatus::Running
    } else if count == 0 {
        PipelineStatus::NoChecks
    } else {
        PipelineStatus::Passed
    })
}

async fn deployment(
    github: &GitHubClient,
    repository: &str,
    workflow: &str,
) -> Result<Option<WorkflowRun>, IntegrationError> {
    let workflow = if workflow.is_empty() {
        "pipeline.yml"
    } else {
        workflow
    };
    let runs: Runs = get(
        github,
        &format!("/repos/{repository}/actions/runs"),
        &[("branch", "main".into()), ("per_page", "20".into())],
    )
    .await?;
    for run in runs.workflow_runs {
        if run.path != format!(".github/workflows/{workflow}") {
            continue;
        }
        for page in 1.. {
            let jobs: Jobs = get(
                github,
                &format!("/repos/{repository}/actions/runs/{}/jobs", run.id),
                &[("per_page", "100".into()), ("page", page.to_string())],
            )
            .await?;
            let count = jobs.jobs.len();
            if let Some(job) = jobs
                .jobs
                .into_iter()
                .find(|job| matches!(job.name.as_str(), "deploy" | "Deploy"))
            {
                return Ok(Some(WorkflowRun {
                    status: run_status(job.status, job.conclusion),
                    url: job.html_url,
                    updated_at: run.updated_at,
                }));
            }
            if count < 100 {
                break;
            }
        }
    }
    Ok(None)
}

// Mutating the result preserves a collected run even if later requests time out.
pub async fn dependency_update(
    github: &GitHubClient,
    repository: &str,
    result: &mut DependencyUpdate,
) -> Result<(), IntegrationError> {
    let base = format!("/repos/{repository}");
    let mut workflow_id = None;
    for page in 1.. {
        let data: Workflows = get(
            github,
            &format!("{base}/actions/workflows"),
            &[("per_page", "100".into()), ("page", page.to_string())],
        )
        .await?;
        let count = data.workflows.len();
        workflow_id = data
            .workflows
            .into_iter()
            .find(|workflow| workflow.path == ".github/workflows/update_dependencies.yml")
            .map(|workflow| workflow.id);
        if workflow_id.is_some() || count < 100 {
            break;
        }
    }
    let Some(workflow_id) = workflow_id else {
        return Ok(());
    };
    let runs: Runs = get(
        github,
        &format!("{base}/actions/workflows/{workflow_id}/runs"),
        &[("per_page", "1".into())],
    )
    .await?;
    let Some(run) = runs.workflow_runs.into_iter().next() else {
        return Ok(());
    };
    result.run = Some(WorkflowRun {
        status: run_status(run.status.clone(), run.conclusion),
        url: run.html_url,
        updated_at: run.updated_at,
    });
    if run.status != "completed" {
        result.outcome = DependencyOutcome::Pending;
        return Ok(());
    }
    if run.id == 0 || run.run_attempt == 0 {
        return Err(IntegrationError::MissingRunIdentity);
    }
    let bytes = dependency_logs(
        github,
        &format!(
            "{base}/actions/runs/{}/attempts/{}/logs",
            run.id, run.run_attempt,
        ),
    )
    .await?;
    let repo = repository.to_owned();
    let numbers = tokio::task::spawn_blocking(move || affected_pull_requests(&bytes, &repo))
        .await
        .map_err(|_| IntegrationError::InvalidLogArchive)??;
    let created = numbers.values().any(|created| *created);
    let updated = numbers.values().any(|created| !*created);
    for number in numbers.into_keys() {
        let pr: DependencyPr = get(github, &format!("{base}/pulls/{number}"), &[]).await?;
        result.mrs.push(DependencyPullRequest {
            number,
            title: pr.title,
            url: format!("https://github.com/{repository}/pull/{number}"),
            state: if pr.merged_at.is_some() {
                "merged".into()
            } else {
                pr.state
            },
        });
    }
    result.outcome = if result.mrs.is_empty() {
        DependencyOutcome::NoPullRequest
    } else if created && updated {
        DependencyOutcome::PullRequestsCreatedAndUpdated
    } else if updated {
        DependencyOutcome::PullRequestUpdated
    } else {
        DependencyOutcome::PullRequestCreated
    };
    Ok(())
}

pub async fn dependency_logs(
    github: &GitHubClient,
    path: &str,
) -> Result<Vec<u8>, IntegrationError> {
    if github.token.is_empty() {
        return Err(IntegrationError::MissingGithubToken);
    }
    let mut response = github
        .client
        .get(format!("{}{path}", github.base_url))
        .bearer_auth(&github.token)
        .send()
        .await
        .map_err(|_| IntegrationError::Unavailable)?;
    if response.status() == StatusCode::FOUND {
        let target = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Url::parse(value).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .ok_or(IntegrationError::InvalidLogRedirect)?;
        // A fresh request intentionally carries no GitHub authorization header.
        response = github
            .client
            .get(target)
            .send()
            .await
            .map_err(|_| IntegrationError::Unavailable)?;
    }
    bounded_body(response, LOG_LIMIT).await
}

async fn bounded_body(response: Response, limit: usize) -> Result<Vec<u8>, IntegrationError> {
    if response.status() != StatusCode::OK {
        return Err(IntegrationError::Http(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(IntegrationError::TooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| IntegrationError::Unavailable)?;
        if bytes.len() + chunk.len() > limit {
            return Err(IntegrationError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn run_status(status: String, conclusion: Option<String>) -> String {
    if status == "completed" {
        conclusion.unwrap_or_else(|| "unknown".into())
    } else {
        status
    }
}

#[derive(Deserialize)]
struct IssueSearch {
    total_count: u64,
    #[serde(default)]
    incomplete_results: bool,
}
#[derive(Deserialize)]
struct ApiPullRequest {
    number: u64,
    title: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    head: Head,
}
#[derive(Deserialize)]
struct Head {
    sha: String,
}
#[derive(Deserialize)]
struct CommitStatus {
    state: String,
    total_count: u64,
}
#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}
#[derive(Deserialize)]
struct CheckRun {
    status: String,
    conclusion: Option<String>,
}
#[derive(Deserialize)]
struct Runs {
    workflow_runs: Vec<ApiRun>,
}
#[derive(Deserialize)]
struct ApiRun {
    id: u64,
    #[serde(default)]
    path: String,
    #[serde(default)]
    run_attempt: u64,
    #[serde(default)]
    status: String,
    conclusion: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    updated_at: String,
}
#[derive(Deserialize)]
struct Jobs {
    jobs: Vec<Job>,
}
#[derive(Deserialize)]
struct Job {
    name: String,
    status: String,
    conclusion: Option<String>,
    html_url: String,
}
#[derive(Deserialize)]
struct Workflows {
    workflows: Vec<Workflow>,
}
#[derive(Deserialize)]
struct Workflow {
    id: u64,
    path: String,
}
#[derive(Deserialize)]
struct DependencyPr {
    title: String,
    state: String,
    merged_at: Option<String>,
}
