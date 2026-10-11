use std::time::Duration;

use k8s_openapi::api::apps::v1::Deployment;
use observatory::{
    collector::Collector,
    config::Config,
    integrations::{
        github::GitHub,
        kubernetes::{Kubernetes, workload},
    },
    model::{Application, Health, PipelineStatus, WorkloadStatus},
};
use serde_json::{Value, json};
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path, query_param},
};

fn application(namespace: &str, repository: &str) -> Application {
    Application {
        name: namespace.into(),
        namespace: namespace.into(),
        repository: repository.into(),
        url: format!("https://{namespace}.example.com"),
        deployment_workflow: String::new(),
    }
}

async fn endpoint(server: &MockServer, route: &str, body: Value) {
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

#[test]
fn production_readiness_requires_a_completed_rollout() {
    let cases = [
        (
            json!({"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"replicas":1,"updatedReplicas":1,"availableReplicas":1}}),
            WorkloadStatus::Healthy,
        ),
        (
            json!({"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":1,"replicas":1,"updatedReplicas":1,"availableReplicas":1}}),
            WorkloadStatus::Deploying,
        ),
        (
            json!({"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"replicas":2,"updatedReplicas":1,"availableReplicas":2}}),
            WorkloadStatus::Deploying,
        ),
        (
            json!({"metadata":{"generation":2},"spec":{"replicas":1},"status":{"observedGeneration":2,"conditions":[{"type":"Progressing","status":"False"}]}}),
            WorkloadStatus::Unhealthy,
        ),
        (json!({"spec":{"replicas":0}}), WorkloadStatus::ScaledDown),
        (
            json!({"spec":{"replicas":1},"status":{"conditions":[{"type":"ReplicaFailure","status":"True"}]}}),
            WorkloadStatus::Unhealthy,
        ),
    ];
    for (body, expected) in cases {
        let deployment: Deployment = serde_json::from_value(body).unwrap();
        assert_eq!(workload(deployment).status, expected);
    }
}

#[tokio::test]
async fn pipeline_combines_paginated_checks_with_legacy_statuses() {
    for (state, count, checks, expected) in [
        ("pending", 0, json!([]), PipelineStatus::NoChecks),
        (
            "success",
            1,
            json!([{"status":"in_progress"}]),
            PipelineStatus::Running,
        ),
        (
            "failure",
            1,
            json!([{"status":"in_progress"}]),
            PipelineStatus::Failed,
        ),
        (
            "success",
            1,
            json!([{"status":"completed","conclusion":"cancelled"}]),
            PipelineStatus::Failed,
        ),
        (
            "success",
            1,
            json!([{"status":"completed","conclusion":"success"}]),
            PipelineStatus::Passed,
        ),
    ] {
        let server = MockServer::start().await;
        endpoint(
            &server,
            "/repos/o/r/commits/sha/status",
            json!({"state":state,"total_count":count}),
        )
        .await;
        endpoint(
            &server,
            "/repos/o/r/commits/sha/check-runs",
            json!({"check_runs":checks}),
        )
        .await;
        let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
        assert_eq!(github.pipeline("o/r", "sha").await.unwrap(), expected);
    }

    let server = MockServer::start().await;
    endpoint(
        &server,
        "/repos/o/r/commits/sha/status",
        json!({"state":"pending","total_count":0}),
    )
    .await;
    Mock::given(path("/repos/o/r/commits/sha/check-runs"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"check_runs": vec![json!({"status":"completed","conclusion":"success"});100]}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/repos/o/r/commits/sha/check-runs"))
        .and(query_param("page", "2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                json!({"check_runs":[{"status":"completed","conclusion":"failure"}]}),
            ),
        )
        .expect(1)
        .mount(&server)
        .await;
    let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
    assert_eq!(
        github.pipeline("o/r", "sha").await.unwrap(),
        PipelineStatus::Failed
    );
}

#[tokio::test]
async fn repository_separates_issues_and_selects_the_delivery_job() {
    let server = MockServer::start().await;
    Mock::given(path("/search/issues"))
        .and(header("Authorization", "Bearer private-token"))
        .and(query_param(
            "q",
            "repo:o/r is:open is:issue NOT \"Dependency Dashboard\" in:title",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"total_count":7})))
        .expect(1)
        .mount(&server)
        .await;
    endpoint(&server, "/repos/o/r/pulls", json!([{"number":12,"title":"A change","draft":true,"html_url":"https://github.com/o/r/pull/12","head":{"sha":"abc"}}])).await;
    endpoint(
        &server,
        "/repos/o/r/commits/abc/status",
        json!({"state":"pending","total_count":0}),
    )
    .await;
    endpoint(
        &server,
        "/repos/o/r/commits/abc/check-runs",
        json!({"check_runs":[{"status":"completed","conclusion":"failure"}]}),
    )
    .await;
    endpoint(&server, "/repos/o/r/actions/runs", json!({"workflow_runs":[{"id":2,"path":".github/workflows/pages.yml"},{"id":1,"path":".github/workflows/pipeline.yml","updated_at":"2026-10-01T10:00:00Z"}]})).await;
    endpoint(&server, "/repos/o/r/actions/runs/1/jobs", json!({"jobs":[{"name":"deploy","status":"completed","conclusion":"failure","html_url":"https://github.com/o/r/actions/runs/1"}]})).await;
    let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
    let signals = github.repository("o/r", "").await.unwrap();
    assert_eq!(signals.issues, 7);
    assert_eq!(signals.open_mrs, 1);
    assert!(signals.mrs[0].draft);
    assert_eq!(signals.mrs[0].pipeline, PipelineStatus::Failed);
    assert_eq!(signals.deployment.unwrap().status, "failure");
}

#[tokio::test]
async fn incomplete_search_is_not_reported_as_a_valid_count() {
    let server = MockServer::start().await;
    endpoint(
        &server,
        "/search/issues",
        json!({"total_count":7,"incomplete_results":true}),
    )
    .await;
    let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
    assert!(github.repository("o/r", "").await.is_err());
}

#[tokio::test]
async fn partial_failure_preserves_other_applications_and_repository_signals() {
    let server = MockServer::start().await;
    endpoint(&server, "/apis/apps/v1/namespaces/healthy/deployments", json!({"metadata":{},"items":[{
        "metadata":{"name":"server","generation":1},
        "spec":{"replicas":1,"template":{"spec":{"containers":[{"name":"app","image":"app:prod-12"}]}}},
        "status":{"observedGeneration":1,"replicas":1,"updatedReplicas":1,"availableReplicas":1}
    }]})).await;
    Mock::given(path("/apis/apps/v1/namespaces/broken/deployments"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","message":"private","code":403})))
        .mount(&server).await;
    endpoint(&server, "/search/issues", json!({"total_count":3})).await;
    endpoint(&server, "/repos/o/r/pulls", json!([])).await;
    endpoint(
        &server,
        "/repos/o/r/actions/runs",
        json!({"workflow_runs":[]}),
    )
    .await;
    Mock::given(path("/repos/o/r/actions/workflows"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let client = kube::Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
    let collector = Collector::new(
        Config {
            environment: "test".into(),
            apps: vec![application("healthy", "o/r"), application("broken", "")],
        },
        Kubernetes::new(Some(client)),
        GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap(),
    );
    let snapshot = collector.collect(Duration::from_secs(2)).await;
    assert_eq!(snapshot.apps[0].health, Health::Healthy);
    assert_eq!(snapshot.apps[0].workloads[0].images, ["app:prod-12"]);
    let repository = snapshot.apps[0].repository_data.as_ref().unwrap();
    assert_eq!(repository.issues, 3);
    assert!(repository.dependency_update.error.is_some());
    assert_eq!(snapshot.apps[1].health, Health::Unknown);
    assert!(!snapshot.apps[1].errors.is_empty());
    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(!json.contains("private-token"));
    assert!(!json.contains(&server.uri()));
}

#[tokio::test]
async fn collection_deadline_bounds_queued_apps_and_does_not_leak_credentials() {
    let server = MockServer::start().await;
    Mock::given(path("/search/issues"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(5))
                .set_body_json(json!({"total_count":0})),
        )
        .mount(&server)
        .await;
    let collector = Collector::new(
        Config {
            environment: "test".into(),
            apps: (0..8)
                .map(|i| application(&format!("app-{i}"), "o/r"))
                .collect(),
        },
        Kubernetes::new(None),
        GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap(),
    );
    let snapshot = tokio::time::timeout(
        Duration::from_secs(1),
        collector.collect(Duration::from_millis(30)),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.apps.len(), 8);
    assert!(
        snapshot
            .apps
            .iter()
            .all(|app| app.errors.iter().any(|error| error.contains("deadline")))
    );
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("private-token")
    );
}

#[test]
fn existing_configuration_is_compatible_and_invalid_descriptors_are_rejected() {
    let config: Config = serde_json::from_str(include_str!("../config.example.json")).unwrap();
    config.validate().unwrap();
    for app in [
        Application {
            url: "javascript:alert(1)".into(),
            ..application("app", "o/r")
        },
        Application {
            url: "https://secret@example.com".into(),
            ..application("app", "o/r")
        },
        application("../app", "o/r"),
        application("app", "../o/r"),
        Application {
            deployment_workflow: "../pipeline.yml".into(),
            ..application("app", "o/r")
        },
    ] {
        assert!(
            Config {
                environment: "test".into(),
                apps: vec![app]
            }
            .validate()
            .is_err()
        );
    }
    assert!(
        Config {
            environment: "test".into(),
            apps: vec![application("app", ""), application("app", "")]
        }
        .validate()
        .is_err()
    );
}
