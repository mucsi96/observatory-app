use thiserror::Error;

// Never expose upstream bodies, credentials, request URLs, or signed log URLs.
#[derive(Debug, Error)]
pub enum IntegrationError {
    #[error("upstream unavailable")]
    Unavailable,
    #[error("upstream HTTP {0}")]
    Http(u16),
    #[error("upstream response invalid")]
    InvalidResponse,
    #[error("upstream response too large")]
    TooLarge,
    #[error("collection deadline exceeded")]
    Deadline,
    #[error("GITHUB_TOKEN is not configured")]
    MissingGithubToken,
    #[error("GitHub search results incomplete")]
    IncompleteSearch,
    #[error("not connected (run in cluster)")]
    NotInCluster,
    #[error("dependency run identity unavailable")]
    MissingRunIdentity,
    #[error("invalid dependency log redirect")]
    InvalidLogRedirect,
    #[error("invalid or incomplete dependency log archive")]
    InvalidLogArchive,
    #[error("dependency PR creation record incomplete")]
    IncompleteCreation,
    #[error("dependency run result could not be verified from logs")]
    UnverifiedLogs,
}

impl From<kube::Error> for IntegrationError {
    fn from(error: kube::Error) -> Self {
        match error {
            kube::Error::Api(response) => Self::Http(response.code),
            _ => Self::Unavailable,
        }
    }
}
