use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
};

use serde::Deserialize;
use tokio::sync::{Mutex, OnceCell};

use super::{GitHubClient, get, get_body};
use crate::{error::IntegrationError, model::TechnologyStack};

const MANIFEST_LIMIT: usize = 256 * 1024;
const PACKAGE_LIMIT: usize = 12;
const CACHE_LIMIT: usize = 512;

type ManifestEntry = ((String, String), Arc<OnceCell<PackageStack>>);

#[derive(Default)]
pub(super) struct ManifestCache {
    entries: Mutex<VecDeque<ManifestEntry>>,
}

#[derive(Clone)]
struct PackageStack {
    frontend: BTreeSet<&'static str>,
    node_backend: bool,
}

// Inventory labels take precedence. Mutating the result keeps any detected
// backend evidence when a package manifest request fails or times out.
pub async fn collect(
    github: &GitHubClient,
    repository: &str,
    result: &mut TechnologyStack,
) -> Result<(), IntegrationError> {
    let tree: Tree = get(
        github,
        &format!("/repos/{repository}/git/trees/HEAD"),
        &[("recursive", "1".into())],
    )
    .await?;
    if tree.truncated {
        return Err(IntegrationError::IncompleteTree);
    }
    let files: Vec<_> = tree
        .tree
        .iter()
        .filter(|entry| entry.kind == "blob" && application_file(&entry.path))
        .collect();
    let detect_frontend = result.frontend.is_none();
    let detect_backend = result.backend.is_none();
    let mut frontend = BTreeSet::new();
    let mut backend = BTreeSet::new();
    for file in &files {
        let name = file.path.rsplit('/').next().unwrap_or_default();
        if detect_frontend && name == "angular.json" {
            frontend.insert("Angular");
        }
        if detect_backend && backend_file(&file.path) {
            let language = match name {
                "Cargo.toml" => Some("Rust"),
                "pom.xml" | "build.gradle" | "build.gradle.kts" => {
                    let directory = file.path.strip_suffix(name).unwrap_or_default();
                    if files.iter().any(|entry| {
                        entry.path.starts_with(directory) && entry.path.ends_with(".kt")
                    }) {
                        Some("Kotlin")
                    } else {
                        Some("Java")
                    }
                }
                "go.mod" => Some("Go"),
                "pyproject.toml" | "requirements.txt" | "Pipfile" => Some("Python"),
                "Gemfile" => Some("Ruby"),
                "composer.json" => Some("PHP"),
                _ if name.ends_with(".csproj") => Some("C#"),
                _ if name.ends_with(".fsproj") => Some("F#"),
                _ => None,
            };
            backend.extend(language);
        }
    }
    publish(result, &frontend, &backend, detect_frontend, detect_backend);
    let packages: Vec<_> = files
        .iter()
        .filter(|entry| {
            entry.path.rsplit('/').next() == Some("package.json")
                && (detect_frontend || (detect_backend && backend_file(&entry.path)))
        })
        .collect();
    if packages.len() > PACKAGE_LIMIT {
        return Err(IntegrationError::TooManyManifests);
    }
    let mut error = None;
    for file in packages {
        match package(github, repository, &file.sha).await {
            Ok(package) => {
                if detect_frontend {
                    frontend.extend(package.frontend);
                }
                if detect_backend && backend_file(&file.path) && package.node_backend {
                    backend.insert("Node.js");
                }
                publish(result, &frontend, &backend, detect_frontend, detect_backend);
            }
            Err(failure) => {
                error.get_or_insert(failure);
            }
        }
    }
    error.map_or(Ok(()), Err)
}

async fn package(
    github: &GitHubClient,
    repository: &str,
    sha: &str,
) -> Result<PackageStack, IntegrationError> {
    if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(IntegrationError::InvalidResponse);
    }
    let cell = {
        let key = (repository.to_owned(), sha.to_owned());
        let mut entries = github.stack_cache.entries.lock().await;
        let cell = if let Some(index) = entries.iter().position(|(entry, _)| entry == &key) {
            entries.remove(index).unwrap().1
        } else {
            if entries.len() == CACHE_LIMIT {
                entries.pop_front();
            }
            Arc::new(OnceCell::new())
        };
        entries.push_back((key, Arc::clone(&cell)));
        cell
    };
    // Only successful evidence is cached. OnceCell also shares in-flight reads,
    // and allows retry after an upstream failure or collection cancellation.
    cell.get_or_try_init(|| async {
        let bytes = get_body(
            github,
            &format!("/repos/{repository}/git/blobs/{sha}"),
            &[],
            "application/vnd.github.raw+json",
            MANIFEST_LIMIT,
        )
        .await?;
        let package: Package =
            serde_json::from_slice(&bytes).map_err(|_| IntegrationError::InvalidResponse)?;
        Ok(package_stack(package))
    })
    .await
    .cloned()
}

fn package_stack(package: Package) -> PackageStack {
    let frontend = [
        ("@angular/core", "Angular"),
        ("react", "React"),
        ("vue", "Vue"),
        ("svelte", "Svelte"),
        ("@solidjs/router", "Solid"),
        ("solid-js", "Solid"),
        ("preact", "Preact"),
    ]
    .into_iter()
    .filter_map(|(dependency, framework)| {
        (package.dependencies.contains_key(dependency)
            || package.dev_dependencies.contains_key(dependency))
        .then_some(framework)
    })
    .collect();
    let node_backend = ["express", "fastify", "koa", "@nestjs/core", "hono"]
        .iter()
        .any(|dependency| package.dependencies.contains_key(*dependency));
    PackageStack {
        frontend,
        node_backend,
    }
}

fn publish(
    result: &mut TechnologyStack,
    frontend: &BTreeSet<&str>,
    backend: &BTreeSet<&str>,
    detect_frontend: bool,
    detect_backend: bool,
) {
    if detect_frontend && !frontend.is_empty() {
        result.frontend = Some(frontend.iter().copied().collect::<Vec<_>>().join(" + "));
    }
    if detect_backend && !backend.is_empty() {
        result.backend = Some(backend.iter().copied().collect::<Vec<_>>().join(" + "));
    }
}

fn application_file(path: &str) -> bool {
    !path.split('/').any(|part| {
        part.starts_with('.')
            || matches!(
                part,
                "node_modules"
                    | "vendor"
                    | "target"
                    | "dist"
                    | "build"
                    | "test"
                    | "tests"
                    | "e2e"
                    | "fixtures"
                    | "example"
                    | "examples"
                    | "docs"
                    | "scripts"
                    | "tools"
            )
    })
}

fn backend_file(path: &str) -> bool {
    let mut directories: Vec<_> = path.split('/').collect();
    directories.pop();
    !directories
        .iter()
        .any(|part| matches!(*part, "frontend" | "client" | "web" | "ui"))
        && (directories.is_empty()
            || directories
                .iter()
                .any(|part| matches!(*part, "backend" | "server" | "api" | "service" | "services")))
}

#[derive(Deserialize)]
struct Tree {
    tree: Vec<Entry>,
    truncated: bool,
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    #[serde(default)]
    dependencies: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    dev_dependencies: BTreeMap<String, serde_json::Value>,
}
