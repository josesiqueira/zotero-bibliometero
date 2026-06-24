# Insights rework: bottom dock + curated set (build plan)

Two features, one rework. This file + the frozen contracts (`insights/types.ts`,
`insights/set/types.ts`) are the source of truth.

## A. Layout: resizable bottom dock (primary) + pop-out tab
- The chart button toggles a BOTTOM DOCK inside the library view (not a tab by default).
- DOM: inject into `#zotero-items-pane-container` (a vbox/column):
  `#zotero-items-pane` (flex:1, the list shrinks) + a `<splitter>` + `#bibliometero-dock`
  (remembered height). Dragging the splitter resizes the dock (VS Code terminal model).
  The list stays visible above. Content scrolls / has a min-height when squeezed.
- View nav becomes a HORIZONTAL tab strip in the dock header (not a left sidebar), with
  the source toggle + export + Maximize on the right.
- MAXIMIZE pops Insights out into the existing full Zotero_Tabs tab; restoring returns it
  to the dock. Dock and tab share ONE shell, ONE active view, ONE state (the shell mounts
  into whichever host is active).
- Caveats: behave gracefully in Zotero's "stacked" item-pane layout; restore the original
  layout cleanly on teardown/disable.

## B. Source + curated set
- Source toggle in the dock header: `Whole library` (default) | `Curated set (N)`.
  Backed by pref `insights.source` ("library" | "set"). Replaces the old hub.scope modes
  (library/view/selection are dropped).
- The set = a plugin-private, per-library list of item ids (NO tags), pref `insights.set`
  = JSON `{ [libraryID]: number[] }`. Single source of truth: `insightsSet` (implements
  `InsightsSetStore` from `insights/set/types.ts`).
- Add fast: right-click items -> "Add to Insights" / "Remove from Insights" (multi-select,
  label toggles by membership); right-click a collection -> "Add collection to Insights";
  in-dock "Add selection" button.
- The "Set" nav view (kind "manage", id "set"): a list of the set's papers (title, author,
  year), double-click to reveal in the library, a red trash per row to remove, a count +
  "Clear all", a friendly empty state, and an "Add current selection" button.
- Changing the source or the set refreshes the views live (existing onDataChange path).

## File ownership (5 coding agents, DISJOINT files)
- Agent 1 LAYOUT/HOSTING: `insights/hub.ts` (refactor: extract a `buildShell` that mounts
  nav-strip + topbar + viewport into a given host; orchestrate dock-default + maximize ->
  pop-out-to-tab + restore; horizontal nav; source toggle in header), `insights/hosts/dock.ts`,
  `insights/hosts/tab.ts`, `insights/context.ts` (source() accessor), `addon/content/insights.css`,
  `addon/prefs.js`, `typings/prefs.d.ts`, `addon/content/preferences.xhtml`,
  `addon/locale/en-US/preferences.ftl`. Do NOT edit hooks.ts (keep InsightsHub.register/
  registerWindow/unregister/unregisterWindow signatures; the orchestrator wires the rest).
- Agent 2 SET STORE: `insights/set/store.ts` -> exports singleton `insightsSet`
  implementing `InsightsSetStore`. Pref-backed JSON, per library, notifier prune, subscribe.
- Agent 3 CONTEXT MENUS: `insights/set/contextMenus.ts` -> `ContextMenus.registerWindow(win)/
  unregisterWindow(win)`: item-tree right-click Add/Remove (multi-select, membership-aware
  label) and collection-tree right-click "Add collection to Insights". Uses `insightsSet`.
- Agent 4 SET VIEW: `insights/views/setView.ts` -> `class SetView implements VizModule`
  (kind "manage", id "set"): the management list. Uses `insightsSet` + ctx.openItem.
- Agent 5 DATA SOURCE: extend `insights/data/extract.ts` (`gatherItems`) + `insights/data/index.ts`
  so source "set" gathers the set's items for the current library (via `insightsSet`); keep
  "library" working. The accessors already cache per scope; treat source as the scope key.

## Orchestrator-owned (frozen, already written)
- `insights/types.ts` (VizKind += "manage"), `insights/set/types.ts`, `insights/views/index.ts`
  (registers the 7 views incl. "set"), `src/hooks.ts` wiring (context menus + set init),
  final integration + live test.
