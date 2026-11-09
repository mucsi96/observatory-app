# Go and vanilla JavaScript restoration

Requested on 2026-11-09, extending the fleet rollback to Observatory while
backporting changes added after its October 11 React/Rust migration (PR #11).
The pre-migration reference is `21f164a`; this is a forward implementation commit,
not a reset of main or a deployment/database rollback.

## Backport inventory

| Changes | Retained behavior |
| --- | --- |
| #12, #22 | Dependency update recovery and created/updated PR evidence from attempt-specific logs |
| #13, #16 | Stack detection, overrides/search, and concise labels |
| #14 | Cached Playwright browsers in CI |
| #20, #21 | Gateway identity bootstrap, independent API JWT checks and Helm config-mount adoption |
| #23, #25, #27, #34 | Azure document/asset hosting, compiled Faro config, CORS/CSP and static cache contract |
| #28, #30 | Accessible linked PR status icons and explicit missing/unknown status |
| #31 | Repository-only inventory entries, independent expansion and not-applicable health |
| #32 | Active delivery pipelines alongside the last deploy job, including pre-deploy builds/tests |
| #36 | Hide OAuth2 Proxy image versions while preserving its readiness signals |
| #38 | In-dashboard issue creation, roles, same-origin mutation protection, validation and draft recovery |
| #47 | Manual refresh triggers actual backend collection, coalesces concurrent requests and returns fresh data |

The original dark CSS/layout is restored, with native controls and a native dialog
for new features. React-specific component alignment, shared-layout/loading
components and Loco framework changes are superseded by this implementation.
Frontend build tooling remains Vite with Faro and schema validation to preserve
the newer static-hosting and telemetry contracts. Go has no third-party modules.

Runtime names, routes, inventory format, service account, token-file mount and
release numbering remain compatible. The generic native-server Helm chart retains
its historical `rust-app` name but runs only a Go executable. No Terraform apply
or infrastructure rollback is required, and no persisted database exists.

Verification retains the post-migration authentication, collector and UI E2E
suites, adapting selectors to native controls and fixtures to the Go executable.
Original Go and vanilla rendering tests are restored. Screenshot artifacts cover
desktop/mobile disclosure, filters and issue dialogs for visual review.
