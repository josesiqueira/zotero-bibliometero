# Bibliometero "Insights" — authoritative build plan (reconciled)

Synthesis of the 5 planning agents into ONE architecture. This file + `src/modules/insights/types.ts`
(the frozen contract) are the single source of truth. Where the agent reports differ, this wins.

## Product
A chart/histogram icon in the top tab toolbar (left of Stylero's moon, anchored at
`#zotero-tabs-toolbar` before `#stylero-theme-toggle ?? #zotero-tb-tabs-menu`). Clicking it opens a
dedicated Zotero tab ("Insights") with a collapsible LEFT sidebar listing 6 views and a large content
area. A Maximize button collapses the sidebar to an icon rail. Each view exports to PNG and SVG.

The 6 views (sidebar order):
1. `coauthorship` — co-authorship network (author nodes, edge = shared paper). Ship-first quality bar.
2. `author-paper` — author↔paper bipartite network.
3. `pubs-per-year` — publications-per-year histogram.
4. `top-sources` — ranked horizontal bar of journals/conferences.
5. `top-authors` — ranked horizontal bar of authors by item count.
6. `composition` — item-type donut + collection donut.

Networks render on Canvas (smooth at the 400-node cap); charts render as inline SVG (crisp, free hover,
trivial export). This split is deliberate.

## The three quality fixes (networks) — MANDATORY acceptance criteria
- NO JITTER: never `reheat()` on pointer-move; drag does `alpha = max(alpha, 0.3)` once. Replace every
  `Math.random()` in the force loop with a deterministic id-hash offset. Add a velocity-gated settle
  (stop when `alpha < ALPHA_MIN` AND maxSpeed < ~0.05px/tick; zero velocities on the final tick). At rest
  the rAF loop STOPS and node positions are pixel-stable across frames.
- SMOOTH DRAG: pointer state machine with a 4px click/drag threshold; hit-test slack in SCREEN pixels
  (>=8px); pin the dragged node to the cursor world point every move; handle `pointercancel`.
- ONE-CLICK TO PAPER: single click on an item node = switch to library tab + `selectItem` + `viewItems`.
  Hover an item node shows `cursor:pointer` + tooltip "Click to open · drag to pin". Author nodes:
  single click highlights their papers (no open).

## Canonical module layout (folder = `src/modules/insights/`)
```
insights/
  types.ts          FROZEN CONTRACT (orchestrator-owned): VizScope, ThemeInfo, ExportResult,
                    all 6 dataset shapes, VizContext, VizModule, VizFactory.
  registry.ts       VizRegistry (orchestrator-owned).
  views/index.ts    registerViews() barrel (orchestrator-owned): registers the 6 classes below.
  hub.ts            InsightsHub: toolbar button, tab open, sidebar nav, maximize, export buttons,
                    theme, ResizeObserver, notifier, builds VizContext, owns the active VizModule.
  context.ts        buildContext(): ThemeInfo palette + data accessors (wrap data/) + open/select cbs.
  theme.ts          resolveTheme/applyThemeClass/matchMedia helpers (light/dark/auto).
  save.ts           Export download: file picker + write Blob/text.
  data/
    extract.ts      Zotero.Item -> plain records (creators JSON, year, source, type, collections).
    aggregate.ts    PURE (no Zotero) record[] -> the 6 dataset objects. Unit-testable binary-free.
    index.ts        gatherItems(scope,win) + buildDatasets() (one pass) + cache + notifier invalidation.
  network/
    NetworkView.ts  reusable VizModule (canvas) parameterized by a GraphModel + node kinds.
    interaction.ts  pointer state machine (drag/pin/click-to-open/hover) — the quality fixes.
    scene.ts        drawScene(model,view,style,backend) + CanvasBackend + SvgBackend (PNG+SVG export).
  charts/
    chartkit/       svg.ts, scale.ts, axis.ts, palette.ts, tooltip.ts, legend.ts, exporter.ts, rankedBars.ts
    pubYearsChart.ts, topSourcesChart.ts, topAuthorsChart.ts, compositionChart.ts   (each a VizModule)
  views/
    coauthorshipView.ts   VizModule wrapping NetworkView + ctx.data.coauthorship()
    authorPaperView.ts    VizModule wrapping NetworkView + ctx.data.bipartite()
addon/content/insights.css
```
Engine reuse: `src/modules/graphView/forceSim.ts` and `renderer.ts` are RELOCATED/EVOLVED under
`insights/network/` (or kept and imported) by the network agent, with the jitter fixes applied. The OLD
`src/modules/graphView.ts` factory, `src/modules/graphView/graphData.ts`, the View-menu "Graph View"
item, the `Ctrl+Alt+G` shortcut, and the `graphView.*` prefs are REMOVED (superseded by the hub).

## Coding wave ownership (5 parallel agents; each owns DISJOINT files)
- A — data/: extract.ts, aggregate.ts, index.ts. Pure aggregate separated for unit tests.
- B — network engine + 2 network views: forceSim (fixed), NetworkView.ts, interaction.ts, scene.ts,
      views/coauthorshipView.ts, views/authorPaperView.ts, network cursor CSS.
- C — charts: charts/chartkit/*, charts/pubYearsChart.ts, topSourcesChart.ts, topAuthorsChart.ts,
      compositionChart.ts.
- D — hub shell + wiring: hub.ts, context.ts, theme.ts, save.ts, addon/content/insights.css, hooks.ts,
      addon/prefs.js, preferences.xhtml/ftl, typings/prefs.d.ts, toolbar button. REMOVES old graph.
- E — tests: test/*.test.ts (pure aggregate specs), test/live/harness.js, test:pure config.

Shared, orchestrator-owned (written BEFORE agents): types.ts, registry.ts, views/index.ts.

## Prefs (replace graphView.* in prefs.js)
`hub.lastView`, `hub.defaultView` (default "coauthorship"), `hub.sidebarCollapsed` (false),
`hub.theme` (auto), `hub.scope` (library), `hub.topN` (15), `hub.networkCap` (400).
Per-view prefs via `ctx.prefs` under `view.<id>.<key>` using new untyped `getPrefRaw/setPrefRaw`.

## Testing (3 layers; see types + harness)
A unit (pure aggregate: co-authorship adjacency, normalization/dedup, year parse, source-field per type,
top-N, composition). B smoke (tsc --noEmit, build, load, button injects, panel opens, 6 views mount, no
console errors). C live MCP (anti-jitter <0.5px/500ms at rest; drag tracks cursor <=3px no snap-back;
one-click opens the paper; chart hover tooltips; 12 exports valid PNG+SVG). Acceptance = AC-1..AC-6.
The plugin exposes a read-only `Zotero.ZoteroBibliometero.data.test` hook
(getActiveView/switchView/getNodePositions/isSettled/dispatchPointer/exportView/getTooltipText) so the
live harness drives behavior deterministically.
