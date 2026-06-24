# Zotero Bibliometero

[![Zotero 9](https://img.shields.io/badge/Zotero-9-CC2936?style=flat-square&logo=zotero&logoColor=white)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=flat-square)](LICENSE)

Zotero Bibliometero turns your library into an interactive, force-directed knowledge
graph. See how your items connect by related links, shared authors, or shared tags,
in a dedicated tab. It is dependency-free: the graph is hand-rolled on a 2D canvas
(no PIXI, no d3), and the only runtime dependency is the Zotero plugin toolkit.

## What it does

- **Knowledge graph in its own tab.** Open from View, "Bibliometero: Graph View", or
  `Ctrl/Cmd+Alt+G`.
- **Four modes:** a help splash, `related` (Zotero related-item links), `author`
  (items linked to author nodes), and `tag` (items linked to tag nodes).
- **Three scopes:** the current view, the current selection plus its neighbours, or
  the whole library (regular items only, capped for performance).
- **Interactive:** drag and pin nodes, pan, wheel-zoom, double-click a node to open
  the item, and two-way selection sync with the item list. Rebuild and Fit buttons,
  plus a light/dark/auto theme.

## Install

Download `zotero-bibliometero.xpi` from the [latest release](../../releases/latest),
then in Zotero: Tools, Plugins, gear icon, Install Plugin From File. Requires Zotero 9.

## Settings

Open Zotero, Settings, Bibliometero, to set the default mode, scope, and theme. The
toolbar inside the graph tab controls the same options live.

## Development

```bash
npm install
npm start          # live-reload dev against a running Zotero
npm run build      # build + typecheck -> .scaffold/build/zotero-bibliometero.xpi
npx tsc --noEmit   # typecheck only
```

The graph lives in `src/modules/graphView.ts` plus `src/modules/graphView/`
(`forceSim.ts` Barnes-Hut/velocity-Verlet simulation, `graphData.ts` model builder,
`renderer.ts` canvas painter). Lifecycle wiring is in `src/hooks.ts`.

## License

[AGPL-3.0-or-later](LICENSE). Built on the
[windingwind zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) (AGPL).
