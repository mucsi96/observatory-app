# Observatory

A production fleet dashboard built with **Rust and React**. The backend uses Axum,
Tokio, Serde, Reqwest, and kube-rs; the frontend uses React, TypeScript, Vite,
TanStack Query, Zod, and [React UI](https://github.com/mucsi96/react-ui). Entra
authentication uses the platform's existing OIDC proxy. Build assets are served
directly from Azure Blob Storage, with no external font or CDN dependencies.

Extracted from [p07](https://github.com/mucsi96/p07) with its application history.
Provisioning lives in [k8s-modules](https://github.com/mucsi96/k8s-modules), module
`setup_app_dashboard`; p07 supplies the application inventory and platform inputs.

## Development

Requires Rust 1.99 (pinned in `rust-toolchain.toml`) and Node.js 24+.
Install Rust with [rustup](https://rustup.rs/). From the repository root:

```bash
npm --prefix frontend ci
npm --prefix frontend run build
cargo build --locked
node frontend/scripts/test-gateway.mjs
```

Open http://localhost:8080. Set `GITHUB_TOKEN` to read real repository data. Without
in-cluster credentials Kubernetes signals are explicitly **unknown**. The example
contains placeholder URLs, not demo data. The local server binds to loopback.
The local gateway supplies inline public config and ephemeral test JWTs.
The production container runs as a non-root process in a distroless image and
binds to `0.0.0.0:8080`.

### Architecture

- `src/model.rs`, `src/config.rs`: typed API models and validated JSON inventory.
  The existing `config.json`/ConfigMap shape and camelCase API remain compatible.
- `src/integrations/`: typed Kubernetes deployments and GitHub REST collectors.
  kube-rs defaults to in-cluster credentials and handles projected token rotation;
  local kubeconfig is never used. Explicit HTTPS endpoint/CA/token-file settings
  support configured environments and isolated end-to-end testing. TLS and error
  handling keep secrets server-side.
- `src/collector.rs`: bounded async collection, independent per-app signals, and
  an immutable snapshot shared through a Tokio watch channel. There is no database
  or persistent application state to migrate.
- `src/web.rs`, `src/main.rs`, `src/auth.rs`: authenticated Axum API routes,
  structured tracing (`RUST_LOG`), and SIGINT/SIGTERM shutdown.
- Rust modules use free functions with explicit inputs and typed data. Workload
  readiness and dependency evidence are pure transformations; HTTP collection and
  snapshot publication form the async I/O boundary. React uses function components
  and hooks.
- `frontend/src/features/fleet/`: schema-validated server state, React components,
  search/filter/expansion state, and signal selectors. TanStack Query owns polling,
  cancellation, focus refetches, and retention of the last successful snapshot.
- Shared controls, cards, badges, alerts, and typography use `@mucsi96/react-ui`.
  Component layout is co-located in CSS Modules and uses the library's public
  `--bt-*` tokens. `frontend/src/styles.css` contains only document defaults and
  Observatory's accent tokens; the library stylesheet is imported once in `main.tsx`.
  [Migration notes and reusable component proposals](docs/react-ui-migration.md)
  cover the expandable table and strict CSP integration.

Runtime settings: `CONFIG_FILE` (default `config.json`), `GITHUB_TOKEN` or
`GITHUB_TOKEN_FILE`, `LISTEN_ADDR` (default `127.0.0.1:8080`), and `RUST_LOG`.
`OIDC_ISSUER` and `API_CLIENT_ID` are required. The API validates RS256 signatures,
issuer, audience, expiry, `api-access` scope and `readApps` role.
The static client uses inline `window.__APP_CONFIG__` injected by the
client chart, with same-origin Faro telemetry at `/_telemetry/collect`.
The chart authenticates documents and owns nested SPA routing. Index HTML lives
in Azure's website container; all assets load directly from its public `assets`
Blob container with app-origin CORS. Deployment computes the CSP hash for the
exact inline config script and sets document response headers through Gateway
API, retaining strict script/style hashes and frame restrictions. CSP allows
assets only from the app and its specific Blob origin; APIs and telemetry stay
same-origin. There is no client image or Kubernetes client Deployment.

Optional server-side upstream settings are `GITHUB_API_URL` (default
`https://api.github.com`), `GITHUB_CA_FILE`, `KUBERNETES_API_URL`,
`KUBERNETES_CA_FILE`, and `KUBERNETES_TOKEN_FILE`. Explicit upstream endpoints must
use HTTPS. Kubernetes defaults to the in-cluster service account; when an endpoint
is configured, CA/token paths default to the same service-account directory.

### Verification

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend run build
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
bash -n scripts/deploy.sh
docker build -t observatory:local .
OBSERVATORY_CONTAINER_IMAGE=observatory:local npm --prefix frontend run test:e2e
```

**All behavioral tests live in `frontend/e2e/` and run through Playwright.** The
`ui` project loads the production React bundle through the local gateway and checks
filtering, expansion, partial totals, safe links, stale data, refresh recovery, CSP,
and mobile layout. The `collectors` project launches real Rust processes against
isolated HTTPS GitHub/Kubernetes/log-storage fixtures and checks readiness,
pagination, partial failures, credential isolation, dependency creation evidence,
and the actual 50-second collection deadline. There are no separate unit or
component test suites.

E2E requires OpenSSL, Chromium, the frontend build, and `target/debug/observatory`.
Stop other servers using port 8080 first. `npm --prefix frontend test` runs the same
Playwright suite; `npm --prefix frontend run test:watch` opens Playwright's UI.
Setting `OBSERVATORY_CONTAINER_IMAGE` selects the container E2E project, which
starts the image with a read-only filesystem and all Linux capabilities dropped.
Playwright waits for HTTP readiness before exercising the real UI and API. CI runs
this project after building the production image on PRs.

### Screenshot review

The pipeline captures desktop, expanded-row, mobile, filter-menu, and mobile WebKit
views from the production bundle and uploads them as the `dashboard-screenshots`
Actions artifact. Captures use illustrative E2E fixture data and are visual-review
evidence, not live production signals or pixel-diff baselines. Generated images
are saved in the ignored `frontend/test-results/screenshots/` directory.

After building the frontend and Rust binary, reproduce the captures locally:

```bash
npm --prefix frontend exec -- playwright install chromium webkit
SCREENSHOT_WEBKIT=1 npm --prefix frontend run screenshots
```

Without `SCREENSHOT_WEBKIT=1`, the script captures the four Chromium views. The
script starts an isolated Rust server, validates mobile overflow and application
errors, and exercises touch filtering and disclosure in WebKit. Playwright's
WebKit screenshot helper injects a temporary `body {}` repaint stylesheet that
the production CSP rejects; this known tooling-only warning is checked separately
after application verification and does not affect the captured pixels.

## Signals

- **Frontend / Backend:** stack labels such as **Angular / Java** or **React / Rust**,
  detected from manifests on the repository's default branch. Frontend detection
  recognizes Angular, React, Vue, Svelte, Solid, and Preact dependencies; backend
  detection recognizes Rust, Java/Kotlin, Go, Python, Ruby, PHP, C#/F#, and common
  Node.js server frameworks. Backend manifests must be at the repository root or
  in `backend`, `server`, `api`, `service`, or `services` directories. Frontend,
  tooling, test, example, and generated directories are excluded from backend
  detection. Unknown components are shown as **Unknown**, and collection failures
  remain visible without hiding health or repository signals. Detection reads up
  to 12 package manifests (256 KiB each), and rejects truncated repository trees.
  Successful manifest evidence is cached by repository and blob SHA in a bounded
  512-entry in-memory cache shared across collection cycles and concurrent apps.
  Repository trees are still refreshed each cycle, so changed manifests are
  collected immediately; failed or cancelled manifest reads are retried.
  These labels describe repository technologies, not the deployed image version.
  Search also matches stack labels. Optional app inventory overrides take
  precedence and can supply either or both components, including apps without a
  repository:

  ```json
  "stack": { "frontend": "Angular", "backend": "Java" }
  ```

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
   `PR created` and `PR updated` events in the latest run attempt's logs**, scoped to
   that repository. All affected PRs are linked, including ones since closed/merged,
   and the UI distinguishes creation, updates, and runs with both kinds of activity.
   Timestamps, branch names, and previous attempts are never substituted as evidence.
   The fleet's plain-text Renovate log format
  with timestamps and repository-scoped events is required (`LOG_LEVEL=debug`
  in the current workflows); a repository-finished event must also be present.
   A completed run with neither event shows **No PR created or updated by this run** and
  appears in **Needs attention**, even when the workflow is green. This is a
   review signal, not proof of failure: a run may legitimately have no updates.
   Running workflows show **Awaiting run result**. Missing,
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
until initial collection completes). Production access uses per-app oauth2-proxy
ForwardAuth, host-only `__Host-session` cookies, ingress NetworkPolicy and backend
JWT validation. The read-only API exposes no mutation endpoints.

## Independent build and deployment

The `Update dependencies` workflow runs Renovate every Monday and can also be
dispatched manually. It uses Node 24 and the latest Renovate release to propose
grouped Rust, frontend, and container dependency updates in `renovate/all`.
The dependency dashboard tracks pending updates.

`Pipeline` tests PRs. Main pushes and manual runs publish:

```text
ghcr.io/mucsi96/observatory-app-server:<number>
client-<number>: client-static.tar.gz release artifact
```

Make the GHCR package public after its first publication so Kubernetes can pull it.
Once the provisioning module sets repository variable `DEPLOY_ENABLED=true`,
the pipeline deploys the server image and tested static artifact using Azure OIDC, kubelogin,
and the existing Twingate service account. Before provisioning, the deploy job is
skipped so the first image can be published independently.

Terraform supplies repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_KEYVAULT_NAME`, and `TWINGATE_SERVICE_KEY`.
The deploy identity reads scoped secrets in the dedicated application vault:
`k8s-config`, `hostname`, `api-client-id`, `forward-auth-config`, and
`client-runtime-config`, and `client-storage-config`. It manages Helm application resources, Middleware and TraefikService
in the `observatory` namespace.
Runtime GitHub credentials stay in the platform-managed Kubernetes Secret.

The client builds directly with Node/npm. The tested `frontend/dist` artifact is
prepared by `frontend/scripts/static-client.mjs`, preserving bundle bytes while
making HTML asset URLs absolute. Official `azure/login` and `azure/cli` actions
batch-upload assets with Entra authentication, then publish index last. Old bundles
are retained. No Python upload script or client Docker build is involved.
The deploy identity has separately scoped upload permissions for `$web` and
`assets`. Azure website endpoints do not support CORS; browser requests use Blob.

The deploy script pins published `rust-app` **6.0.0** and `static-client-app` **4.0.0**.
It receives `CLIENT_CSP_FILE` from the preparation step; `contentSecurityPolicy`
is the only configurable document header. The chart fixes `Referrer-Policy` to
`no-referrer` and `X-Content-Type-Options` to `nosniff`. The backend
release remains `observatory`; `--take-ownership` adopts its existing resources.
The client release is `observatory-client`. Inventory is copied from the platform
ConfigMap into the chart config Secret; rerun deployment after inventory changes.
The workload identity account is `observatory-api-workload-identity`.

Component releases use `get-next-version`, publish only changed sources, and
forward the selected exact versions to deployment, including unchanged components.

### Shared UI hosting contract

Observatory, Cooking and Skeleton use `static-client-app` 4.0.0: the gateway
authenticates documents before rewriting deep links and injecting public config.
Build assets load anonymously from Blob; APIs and telemetry stay on the app host.
There is no browser OAuth implementation or environment-bootstrap fetch. Storage
contains public build content, not protected application data.

The three deployment secrets are `forward-auth-config` (the shared `.auth`
reference), `client-runtime-config` (public startup values), and
`client-storage-config` (account, document hostname and asset base URL). All
pipelines test the static artifact, upload assets first and index last, and retain
old bundles. Terraform owns storage/CORS/upload permissions and the proxy; app
charts own routes and authentication middleware.

Backend authorization remains stack-specific: Observatory validates JWTs on its
read-only API; Cooking checks JWT roles and mutation Origin; Skeleton uses Spring
Security CSRF with Angular XSRF. Observatory additionally retains its strict CSP
through the shared chart's `contentSecurityPolicy` setting.
