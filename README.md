# Observatory

Production fleet monitoring with **Go, Gin, GORM/PostgreSQL, and Angular Material**.
Authentication and frontend/testing conventions follow
[skeleton-app](https://github.com/mucsi96/skeleton-app).

## Structure

| Directory | Responsibility |
| --- | --- |
| `server/cmd/server` | Configuration, dependency wiring, HTTP listeners and graceful shutdown |
| `server/internal/auth` | Entra JWT verification and Gin authorization middleware |
| `server/internal/dashboard` | GitHub/Kubernetes collection, domain models and GORM snapshot repository |
| `server/internal/database` | PostgreSQL connection pool and additive schema migration |
| `server/internal/httpapi` | Gin API and separate management listener |
| `client/` | Angular 22 standalone components, Material theme, signals/resources and OIDC |
| `mock_upstream_server/` | Resettable GitHub/Kubernetes mock for integration tests |
| `test/` | Playwright fixtures, PostgreSQL helpers, mock OIDC and Podman test stack |
| `deploy/` | Values for the published Go and client Helm charts |

## Authentication

The UI loads `/api/environment` before Angular bootstrap and uses
`oidc-client-ts` with Entra authorization code + PKCE. It sends the **API access
JWT** in `Authorization: Bearer <token>`. The Gin middleware validates RS256
signature, tenant-specific issuer, API audience, expiry, and not-before, then
requires `api-access` scope and `readApps` role. The shared Terraform
`register_api` module assigns the role to the owner. Additional users need that
API app role. There is no OIDC proxy or header-based identity trust.

Like skeleton-app, the frontend has an injectable runtime environment,
signal-based `AuthService`, route guard, bearer and single-retry interceptors,
explicit single-flight refresh-token renewal, profile menu, Faro logging, and an
authority-error view that waits for user-initiated retry. Automatic silent-renew
timers/session iframes are disabled. PKCE state and user state use localStorage.

The test profile uses the same `mucsi96/mock-oidc-provider` container as
skeleton-app and exercises actual JWT verification. `MOCK_OAUTH2_SERVER_URI` is
accepted only with `APP_ENV=test`; authentication is never bypassed.

## Signals and persistence

* Kubernetes Deployment generations, replicas and conditions determine health;
  this is readiness, not an external synthetic uptime probe.
* Container images expose production versions and full image references.
* GitHub pull requests are paginated; checks and legacy commit statuses are
  combined. Issues exclude PRs and Renovate's Dependency Dashboard.
* Deployment status comes from the `deploy` job in recent main-branch
  `pipeline.yml` runs, not unrelated Pages/review workflows.
* Per-app upstream failures remain visible as unknown/partial results.

The collector queries up to four apps concurrently with a 50-second deadline,
then waits 60 seconds. GORM atomically upserts the latest snapshot for each
environment into `observatory.snapshots` (JSONB). Older concurrent writes cannot
replace newer snapshots. The snapshot survives process restarts; no unbounded
history is stored. Startup creates the table through GORM's additive migration.
Terraform provisions the dedicated PostgreSQL role/schema.

Angular polls the stored snapshot every 15 seconds while visible. Refresh reads
the same stored snapshot, rather than triggering upstream work. The UI retains
the previous result on errors and marks snapshots older than three minutes stale.

## Runtime configuration

`CONFIG_FILE` (default `config.json`) contains inventory and public Entra IDs; see
`config.example.json`. No runtime credentials are included in `/api/environment`.

| Environment variable | Purpose / default |
| --- | --- |
| `DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` | Required PostgreSQL credentials |
| `DB_PORT`, `DB_SSLMODE` | `5432`, `disable` (private in-cluster PostgreSQL) |
| `GITHUB_TOKEN` | Server-side GitHub API credential |
| `SERVER_PORT`, `MANAGEMENT_PORT`, `BASE_PATH` | `8080`, `8082`, `/api`; supplied by `go-app` |
| `POLL_INTERVAL` | Collector interval, `60s` |
| `GITHUB_API_URL` | `https://api.github.com` |
| `KUBERNETES_API_URL` | `https://kubernetes.default.svc` |
| `KUBERNETES_TOKEN_FILE`, `KUBERNETES_CA_FILE` | In-cluster service-account token/CA paths |

Public routes: `GET /api/environment`. Protected routes: `GET /api/apps` (503
until the first persisted snapshot, 401 for invalid/missing tokens, 403 for missing
scope/role). The separate management listener exposes `/health/liveness` and
`/health/readiness`; readiness checks PostgreSQL. Management routes are not served
on the public API listener.

## Development and tests

Requires Go 1.25+ (CI/build use 1.26), Node 24+, Podman, and Bash.

```bash
# Build and start real API, Angular/Nginx, PostgreSQL, mock OIDC,
# mock GitHub/Kubernetes, and Traefik in an isolated test pod.
bash scripts/pod_up.sh

# Run from test/
npm ci
npx playwright install chromium
npm test

# Run from server/ with the test pod running
TEST_DATABASE_HOST=localhost go test -race ./...
go vet ./...

# Run from the repository root when finished
bash scripts/pod_down.sh
```

The test UI is `http://localhost:8170`; mock OIDC is `8070`, mock upstream controls
are `3071`, and PostgreSQL is `5471`. `SKIP_BUILD=1 bash scripts/pod_up.sh` reuses
the test images. The stack has no production credentials. Playwright follows
skeleton-app's global setup, per-test DB/reset fixtures, semantic role selectors,
single worker, CI retries, traces/screenshots and failure console attachments.
It tests real login/PKCE, bearer-token enforcement, token renewal, auth errors,
fleet data/filtering, stale/partial results, mobile layout and cache headers.

For frontend-only editing, run `npm ci` and `npm start` from `client/`; Angular
uses port `4270` and proxies `/api` to a locally running API on `8080`. For a
production-like local API, copy `config.example.json` to `config.json`, set real
Entra IDs and DB variables, and run `go run ./cmd/server` from `server/` with
`CONFIG_FILE` pointing at that file. Local Entra login requires the registered
`http://localhost:4270/` redirect. For a dev frontend against the test API, change
the development proxy target to `http://localhost:8074`.

## Build and deploy

Main-branch CI tests the complete stack, then publishes immutable images:

* `ghcr.io/mucsi96/observatory-app-server:sha-<full commit SHA>`
* `ghcr.io/mucsi96/observatory-app-client:sha-<full commit SHA>`

Make both GHCR packages public for cluster pulls. Deployment uses GitHub OIDC,
Azure login, kubelogin, and Twingate. Terraform sets `DEPLOY_ENABLED` and the
repository's Azure/Twingate secrets.

`scripts/deploy.sh` installs **`mucsi96/go-app` 1.0.0** as release `observatory`
and **`mucsi96/client-app` 22.0.0** as release `observatory-client`, in namespace
`observatory`. Helm 3.17+ is needed for ownership adoption (CI pins 3.19.0).

```bash
AZURE_KEYVAULT_NAME=p07 \
SERVER_IMAGE=ghcr.io/mucsi96/observatory-app-server:sha-<full-commit> \
CLIENT_IMAGE=ghcr.io/mucsi96/observatory-app-client:sha-<full-commit> \
bash scripts/deploy.sh
```

The script reads Terraform-managed inventory and credentials, builds Helm values
in private temporary files, and removes them on exit. Go chart config/env Secrets
and checksum annotations reload changed settings automatically. The server image
uses Alpine so the chart's `sh -c 'sleep 10'` drain hook is available.

The charts own Deployments, Services, runtime Secrets, the API workload-identity
ServiceAccount and `/api`/`/` HTTPRoutes. Terraform owns inventory, source
credentials, PostgreSQL role/schema, Entra registrations, deployment/collector
RBAC, and the ingress NetworkPolicy. The collector still has only Deployment
list access in monitored namespaces. Deployment permissions are namespace-scoped
and include Helm's release Secrets and chart resources.

## Migration from the old embedded dashboard/proxy

1. Publish both new images. In p07, run `terraform init` to fetch the pinned
   updated dashboard module.
2. Provision registrations, inventory, PostgreSQL credentials and deploy RBAC
   before switching public routing. For the existing installation:
   ```bash
   terraform apply -target=module.setup_app_dashboard.kubernetes_config_map_v1.dashboard -target=module.setup_app_dashboard.kubernetes_secret_v1.database -target=module.setup_app_dashboard.kubernetes_role_v1.deploy -target=module.setup_app_dashboard.setup_observatory_api -target=module.setup_app_dashboard.setup_observatory_spa
   ```
3. Run the new pipeline. Helm adopts the existing `observatory` Deployment,
   Service and ServiceAccount, and installs the Angular client. The API enforces
   JWTs before the proxy is removed. The new management probes verify the server.
4. Apply the full p07 plan. Terraform forgets the adopted ServiceAccount without
   deleting it, removes the legacy HTTPRoute/proxy/webapp registration, and
   permits Traefik ingress to the two chart workloads. The shared Microsoft Graph
   principal is moved into the SPA registration rather than deleted.

Fresh installations can apply the full module before deploying. Re-run the app
pipeline after inventory/credential changes to refresh chart-managed Secrets.
