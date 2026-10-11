use std::{path::PathBuf, time::Duration};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::{
    services::ServeDir, set_header::SetResponseHeaderLayer, timeout::TimeoutLayer,
    trace::TraceLayer,
};

use crate::collector::SnapshotReceiver;

pub fn router(snapshots: SnapshotReceiver, static_dir: impl Into<PathBuf>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/apps", get(apps))
        .fallback_service(ServeDir::new(static_dir.into()))
        .with_state(snapshots)
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        )))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(20)))
        .layer(TraceLayer::new_for_http())
}

async fn apps(State(snapshots): State<SnapshotReceiver>) -> Response {
    // Clone the Arc before encoding so the collector never waits for a browser.
    let snapshot = snapshots.borrow().clone();
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
