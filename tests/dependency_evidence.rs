use std::io::{Cursor, Write};

use observatory::{
    integrations::github::{
        GitHub,
        logs::{LOG_LIMIT, created_pull_requests},
    },
    model::{DependencyOutcome, DependencyUpdate},
};
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{path, query_param},
};
use zip::{ZipWriter, write::SimpleFileOptions};

const FINISHED: &str = "2026-10-01T10:10:00Z INFO: Repository finished (repository=o/r)\n";
const CREATED: &str = "2026-10-01T10:05:00Z INFO: PR created (repository=o/r, branch=renovate/all)\n2026-10-01T10:05:00Z        \"pr\": 42,\n";

fn archive(logs: &[String]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (index, log) in logs.iter().enumerate() {
        writer
            .start_file(format!("{index}_job.txt"), SimpleFileOptions::default())
            .unwrap();
        writer.write_all(log.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn only_explicit_repository_scoped_creation_records_are_evidence() {
    for (log, expected) in [
        (format!("{CREATED}{FINISHED}"), vec![42]),
        (format!("{CREATED}{CREATED}{FINISHED}"), vec![42]),
        (
            format!(
                "{}{FINISHED}",
                CREATED.replace("repository=o/r", "repository=other/r")
            ),
            vec![],
        ),
        (
            format!("{}{FINISHED}", CREATED.replace("PR created", "PR updated")),
            vec![],
        ),
        (
            format!(
                "{}{FINISHED}",
                CREATED.replace("PR created", "DRY-RUN: Would create PR")
            ),
            vec![],
        ),
        (
            format!(
                "{}{FINISHED}",
                CREATED.replace("PR created", "Found existing PR")
            ),
            vec![],
        ),
        (FINISHED.into(), vec![]),
    ] {
        assert_eq!(
            created_pull_requests(&archive(&[log]), "o/r").unwrap(),
            expected
        );
    }
    assert_eq!(
        created_pull_requests(
            &archive(&[format!("{CREATED}{FINISHED}"), CREATED.replace("42", "43"),]),
            "o/r"
        )
        .unwrap(),
        [42, 43]
    );
}

#[test]
fn incomplete_unknown_and_oversized_archives_are_unverified() {
    for log in [
        CREATED.to_owned(),
        "unrecognized logs".into(),
        format!("2026-10-01T10:05:00Z INFO: PR created (repository=o/r)\n{FINISHED}"),
        "x".repeat(LOG_LIMIT + 1),
    ] {
        assert!(created_pull_requests(&archive(&[log]), "o/r").is_err());
    }
    assert!(created_pull_requests(b"not a zip", "o/r").is_err());
    // The decompression budget applies to the entire archive, not each entry.
    assert!(
        created_pull_requests(
            &archive(&["x".repeat(LOG_LIMIT / 2 + 1), "x".repeat(LOG_LIMIT / 2 + 1)]),
            "o/r"
        )
        .is_err()
    );
}

#[tokio::test]
async fn latest_attempt_links_created_prs_even_when_they_have_merged() {
    let server = MockServer::start().await;
    Mock::given(path("/repos/o/r/actions/workflows"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"workflows":vec![json!({"id":1,"path":".github/workflows/pipeline.yml"});100]}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/repos/o/r/actions/workflows"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"workflows":[{"id":12,"path":".github/workflows/update_dependencies.yml"}]}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/repos/o/r/actions/workflows/12/runs")).and(query_param("per_page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"workflow_runs":[{"id":7,"run_attempt":2,"status":"completed","conclusion":"success","html_url":"https://github.com/o/r/actions/runs/7"}]})))
        .expect(1).mount(&server).await;
    Mock::given(path("/repos/o/r/actions/runs/7/attempts/2/logs"))
        .respond_with(
            ResponseTemplate::new(200).set_body_bytes(archive(&[format!("{CREATED}{FINISHED}")])),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(path("/repos/o/r/pulls/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"title":"Update dependencies","state":"closed","merged_at":"2026-10-01T11:00:00Z"})))
        .expect(1).mount(&server).await;
    let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
    let mut update = DependencyUpdate::default();
    github.dependency_update("o/r", &mut update).await.unwrap();
    assert_eq!(update.outcome, DependencyOutcome::PullRequestCreated);
    assert_eq!(update.mrs[0].number, 42);
    assert_eq!(update.mrs[0].state, "merged");
    assert_eq!(update.mrs[0].url, "https://github.com/o/r/pull/42");
}

#[tokio::test]
async fn dependency_states_remain_distinct_and_failed_logs_preserve_the_run() {
    for (status, logs_status, expected) in [
        ("in_progress", 200, DependencyOutcome::Pending),
        ("completed", 200, DependencyOutcome::NoPullRequest),
        ("completed", 410, DependencyOutcome::Unknown),
    ] {
        let server = MockServer::start().await;
        Mock::given(path("/repos/o/r/actions/workflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"workflows":[{"id":12,"path":".github/workflows/update_dependencies.yml"}]}),
            ))
            .mount(&server)
            .await;
        Mock::given(path("/repos/o/r/actions/workflows/12/runs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"workflow_runs":[{"id":7,"run_attempt":2,"status":status,"conclusion":"success"}]})))
            .mount(&server).await;
        Mock::given(path("/repos/o/r/actions/runs/7/attempts/2/logs"))
            .respond_with(
                ResponseTemplate::new(logs_status).set_body_bytes(archive(&[FINISHED.into()])),
            )
            .mount(&server)
            .await;
        let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
        let mut update = DependencyUpdate::default();
        let result = github.dependency_update("o/r", &mut update).await;
        assert_eq!(result.is_err(), logs_status != 200);
        assert_eq!(update.outcome, expected);
        assert!(update.run.is_some());
    }
}

#[tokio::test]
async fn unsafe_redirects_oversized_and_expired_downloads_are_rejected_without_secret_details() {
    for (status, location, body) in [
        (302, "http://example.com/private", vec![]),
        (302, "https://secret@example.com/private", vec![]),
        (410, "", vec![]),
        (200, "", vec![b'x'; LOG_LIMIT + 1]),
    ] {
        let server = MockServer::start().await;
        Mock::given(path("/logs"))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("Location", location)
                    .set_body_bytes(body),
            )
            .mount(&server)
            .await;
        let github = GitHub::with_base_url(&server.uri(), "private-token".into()).unwrap();
        let error = github
            .dependency_logs("/logs")
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret"));
        assert!(!error.contains("private"));
        assert!(!error.contains(&server.uri()));
    }
}
