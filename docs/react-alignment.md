# React alignment

Reviewed against [skeleton-app at 7bc4a5a](https://github.com/mucsi96/skeleton-app/tree/7bc4a5ade7126d7d26a2ebb28f23899138814b6f/client)
for [#40](https://github.com/mucsi96/observatory-app/issues/40).

## Application boundaries

- `main.tsx` composes StrictMode, QueryClientProvider and compile-time Faro settings.
- `src/api.ts` provides same-origin JSON transport and Zod response validation,
  with same-origin credentials, no caching and no automatic redirect following.
  A redirected API request becomes a recoverable error rather than a login document.
- `features/fleet/api.ts` owns snapshot queries and issue mutations, response schemas,
  domain errors and timeouts. TanStack Query retains the last successful snapshot,
  polls every 15 seconds and refreshes on focus. Writes never retry automatically
  or wait offline to replay later; counts remain collector-owned.
- `AddIssue` owns only the dialog, draft and synchronous duplicate-submit guard.
  Mutation state owns pending/error/success. Drafts survive failures and opening a
  new dialog resets the result. Dismissal is disabled during submission.
- Fleet presentation remains domain-oriented: dashboard orchestration, summary,
  table, rows, details and individual signals. Pure selectors derive display state;
  local hooks own timers and React state owns search/filter/expansion.
- Shared controls use `@mucsi96/react-ui`; layout uses colocated CSS Modules and
  public theme tokens. Keyboard focus, mobile overflow, safe links and partial
  signal errors are exercised in Playwright.

## Hosting and authentication

Vite's relative asset base, static Blob publication, same-origin API and telemetry,
and gateway-owned document authentication already match the reference. Deep links
are resolved by the gateway. Observatory retains its stricter CSP and its existing
JWT role and custom-header mutation protection; the reference backend's CSRF-cookie
protocol is not Observatory's API contract. GitHub credentials remain server-side.

## Dependencies and verification

The React, Query, Zod, react-ui, Faro, Vite, TypeScript and ESLint version ranges
already match the reference. Observatory's icon and Playwright dependencies serve
its existing UI and behavioral suite. No new runtime dependency is needed.

`npm --prefix frontend run typecheck` exposes the existing strict TypeScript check
independently; `build` runs it before bundling. CI continues to run lint, formatting,
the typed production build, Playwright UI/auth/collector tests, static-hosting
checks, screenshot captures and production-container verification before release.
Local development uses the authenticated test gateway described in the README.
The existing static deployment pipeline and backend remain compatible with this
frontend-only alignment.

Browser coverage includes mutation pending/dismissal/duplicate-submit behavior,
draft retention, explicit retry, dialog reset, expired sessions, denied roles,
malformed or invalid responses, and no automatic mutation retries, alongside the
existing fleet and hosting journeys. All behavioral tests remain in `frontend/e2e`.
