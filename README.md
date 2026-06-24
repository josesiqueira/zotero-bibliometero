# Zotero Bibliometero

[![Zotero 9](https://img.shields.io/badge/Zotero-9-CC2936?style=flat-square&logo=zotero&logoColor=white)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=flat-square)](LICENSE)

Zotero Bibliometero adds an **Insights** panel to Zotero 9: a chart-icon button in the
tab bar opens a dedicated tab with six interactive visualizations of your library. It
is dependency-free (the networks are hand-rolled on a 2D canvas, the charts are plain
SVG; no PIXI, no d3, no Chart.js).

## The six views

| View | What it shows |
|---|---|
| Co-authorship network | Authors as nodes, an edge between authors who share a paper. Reads the creators field, correct for the whole library. |
| Author / paper | Bipartite network of your items and their authors (who wrote what). |
| Publications / year | Histogram of publications per year, with a bucket for undated items. |
| Top sources | Ranked bar chart of journals and conferences. |
| Top authors | Ranked bar chart of authors by item count. |
| Composition | Donut charts of your library by item type and by collection. |

- **Networks** are Obsidian-style and interactive: drag and pin nodes, pan, wheel-zoom,
  hover for details, and **single-click a paper node to open it** in Zotero. The layout
  settles to a stable rest (no jitter) and dragging a node does not disturb the rest of
  the graph.
- **Charts** are interactive on hover (tooltips with counts and percentages).
- **Every view exports to PNG and SVG** from the topbar.
- A **Maximize** button collapses the sidebar to give a view the whole tab.

## Install

Download `zotero-bibliometero.xpi` from the [latest release](../../releases/latest),
then in Zotero: Tools, Plugins, gear icon, Install Plugin From File. Requires Zotero 9.

## Settings

Open Zotero, Settings, Bibliometero, to set the default view, theme (auto/light/dark),
scope (whole library, current view, or selection), and the Top-N for the ranked charts.

## Development

```bash
npm install
npm start          # live-reload dev against a running Zotero
npm run build      # build + typecheck -> .scaffold/build/zotero-bibliometero.xpi
npx tsc --noEmit   # typecheck only
```

Architecture (`src/modules/insights/`): a frozen `VizModule` / `VizContext` contract
(`types.ts`), a `data/` layer (Zotero items to the six datasets, with a pure,
unit-testable aggregator), a `network/` engine (force simulation + canvas/SVG
rendering + a pointer interaction state machine), an SVG `charts/chartkit`, and the
`hub.ts` shell (toolbar button, tab, sidebar, export, theme). The only runtime
dependency is `zotero-plugin-toolkit`.

## License

[AGPL-3.0-or-later](LICENSE). Built on the
[windingwind zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) (AGPL).
