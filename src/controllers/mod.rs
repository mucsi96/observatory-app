use std::time::Duration;

use axum::{
    Extension, Json, Router,
    extract::DefaultBodyLimit,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tower_http::{set_header::SetResponseHeaderLayer, timeout::TimeoutLayer, trace::TraceLayer};

use crate::auth::{self, Auth};
use crate::services::{
    fleet::Fleet,
    issues::{IssueError, NewIssue},
};
use loco_rs::controller::Routes;

pub fn routes(auth: Auth) -> Routes {
    Routes::new()
        .add(
            "/api/apps",
            get(apps)
                .layer::<_, std::convert::Infallible>(middleware::from_fn_with_state(
                    auth.clone(),
                    auth::authorize,
                ))
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    Duration::from_secs(20),
                )),
        )
        .add(
            "/api/apps/refresh",
            post(refresh_apps).layer(middleware::from_fn_with_state(
                auth.clone(),
                auth::authorize,
            )),
        )
        .add(
            "/api/issues",
            post(create_issue)
                .layer(DefaultBodyLimit::max(128 * 1024))
                .layer::<_, std::convert::Infallible>(middleware::from_fn_with_state(
                    auth,
                    auth::authorize_issue,
                ))
                .layer(TimeoutLayer::with_status_code(
                    StatusCode::REQUEST_TIMEOUT,
                    Duration::from_secs(20),
                )),
        )
        .get("/healthz", || async { "ok" })
}

pub fn middleware(router: Router) -> Router {
    router
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        // React Aria's press and mobile scroll helpers inject these two static styles.
        // Permit their exact contents without allowing arbitrary inline styles.
        // WebKit also needs the exact text-overflow compatibility-probe attribute.
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; style-src-attr 'unsafe-hashes' 'sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw='; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        )))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        // Manual refresh can wait for the full 50-second collection deadline.
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(60)))
        .layer(TraceLayer::new_for_http())
}

async fn apps(Extension(fleet): Extension<Fleet>) -> Response {
    // Clone the Arc before encoding so the collector never waits for a browser.
    let snapshot = fleet.snapshot();
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

async fn refresh_apps(Extension(fleet): Extension<Fleet>, headers: HeaderMap) -> Response {
    if headers
        .get("x-observatory-request")
        .and_then(|h| h.to_str().ok())
        != Some("refresh")
        || headers
            .get("sec-fetch-site")
            .is_some_and(|h| h != "same-origin")
    {
        return issue_error(
            StatusCode::FORBIDDEN,
            "Refresh requires a same-origin dashboard request.",
        );
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if fleet.refresh.try_send(sender).is_err() {
        return issue_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Collector is unavailable or busy. Try again shortly.",
        );
    }
    match receiver.await {
        Ok(snapshot) => Json(&*snapshot).into_response(),
        Err(_) => issue_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Collector stopped. Try again shortly.",
        ),
    }
}

async fn create_issue(
    Extension(fleet): Extension<Fleet>,
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
    match fleet.issues.create(issue).await {
        Ok(issue) => (StatusCode::CREATED, Json(issue)).into_response(),
        Err(error) => {
            let status = match error {
                IssueError::Repository | IssueError::Payload => StatusCode::BAD_REQUEST,
                IssueError::Unconfigured => StatusCode::SERVICE_UNAVAILABLE,
                IssueError::Denied | IssueError::Unconfirmed => StatusCode::BAD_GATEWAY,
                IssueError::Rejected => StatusCode::UNPROCESSABLE_ENTITY,
                IssueError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            };
            issue_error(status, &error.to_string())
        }
    }
}

fn issue_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
