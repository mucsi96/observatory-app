# Observatory

A production fleet dashboard built with **Go and vanilla JavaScript**, restoring
the original dark dashboard and backporting the features added since October 11.
The backend uses the Go standard library without third-party Go dependencies.
Vite bundles the frontend, Zod validates snapshots, and Faro reports browser
telemetry. There is no React or Rust runtime or build dependency.

Extracted from [p07](https://github.com/mucsi96/p07) with its application history.
p07 owns inventory, Entra registrations, workload identity, ForwardAuth, storage
and permissions. This repository owns application builds, tests and deployment.
See [the rollback inventory](docs/stack-rollback.md).

## Development and verification

Requires Go 1.24+ (CI/container use 1.27.3), Node 24+, and OpenSSL for E2E fixtures.

```bash
go test -race ./...
go vet ./...
go build -o bin/observatory .
node --test scripts/app.test.cjs
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend exec -- playwright install chromium webkit
npm --prefix frontend run test:e2e
bash -n scripts/deploy.sh
```

Run `node frontend/scripts/test-gateway.mjs` to serve the built UI at
http://127.0.0.1:8080 with a local identity fixture. The gateway injects ephemeral
test JWTs; the real API independently verifies them. The API binds to loopback
by default, and to `0.0.0.0:8080` in the non-root production container.

`frontend/e2e/` retains the post-migration Playwright suites. The `ui` project
tests the production bundle, filtering, disclosure, stale/partial data, issue
creation and mobile layout. `collectors` launches real Go processes with isolated
HTTPS GitHub/Kubernetes/log-storage mocks. `auth` verifies JWT and mutation
boundaries. Original Go and vanilla rendering tests are restored as well.

```bash
docker build -t observatory:local .
OBSERVATORY_CONTAINER_IMAGE=observatory:local npm --prefix frontend run test:e2e
SCREENSHOT_WEBKIT=1 npm --prefix frontend run screenshots
```

The container suite runs with a read-only filesystem and capabilities dropped.
Screenshot captures cover desktop, expanded rows, mobile, filters, issue dialogs
and mobile WebKit. CI publishes these under `dashboard-screenshots`; they use
fixture data for visual review, not production signals or pixel baselines.

## Architecture and configuration

- `main.go`: inventory, bounded concurrent collection, shared snapshots and HTTP lifecycle.
- `github.go`, `dependencies.go`, `dependency_logs.go`, `stack.go`: repository
  signals, attempt-specific Renovate evidence, and cached technology detection.
- `kubernetes.go`: workload readiness and projected service-account token reads.
- `auth.go`, `issues.go`: independent JWT authorization and issue submission.
- `frontend/web/`: original vanilla dashboard/styles with feature backports.
- `frontend/main.js`: build-time Faro configuration and snapshot validation.

There is no database or persistent application state to migrate. Runtime variables:

| Variable | Contract |
| --- | --- |
| `CONFIG_FILE` | Inventory JSON; defaults to `config.json` |
| `OIDC_ISSUER`, `API_CLIENT_ID` | Required issuer and API audience |
| `LISTEN_ADDR` | Defaults to `127.0.0.1:8080` |
| `GITHUB_TOKEN_FILE` | Optional server-side token file, takes precedence over `GITHUB_TOKEN` |
| `GITHUB_API_URL`, `GITHUB_CA_FILE` | Optional HTTPS API endpoint/custom trust; default `https://api.github.com` |
| `KUBERNETES_API_URL`, `KUBERNETES_CA_FILE`, `KUBERNETES_TOKEN_FILE` | Optional HTTPS endpoint/trust/token; defaults to in-cluster service-account files |

Upstream redirects are disabled except a single validated HTTPS log-storage
redirect, which never receives GitHub credentials. OIDC allows HTTP only on
loopback for local fixtures. JWTs must have RS256 signatures, the configured
issuer/audience, valid expiry/not-before, `api-access` scope and `readApps` role.
Issue creation additionally requires `createIssues`. Keys refresh at bounded
intervals. Missing Kubernetes credentials produce explicit unknown signals.

Inventory entries without `namespace` track repositories only: supply `name`,
`repository` (`owner/repo`) and HTTPS `url`. Kubernetes is skipped and health is
**not applicable**. Repository-only entries require unique repositories. Optional
`deploymentWorkflow` selects a workflow filename instead of `pipeline.yml`.
Optional `stack: {"frontend":"Angular","backend":"Java"}` overrides detection
for either or both components.

## Signals

- **Frontend / Backend:** default-branch tree/manifests detect Angular, React,
  Vue, Svelte, Solid, Preact, Rust, Java/Kotlin, Go, Python, Ruby, PHP, C#/F# and
  common Node server frameworks. Tooling/tests/generated paths are excluded.
  Backend manifests must be at root or within backend/server/api/service/services,
  outside frontend/client/web/ui. Truncated trees and more than 12 manifests are
  rejected; each manifest is bounded to 256 KiB. Successful evidence is cached by
  repository/blob SHA in a bounded 512-entry cache; failed reads are retried.
  Unknown/partial labels and errors remain visible. Search includes stack labels.
- **Health:** Kubernetes observed generation, updated/available/desired replicas
  and failure conditions. Scaled-down workloads are degraded; an app namespace
  without deployments is not deployed; repository-only entries are not applicable.
  This is readiness, not an external uptime probe.
- **Production version:** deployed image tags/digests. OAuth2 Proxy images are
  hidden, while their workload readiness still contributes to health/details.
- **Last deployment:** the latest deploy job in the most recent 20 main-branch
  delivery runs, with paginated jobs. Active delivery pipelines are shown before
  the deploy job exists, independently of the latest deploy result. PR and
  unrelated workflows are excluded.
- **MRs / PRs:** paginated open PRs, drafts and individually linked accessible
  status icons. Checks and legacy statuses are combined; failure wins over running.
  Missing checks and unknown checks are distinct from success. A denied Checks API
  leaves PR checks unknown without hiding other repository signals.
- **Issues:** open issues excluding PRs and Renovate's Dependency Dashboard.
  Add issue works even when collection is unavailable. The dialog preserves drafts
  on errors, prevents duplicate submissions/dismissal while pending, and shows the
  created issue link. Requests are not automatically retried. The dedicated server
  GitHub token needs Issues write access and issues enabled on each repository;
  issues are authored by that token's account, not a browser GitHub login.
- **Dependency update:** discovers the weekly `update_dependencies.yml` separately
  from delivery history. Links come only from explicit repository-scoped Renovate
  `PR created`/`PR updated` events in the latest run attempt's logs, including closed
  and merged PRs. A repository-finished event is required. No affected PR is a
  review signal even after a green run; unavailable/incomplete logs are unverified,
  never proof of success. Downloads and total uncompressed content are limited to
  16 MiB. Logs, signed URLs, credentials and upstream response bodies stay private.

The collector handles four apps concurrently, with independent Kubernetes,
repository and technology signals, request timeouts and a 50-second collection
deadline. It waits 60 seconds between collections. Browsers poll snapshots every
15 seconds; snapshots older than three minutes are stale.

## API and authentication

`GET /healthz` is public. `GET /api/apps` requires read authorization and returns
503 until initial collection finishes. `POST /api/apps/refresh` requires read
authorization and `X-Observatory-Request: refresh`, triggers collection immediately,
and returns the fresh snapshot. Concurrent requests share an in-progress cycle;
the bounded queue rejects excess requests rather than multiplying upstream work.

`POST /api/issues` requires read and issue roles, JSON and
`X-Observatory-Request: create-issue`. Only configured repositories are accepted;
titles are 1–256 characters, descriptions at most 64 KiB, bodies at most 128 KiB.
Both mutations reject cross-origin Fetch Metadata and grant no CORS preflight
permissions. Browser credentials remain gateway-managed. Reload the Observatory
session after Entra role changes. Backend errors never expose upstream secrets.

## Build, static hosting and deployment

`Pipeline` tests PRs and publishes new numbered components on main:

```text
ghcr.io/mucsi96/observatory-app-server:<number>
client-<number>: client-static.tar.gz
```

`get-next-version` publishes only changed components and forwards exact versions,
including unchanged ones. Releases target the build commit. The server package
must be public for anonymous pulls. Publication/rollout are serialized.
`Update dependencies` uses Go/Node and Renovate to propose grouped updates weekly.

When `DEPLOY_ENABLED=true`, Azure OIDC, kubelogin and Twingate deploy the tested
artifact and image. Terraform supplies `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_KEYVAULT_NAME`, `TWINGATE_SERVICE_KEY`. The scoped
application vault supplies `k8s-config`, `hostname`, `api-client-id`,
`forward-auth-config`, and `client-storage-config`. The platform runtime Secret
`observatory-github` remains mounted at `/credentials`; inventory is copied from
the platform ConfigMap to the chart-owned config Secret. Redeploy after inventory
changes; restart the server after token rotation.

The existing `rust-app` **7.0.0** chart is a language-independent native HTTP process
chart; it now runs the Go image. Retaining it preserves the deployment/service
selector, workload-identity service account, credential mount and `/healthz`
probes without introducing infrastructure changes. There is no Rust code or
toolchain. Release names remain `observatory` and `observatory-client`, and the
client chart remains `static-client-app` **5.0.0**. Reset Helm values on upgrades.

Vite builds `frontend/dist`; `static-client.mjs` rewrites only document asset URLs.
Deployment empties `$web` and `assets`, uploads public Blob assets with one-year
caching, then index with `no-store`. Downtime/removal of old bundles is intentional.
Gateway ForwardAuth authenticates documents and handles SPA deep links; assets
load anonymously from Blob with app-origin CORS. CSP allows only self and the
specific asset origin, without inline scripts or general inline-style permission.
One exact style-attribute hash is retained for WebKit compatibility.
`CLIENT_CSP_FILE` feeds the
chart's `contentSecurityPolicy`. No client image, browser OAuth implementation,
runtime-config endpoint or HTML config injection is used. Faro's
`observatory-client` name and same-origin `/_telemetry/collect` URL are compiled in.
