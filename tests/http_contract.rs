use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chrono::Utc;
use http_body_util::BodyExt;
use observatory::{model::Snapshot, web};
use tokio::sync::watch;
use tower::ServiceExt;

#[tokio::test]
async fn api_serves_shared_snapshots_and_static_assets_with_security_headers() {
    let static_dir = tempfile::tempdir().unwrap();
    tokio::fs::write(
        static_dir.path().join("index.html"),
        "<html>React application</html>",
    )
    .await
    .unwrap();
    tokio::fs::write(static_dir.path().join("app.js"), "export {};")
        .await
        .unwrap();
    let (sender, receiver) = watch::channel(None);
    let app = web::router(receiver, static_dir.path());
    let response = app
        .clone()
        .oneshot(Request::get("/api/apps").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["content-type"], "application/json");
    assert_eq!(response.headers()["cache-control"], "no-store");
    sender.send_replace(Some(Arc::new(Snapshot {
        environment: "test".into(),
        updated_at: Utc::now(),
        apps: vec![],
    })));
    for path in ["/", "/app.js", "/api/apps", "/healthz"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        if path == "/api/apps" {
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let snapshot: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(snapshot["environment"], "test");
            assert!(snapshot["updatedAt"].is_string());
            assert_eq!(snapshot["apps"], serde_json::json!([]));
        }
    }
    let response = app
        .oneshot(Request::get("/api/missing").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
