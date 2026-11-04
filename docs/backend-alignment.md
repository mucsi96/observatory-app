# Rust / Loco backend alignment

Reference: [skeleton-app](https://github.com/mucsi96/skeleton-app), reviewed for
[Observatory #39](https://github.com/mucsi96/observatory-app/issues/39).

## Application structure

- `App` implements Loco 1.2 `Hooks`: configuration loading, context initialization,
  route registration, serving and shutdown. `main` installs the Rustls provider
  and delegates to Loco's native CLI. Environment YAML configures logging and
  the HTTP listener; deployed environment variables retain precedence.
- Routes use Loco `AppRoutes`/`Routes` and Axum extractors. JWT authorization is
  attached to each API method, leaving only `/healthz` public. Issue controllers
  retain JSON/custom-header/Fetch-Metadata CSRF protection and the 128 KiB limit.
- The issue service owns inventory allowlisting, Unicode title/byte description
  limits, upstream creation, typed payloads/results, and sanitized domain errors.
  Controllers map those errors to the existing HTTP status and JSON contracts.
- The fleet service owns a cancellable collection task and a watch-channel snapshot.
  The serving hook starts exactly one collector after binding successfully. Native
  CLI inspection commands do not spawn it. The shutdown hook cancels and joins it;
  dropping the service also cancels/aborts the task on early exits.
- The serving hook retains Observatory's bounded HTTP shutdown (10 seconds), using
  Loco's signal handling. The collector retains its 50-second collection budget,
  four-app concurrency, 60-second pause and independent partial failures.

## Domain and operational decisions

Observatory has no database, persisted identifiers or mutable local data. Loco's
`with-db` feature, SeaORM migrations, seed/truncate hooks and the reference greeting
models therefore do not apply. Snapshot collection remains an in-process service;
a Redis queue or cron schedule would change its shared-snapshot/cadence contract.

The existing platform integration already supplies GitHub credentials through a
Kubernetes Secret, uses in-cluster rotating Kubernetes credentials, and reads
deployment settings from Key Vault through Azure OIDC. These remain the source of
truth. Importing Skeleton's database/Anthropic Key Vault clients would introduce
unrelated secrets and infrastructure. The deploy script explicitly selects the
production Loco environment, retains the workload-identity service account and
existing chart, inventory mount, readiness endpoint and resource names.

The non-root distroless image contains the binary plus framework YAML, runs the
native `start` command and supports the existing read-only filesystem contract.
No frontend API/schema or static-hosting changes are required. ETags and framework
fallback pages are disabled; existing no-store, CSP, response headers, body limits
and request timeout remain explicit.

## Verification contract

CI retains formatting, Clippy, locked Rust build, frontend checks, the full
Playwright suite and production-image E2E. The local gateway and isolated collector
fixtures invoke the native CLI from the repository root. Playwright additionally
checks native CLI commands, invalid runtime configuration, production-mode startup,
mounted-token precedence, initial-collection 503 and security headers, and graceful
SIGTERM during pending upstream requests. Existing tests cover API/JWT/CSRF behavior,
issue creation/errors, partial collections, real deadlines, polling and UI behavior.
