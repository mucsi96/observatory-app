# Observatory

A production fleet dashboard built with **Rust and React**. The backend uses Axum,
Tokio, Serde, Reqwest, and kube-rs; the frontend uses React, TypeScript, Vite,
TanStack Query, and Zod. Entra authentication uses the platform's existing OIDC
proxy. Assets are served locally, with no external fonts or CDN dependencies.

Extracted from [p07](https://github.com/mucsi96/p07) with its application history.
Provisioning lives in [k8s-modules](https://github.com/mucsi96/k8s-modules), module
`setup_app_dashboard`; p07 supplies the application inventory and platform inputs.

## Development

Requires Rust 1.99 (pinned in `rust-toolchain.toml`) and Node.js 24+.
Install Rust with [rustup](https://rustup.rs/). From the repository root:

```bash
npm --prefix frontend ci
npm --prefix frontend run build
CONFIG_FILE=config.example.json cargo run --locked
```

Open http://localhost:8080. Set `GITHUB_TOKEN` to read real repository data. Without
in-cluster credentials Kubernetes signals are explicitly **unknown**. The example
contains placeholder URLs, not demo data. The local server binds to loopback.
For frontend hot reload, run `npm --prefix frontend run dev` in a second terminal
and open http://localhost:5173; Vite proxies API requests to the Rust server.
The production container runs as a non-root process in a distroless image and
binds to `0.0.0.0:8080`.

### Architecture

- `src/model.rs`, `src/config.rs`: typed API models and validated JSON inventory.
  The existing `config.json`/ConfigMap shape and camelCase API remain compatible.
- `src/integrations/`: typed Kubernetes deployments and GitHub REST collectors.
  kube-rs uses only in-cluster credentials, including projected token rotation;
  local kubeconfig is never used. TLS and error handling keep secrets server-side.
- `src/collector.rs`: bounded async collection, independent per-app signals, and
  an immutable snapshot shared through a Tokio watch channel. There is no database
  or persistent application state to migrate.
- `src/web.rs`, `src/main.rs`: Axum routes, static assets, security headers,
  structured tracing (`RUST_LOG`), and SIGINT/SIGTERM shutdown.
- `frontend/src/features/fleet/`: schema-validated server state, React components,
  search/filter/expansion state, and signal selectors. TanStack Query owns polling,
  cancellation, focus refetches, and retention of the last successful snapshot.

Runtime settings: `CONFIG_FILE` (default `config.json`), `GITHUB_TOKEN`,
`LISTEN_ADDR` (default `127.0.0.1:8080`), `STATIC_DIR` (default `frontend/dist`),
and `RUST_LOG`. Production retains the existing ConfigMap, Secret, service account,
Service, namespace, ports, and ingress/OIDC policy.

### Verification

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
bash -n scripts/deploy.sh
docker build -t observatory:local .
```

Rust tests exercise collector deadlines, readiness, pagination, partial failures,
API contracts, credential redaction, and run-specific dependency evidence. React
tests exercise filtering, expansion, partial totals, safe links, stale data, and
refresh recovery. Playwright starts the real Rust server and loads the production
bundle, checking CSP, interaction, and mobile layout. It requires the frontend
build and `target/debug/observatory`; stop other servers using port 8080 first.
CI additionally builds and smoke-tests the read-only production container on PRs.

## Signals

- **Health:** all Deployments in each app namespace, using observed generation,
  updated/available/desired replicas, and failure conditions. Scaled-down workloads
  are degraded, empty namespaces are not deployed, API failures are unknown.
  Health means Kubernetes readiness, not an external synthetic uptime probe.
- **Production version:** Deployment container image tags/digests, with separate
  frontend/backend images. Expand a row for full image references.
- **Last deployment:** the most recent `deploy` job found in the latest 20 main
  branch workflow runs, restricted to `pipeline.yml` to exclude Pages deployments.
  App descriptors can override `deploymentWorkflow`. An absent job is shown as
  no recent deploy data. This repository uses the same `pipeline.yml` convention.
- **MRs / PRs:** all open GitHub PRs (paginated), including drafts. Checks and legacy
  commit statuses are combined for the current head SHA. Failures take precedence
  over running checks; no checks is distinct from passed; API errors are unknown.
- **Issues:** open GitHub issues excluding PRs. Incomplete searches are rejected.
- **Dependency update:** latest run of `update_dependencies.yml`, the fleet's
  self-hosted Renovate workflow, with its status, timestamp and run link. Workflow
  discovery is paginated and its history is queried directly so weekly runs are
  not hidden by frequent delivery runs. PR links come **only from explicit Renovate
  `PR created` events in the latest run attempt's logs**, scoped to that repository.
  All PRs created by that attempt are linked, including ones since closed/merged.
  Existing/updated PRs, timestamps, branch names, and previous attempts are never
  substituted as evidence of creation. The fleet's plain-text Renovate log format
  with timestamps and repository-scoped events is required (`LOG_LEVEL=debug`
  in the current workflows); a repository-finished event must also be present.
  A completed run with no creation event shows **No PR created by this run** and
  appears in **Needs attention**, even when the workflow is green. This is a
  review signal, not proof of failure: a run may legitimately have no updates or
  update an existing PR. Running workflows show **Awaiting run result**. Missing,
  expired, oversized, or unrecognized logs are **unverified**, never evidence of
  success. Log downloads require Actions read access and are bounded to 16 MiB
  compressed and total decompressed content per app per collection. Logs and
  signed download URLs stay server-side; credentials are not sent to log storage.
  Dependency API errors preserve other repository signals and any collected run
  status. No workflow/runs remains distinct from an API error.

The backend collects up to four apps concurrently, with request timeouts and a
50-second collection deadline, then waits 60 seconds before collecting again.
Browsers read the shared snapshot every 15 seconds; Refresh does not trigger new
upstream calls. Snapshots older than three minutes are stale. Kubernetes and GitHub
errors are independent per app. Credentials are never returned to the browser.

`GET /healthz` checks the server; `GET /api/apps` returns the latest snapshot (503
until initial collection completes). Production access is protected by the OIDC
proxy and an ingress NetworkPolicy. The app has no standalone authentication.

## Independent build and deployment

`Pipeline` tests PRs. Main pushes and manual runs publish:

```text
ghcr.io/mucsi96/observatory-app:sha-<full commit SHA>
```

Make the GHCR package public after its first publication so Kubernetes can pull it.
Once the provisioning module sets repository variable `DEPLOY_ENABLED=true`,
the pipeline also deploys the exact image it built, using Azure OIDC, kubelogin,
and the existing Twingate service account. Before provisioning, the deploy job is
skipped so the first image can be published independently.

Terraform supplies repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_KEYVAULT_NAME`, and `TWINGATE_SERVICE_KEY`.
The deploy identity reads only the platform vault's `k8s-oidc-config` secret and
can manage application Deployments/Services in the `observatory` namespace.
Runtime GitHub credentials stay in the platform-managed Kubernetes Secret.

Manual deployment after Azure login and Twingate authentication:

```bash
AZURE_KEYVAULT_NAME=p07 \
DASHBOARD_IMAGE=ghcr.io/mucsi96/observatory-app:sha-<full-commit> \
bash scripts/deploy.sh
```

The script applies `deploy/service.yaml` and `deploy/deployment.yaml`, preserving
the existing names, namespace, selector, and port. It restarts the workload to
reload configuration/credentials and waits for readiness. After platform inventory
or token changes, rerun the pipeline or `kubectl -n observatory rollout restart
deployment/observatory` to reload them.

## Handoff from p07

1. Publish this repository's first image and make its package public.
2. Apply the updated `setup_app_dashboard` module in p07 (Terraform 1.7+). Its
   `removed` blocks forget the old Terraform Deployment and Service **without
   deleting either**, and provision this repository's deploy identity and secrets.
3. Run `Pipeline` manually on main. The app adopts the existing resources with
   `kubectl apply` and rolls out the standalone image. The URL stays
   **https://apps.<dns-zone>**; OIDC, routing and runtime access rules retain their
   existing Terraform addresses.

The running image from p07 remains active until this handoff is applied and the
first standalone deployment succeeds. On fresh environments, provision the module
first, then run this pipeline to install the workload.
