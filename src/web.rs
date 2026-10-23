use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::{set_header::SetResponseHeaderLayer, timeout::TimeoutLayer, trace::TraceLayer};

use crate::auth::{self, Auth};
use crate::collector::SnapshotReceiver;

pub fn router(snapshots: SnapshotReceiver, auth: Auth) -> Router {
    Router::new()
        .merge(Router::new().route("/api/apps", get(apps))
            .route_layer(middleware::from_fn_with_state(auth, auth::authorize)))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(snapshots)
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
