# Observatory

A clean production fleet dashboard: Go standard library backend, embedded HTML/CSS,
and vanilla JavaScript. No npm packages, Go dependencies, database, external fonts,
or CDN assets. Entra authentication uses the platform's existing OIDC proxy.

Extracted from [p07](https://github.com/mucsi96/p07) with its application history.
Provisioning lives in [k8s-modules](https://github.com/mucsi96/k8s-modules), module
`setup_app_dashboard`; p07 supplies the application inventory and platform inputs.

## Development

Requires Go 1.24+ (CI uses 1.26). Node is needed only for the JS syntax check.

```bash
CONFIG_FILE=config.example.json go run .
go test -race ./...
go vet ./...
node --check web/app.js
bash -n scripts/deploy.sh
```

Open http://localhost:8080. Set `GITHUB_TOKEN` to read real repository data. Without
in-cluster credentials Kubernetes signals are explicitly **unknown**. The example
contains placeholder URLs, not demo data. The local server binds to loopback;
the container uses `LISTEN_ADDR=:8080` and runs as a non-root static binary.

## Signals

- **Health:** all Deployments in each app namespace, using observed generation,
  updated/available/desired replicas, and failure conditions. Scaled-down workloads
  are degraded, empty namespaces are not deployed, API failures are unknown.
  Health means Kubernetes readiness, not an external synthetic uptime probe.
- **Production version:** Deployment container image tags/digests, with separate
  frontend/backend images. Expand a row for full image references.
- **Last deployment:** the most recent `deploy` job found in the latest 20 main
  branch workflow runs, restricted to `pipeline.yml` and legacy `build.yml` delivery
  workflows (including Training Log Pro) to exclude unrelated Pages deployments.
  App descriptors can set `deploymentWorkflow` to restrict this to a single workflow.
  An absent job is shown as no recent deploy data. This repository uses the
  `pipeline.yml` convention.
- **MRs / PRs:** all open GitHub PRs (paginated), including drafts. Checks and legacy
  commit statuses are combined for the current head SHA. Failures take precedence
  over running checks; no checks is distinct from passed; API errors are unknown.
- **Issues:** open GitHub issues excluding PRs. Incomplete searches are rejected.

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
