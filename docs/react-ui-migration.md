# React UI integration

Observatory consumes the published `@mucsi96/react-ui` package (currently 0.2.0),
with its version resolved in `frontend/package-lock.json`. Assets are built into
the application and served locally by Rust.

## Current integration

- `Button` owns refresh and disclosure press/keyboard behavior.
- `TextField` and `Select` own accessible search and filtering, with visible labels.
- `Badge` owns semantic health/workflow tones and contextual counts.
- `Card`, `Heading`, and `Text` own surfaces and typography.
- `Alert` exposes unavailable signals and collector errors through live regions.
- All application component styles are CSS Modules, using public `--bt-*` tokens.
  `styles.css` is limited to document defaults and accent-token overrides; token
  overrides are on `:root` so portaled select options share the same theme.
- `ExternalLink` keeps upstream HTTPS URL validation before rendering a link.
- `FleetTable` keeps the semantic row headers, eight signal columns, independent
  disclosure state, and horizontally contained mobile scrolling.

### Strict Content Security Policy

React Aria Components 1.22.1 uses React Aria helpers that inject two static style
blocks: press-target touch behavior and mobile WebKit overlay scroll containment.
`src/web.rs` permits only their exact SHA-256 hashes in `style-src`; scripts remain
restricted to self and arbitrary inline styles remain blocked.

WebKit also emits an inline `text-overflow:inherit` compatibility probe. A separate
`style-src-attr` directive permits only that attribute's exact hash, using
`unsafe-hashes` rather than allowing arbitrary inline attributes.

The hashes correspond to the trimmed style text in the installed React Aria
`usePress` and `usePreventScroll` helpers. When upgrading React UI or its React Aria
dependencies, verify these styles again. The production-bundle browser tests
exercise press controls and the select overlay and reject console errors, including
CSP violations. Chromium covers the press style; the optional mobile WebKit
screenshot run verifies that the scroll style has actual CSS rules under CSP and
exercises touch filtering and disclosure with an iOS platform signal.

## Proposed React UI improvements

### 1. Expandable DataTable rows — highest value

Add a controlled disclosure API independent of selection:

```tsx
<DataTable
  caption="Production application signals"
  rows={apps}
  columns={columns}
  getRowKey={(app) => app.namespace}
  expandedKeys={expanded}
  onExpandedChange={setExpanded}
  renderRowDetails={(app) => <ApplicationDetailsContent app={app} />}
  getRowLabel={(app) => app.name}
  pagination={false}
  density="compact"
/>
```

The table should own the disclosure button, `aria-expanded`/`aria-controls`, stable
detail IDs, and the adjacent detail row's column span. Keep multiple rows open and
allow callers to retain expanded keys across filters, sorting, and polling.
Support a designated row-header column (`<th scope="row">`) and optional pagination;
the current table always paginates, even for a small live fleet.

This would replace Observatory's table scaffolding, row/disclosure layout, and
scroll styles with the shared library. Application-specific signal cells and
details content would remain small domain components. It is also useful for job,
deployment, inventory, and audit dashboards.

### 2. SearchField and compact filter controls

Provide a `SearchField` with a leading icon slot, built-in accessible clear action,
controlled search value, and Escape-to-clear behavior. Add `labelVisibility` and
size/density options to form controls while retaining accessible names.

This would simplify reusable table toolbars and remove repeated search/icon/label
layout across consumers. A library-owned `TableToolbar` is worth considering once
multiple consumers need the same responsive search/filter/action composition.

### 3. StatCard

Offer a small composition with `label`, `value`, and `description`, optionally an
icon or semantic tone. Preserve string/ReactNode values so `—` and partial totals
such as `3+` remain explicit. This would replace the repeated metric-card markup
and layout in `FleetSummary` and serve other monitoring dashboards.

### 4. Small primitive API improvements

- Add a constrained `as` prop to `Card` for `section`, `article`, and `div` so metric
  cards can use native article semantics without a role override.
- Let `Code` accept standard code-element attributes, including `className`, `title`,
  and `ref`. Observatory needs block layout, full-image tooltips, and wrapping for
  long container references; the current children-only API cannot express those.

### 5. Document strict-CSP support

Document React Aria's runtime style injection and its supported `csp-nonce` meta-tag
integration, plus hash-based integration for static HTML consumers. Include a
production-build gallery test under a restrictive CSP (with overlay/keyboard/touch
coverage), and identify dependency updates that change injected style hashes.
Prefer `CSS.supports` over inline style-attribute compatibility probes.

Where possible, ship static interaction styles in the package stylesheet through
an upstream-supported opt-out from runtime insertion. Consumers should not need
to rely on private DOM IDs or allow all inline styles to use ordinary buttons.
