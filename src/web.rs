use std::time::Duration;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tower_http::{set_header::SetResponseHeaderLayer, timeout::TimeoutLayer, trace::TraceLayer};

use crate::auth::{self, Auth};
use crate::collector::SnapshotReceiver;
use crate::{
    config::Config,
    error::IntegrationError,
    integrations::github::{self, GitHubClient},
};

#[derive(Clone)]
struct AppState {
    snapshots: SnapshotReceiver,
    repositories: std::sync::Arc<std::collections::HashSet<String>>,
    github: GitHubClient,
}

pub fn router(
    snapshots: SnapshotReceiver,
    auth: Auth,
    config: &Config,
    github: GitHubClient,
) -> Router {
    let state = AppState {
        snapshots,
        github,
        repositories: std::sync::Arc::new(
            config
                .apps
                .iter()
                .map(|app| app.repository.clone())
                .filter(|repo| !repo.is_empty())
                .collect(),
        ),
    };
    Router::new()
        .merge(Router::new().route("/api/apps", get(apps))
            .route("/api/issues", post(create_issue).layer(DefaultBodyLimit::max(128 * 1024)))
            .route_layer(middleware::from_fn_with_state(auth, auth::authorize)))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        // React Aria's press and mobile scroll helpers inject these two static styles.
        // Permit their exact contents without allowing arbitrary inline styles.
        // WebKit also needs the exact text-overflow compatibility-probe attribute.
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; style-src-attr 'unsafe-hashes' 'sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw='; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        )))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(20)))
        .layer(TraceLayer::new_for_http())
}

async fn apps(State(state): State<AppState>) -> Response {
    // Clone the Arc before encoding so the collector never waits for a browser.
    let snapshot = state.snapshots.borrow().clone();
    match snapshot {
        Some(snapshot) => Json(&*snapshot).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Initial collection in progress",
            })),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NewIssue {
    repository: String,
    title: String,
    description: String,
}

async fn create_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(issue): Json<NewIssue>,
) -> Response {
    // A required custom header plus JSON prevents cross-origin form submissions.
    // No CORS permission is granted for cross-origin preflights. Fetch Metadata
    // also rejects same-site sibling origins; non-browser API clients may omit it.
    if headers
        .get("x-observatory-request")
        .and_then(|h| h.to_str().ok())
        != Some("create-issue")
        || headers
            .get("sec-fetch-site")
            .is_some_and(|h| h != "same-origin")
    {
        return issue_error(
            StatusCode::FORBIDDEN,
            "Issue creation requires a same-origin dashboard request.",
        );
    }
    if !state.repositories.contains(&issue.repository)
        || issue
            .repository
            .split('/')
            .any(|part| part == "." || part == "..")
    {
        return issue_error(
            StatusCode::BAD_REQUEST,
            "Select a configured application repository.",
        );
    }
    let title = issue.title.trim();
    if title.is_empty() || title.chars().count() > 256 || issue.description.len() > 65536 {
        return issue_error(
            StatusCode::BAD_REQUEST,
            "Provide a title of 1–256 characters and a description of at most 64 KiB.",
        );
    }
    match github::create_issue(&state.github, &issue.repository, title, &issue.description).await {
        Ok(number) => (StatusCode::CREATED, Json(serde_json::json!({
            "number": number, "url": format!("https://github.com/{}/issues/{number}", issue.repository)
        }))).into_response(),
        Err(IntegrationError::MissingGithubToken) => issue_error(StatusCode::SERVICE_UNAVAILABLE, "Issue creation is not configured. Ask an administrator to configure a GitHub token with Issues write permission."),
        Err(IntegrationError::Http(401 | 403 | 404 | 410)) => issue_error(StatusCode::BAD_GATEWAY, "GitHub denied issue creation. Ask an administrator to check token access, Issues write permission, and whether issues are enabled."),
        Err(IntegrationError::Http(422)) => issue_error(StatusCode::UNPROCESSABLE_ENTITY, "GitHub rejected the issue. Check the title and description."),
        Err(IntegrationError::Http(429)) => issue_error(StatusCode::TOO_MANY_REQUESTS, "GitHub rate limit reached. Try again later."),
        Err(_) => issue_error(StatusCode::BAD_GATEWAY, "Could not confirm issue creation. Check the repository before trying again to avoid a duplicate."),
    }
}

fn issue_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
