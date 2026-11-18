# Application stack previews

## Restored React layout (issue #53)

The last React dashboard is commit `1f597ae` (immediately before the Go/vanilla
rollback). Its production frontend was built in an isolated detached worktree
and served with Vite preview. Both versions below use the same `fleetSnapshot()`
fixture, Chromium, and 1600×1000 / 430×932 viewports; no production data is used.

| View | Last React version | Restored vanilla version |
| --- | --- | --- |
| Desktop | [Reference](react-reference-desktop.png) | [Restored](restored-desktop.png) |
| Mobile | [Reference](react-reference-mobile.png) | [Restored](restored-mobile.png) |

The restoration covers the system font, slate surfaces, purple accents, bright
status badges, header, summary cards, floating control labels, table, disclosures,
dialogs and responsive breakpoints. Native selects and dialogs preserve keyboard
and touch behavior. The footer identifies the actual Go/vanilla stack.

To reproduce the comparisons, build each frontend and serve its `dist` with Vite
preview on a distinct port. From the current checkout run:

```bash
node frontend/scripts/capture-layout-reference.mjs http://127.0.0.1:4174 docs/screenshots/react-reference
node frontend/scripts/capture-layout-reference.mjs http://127.0.0.1:4175 docs/screenshots/restored
```

The script checks for browser exceptions and document overflow. For expanded
rows, issue dialogs, filter menus and mobile Safari, use the existing
`SCREENSHOT_WEBKIT=1 npm --prefix frontend run screenshots` workflow.

## PR status icon follow-up (issue #53)

The remaining icon alignment regression used font glyphs inside CSS circles.
PR states now use fixed 20px inline SVG outlines, matching the last React
dashboard's circle-check, circle-X, loader, circle-minus and circle-help treatment.
Labels, tooltips, keyboard focus and 28px link targets are preserved.

The following crops show all five states in that order (wrapping with the table
column), using fixture data at 2× scale in the production bundle:

- [Desktop Chromium, 1600px viewport](pr-icons-chromium.png)
- [Mobile WebKit, 430px viewport](pr-icons-webkit.png)

The browser regression test checks SVG sizing, centered placement, transparent
backgrounds, accessible labels and link targets for every state.

## Earlier migration previews

Historical migration screenshots of the React bundle served by the Rust backend, using
illustrative end-to-end fixture data. These are visual-review images, not live
production signals or pixel-diff test baselines.

The fleet shows **React / Rust**, **Angular / Java**, and an undetected stack as
**Unknown / Unknown**.

## Desktop

1600 px viewport, showing the complete fleet table.

![Desktop fleet with frontend and backend stacks](app-stacks-desktop.png)

## Mobile

430 px viewport, with the horizontally scrollable table positioned to show the
frontend and backend stack column.

![Mobile fleet with frontend and backend stacks](app-stacks-mobile.png)
