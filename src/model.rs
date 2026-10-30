use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Application {
    pub name: String,
    pub namespace: String,
    #[serde(default)]
    pub repository: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub deployment_workflow: String,
    #[serde(default)]
    pub stack: TechnologyStack,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TechnologyStack {
    pub frontend: Option<String>,
    pub backend: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Healthy,
    Degraded,
    Unhealthy,
    #[serde(rename = "not deployed")]
    NotDeployed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkloadStatus {
    Healthy,
    Deploying,
    Unhealthy,
    #[serde(rename = "scaled down")]
    ScaledDown,
}

#[derive(Clone, Debug, Serialize)]
pub struct Workload {
    pub name: String,
    pub images: Vec<String>,
    pub ready: i32,
    pub desired: i32,
    pub status: WorkloadStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSignals {
    #[serde(flatten)]
    pub application: Application,
    pub health: Health,
    pub browser_check: Option<WorkflowRun>,
    pub workloads: Vec<Workload>,
    pub repository_data: Option<RepositorySignals>,
    pub errors: Vec<String>,
}

pub fn empty_signals(application: Application) -> ApplicationSignals {
    ApplicationSignals {
        application,
        health: Health::Unknown,
        browser_check: None,
        workloads: Vec::new(),
        repository_data: None,
        errors: Vec::new(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub environment: String,
    pub updated_at: DateTime<Utc>,
    pub apps: Vec<ApplicationSignals>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySignals {
    #[serde(rename = "openMRs")]
    pub open_mrs: usize,
    pub issues: u64,
    pub mrs: Vec<PullRequest>,
    pub deployment: Option<WorkflowRun>,
    pub dependency_update: DependencyUpdate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PipelineStatus {
    Passed,
    Failed,
    Running,
    #[serde(rename = "no checks")]
    NoChecks,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub pipeline: PipelineStatus,
    pub draft: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub status: String,
    pub url: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum DependencyOutcome {
    #[default]
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "no PR created")]
    NoPullRequest,
    #[serde(rename = "PR created")]
    PullRequestCreated,
    #[serde(rename = "PR updated")]
    PullRequestUpdated,
    #[serde(rename = "PRs created and updated")]
    PullRequestsCreatedAndUpdated,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DependencyUpdate {
    pub run: Option<WorkflowRun>,
    pub mrs: Vec<DependencyPullRequest>,
    pub outcome: DependencyOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DependencyPullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
}
