# Observatory

A small production fleet dashboard: Go standard library backend, embedded HTML/CSS,
and vanilla JavaScript. No npm packages, Go dependencies, database, external fonts,
or CDN assets. Entra authentication uses the platform's existing OIDC proxy.

## Local development

From `p07`, enter `nix develop`, then:

```bash
cd apps/dashboard
CONFIG_FILE=config.example.json go run .
```

Open http://localhost:8080. Set `GITHUB_TOKEN` in the process environment to read
real repository data. Without in-cluster credentials, Kubernetes signals are
explicitly **unknown**. The example contains placeholder app URLs, not demo data.
The server binds to loopback by default; the container sets `LISTEN_ADDR=:8080`.

```bash
go test -race ./...
go vet ./...
node --check web/app.js
```

## Signals

- **Health:** all Deployments in each provisioned app namespace, using observed
  generation, updated/available/desired replica counts and failure conditions.
  This includes the frontend and backend. A scaled-down deployment is degraded;
  an empty namespace is not deployed; an API failure is unknown. Health means
  Kubernetes readiness, not an independent external synthetic uptime probe.
- **Production version:** actual Deployment container image tags/digests, including
  separate frontend/backend versions. Expand the row for full image references.
- **Last deployment:** the most recent `deploy` job found in the latest 20 main
  branch workflow runs, restricted to `pipeline.yml` to exclude Pages deployments.
  An app descriptor can override `deploymentWorkflow`. If the recent window has
  no matching job, the UI says no recent deploy data rather than guessing.
- **MRs / PRs:** all open GitHub PRs (paginated), including drafts. Checks and legacy
  commit statuses are combined for each current head SHA. Failures take precedence
  over running checks; no checks is distinct from passed; API errors are unknown.
- **Issues:** open GitHub issues excluding PRs. Incomplete searches are rejected.

The backend collects at most four apps concurrently, with request timeouts and a
50-second collection deadline, then waits 60 seconds before collecting again.
Browsers read the shared cached snapshot every 15 seconds; Refresh reads that
snapshot without triggering additional upstream calls. Snapshots older than three
minutes are marked stale. Each app's Kubernetes and GitHub errors are independent.
Credentials and upstream response bodies are never included in API errors.

`GET /healthz` checks the server; `GET /api/apps` returns the latest snapshot (503
until initial collection completes). App data and UI are protected by OIDC in
production. The backend does not implement standalone user authentication.

## Build and deploy

The `Observatory` GitHub Actions workflow tests PRs and publishes a scratch-based,
non-root image on main to:

```text
ghcr.io/mucsi96/p07-observatory:sha-<full commit SHA>
```

Make the GHCR package public after first publication so Kubernetes can pull it.
The image has CA certificates, one static binary, and its embedded frontend.

In the p07 root, set `TF_VAR_dashboard_image` to that published image before
running the normal Terraform initialization and plan/apply process. Terraform owns
the dashboard deployment, config, credentials, read-only per-app RBAC, OIDC proxy,
HTTPRoute, and an ingress NetworkPolicy that admits only the OIDC proxy.
The existing GitHub token is sourced from Key Vault and supplied only to the Go
process. It needs repository metadata, Issues, Pull requests, Checks, Commit
statuses, and Actions read access for the observed repositories.

The URL is `https://apps.<dns-zone>`; the sign-in allowlist uses the same email as
Grafana. Existing wildcard DNS and the shared TLS Gateway cover this hostname.

The seven provisioned application modules and Observatory itself form the fleet.
Platform components (Grafana, databases, log collectors, and the bank email
forwarding worker) remain in the existing platform monitoring stack.

## Module development

`dashboard.tf` and the seven app module calls pin the immutable module commit from
[k8s-modules PR #136](https://github.com/mucsi96/k8s-modules/pull/136), so a sibling
checkout is not required. Run `terraform init` to refresh module sources. Merge
the module PR first; when its release is published, align the environment's
module pins to the release containing `dashboard_app` and `setup_app_dashboard`.

Adding an app means including its `dashboard_app` output in `dashboard.tf`'s
`apps` list; the dashboard config and namespace-scoped reader RBAC follow it.
