/**
 * context.ts - builds the VizContext handed to every view at mount.
 *
 * Wires the environment concerns the contract (types.ts) requires:
 *  - theme(): current ThemeInfo (re-read live so onThemeChange picks up flips).
 *  - source(): the `insights.source` pref ("library" | "set"). This replaces the
 *    old scope() concept. The data layer treats the source as its cache key, so
 *    we route source() through the accessors' getScope getter. scope() is kept
 *    only to satisfy the frozen VizContext contract (no view reads it).
 *  - data: accessors created by insights/data (createDataAccessors), parameterized
 *    by the active window, the current source, and the network node cap pref.
 *  - open/select/focus callbacks + per-view namespaced prefs + status + controls.
 *
 * The hub owns the active view id, the status element, and the controls slot;
 * context.ts reads them through the small ContextDeps surface so it never has to
 * import the hub (avoids a cycle).
 */

import type {
  VizContext,
  VizScope,
  VizPrefs,
  ThemeInfo,
  VizDataAccessors,
} from "./types";
import type { InsightsSource } from "./set/types";
import { paletteFor, resolveTheme } from "./theme";
import { getPrefRaw, setPrefRaw } from "../../utils/prefs";

/** What the hub must supply for a context to be built. */
export interface ContextDeps {
  win: _ZoteroTypes.MainWindow;
  /** Stable id of the view this context is for (prefs namespace). */
  activeId: string;
  /** Shared status-line element. */
  statusEl: HTMLElement;
  /** Topbar slot a view may fill with its own controls. */
  controlsSlot: HTMLElement;
  /** The window's shared data cache. */
  data: VizDataAccessors;
  /** Library the panel currently shows (click-throughs go there). */
  libraryID(): number;
}

/** The active data source: "library" (default) or the curated "set". */
function readSource(): InsightsSource {
  try {
    const v = getPrefRaw("insights.source");
    if (v === "set") return "set";
  } catch {
    /* ignore */
  }
  return "library";
}

function makePrefs(activeId: string): VizPrefs {
  const ns = (key: string) => `view.${activeId}.${key}`;
  return {
    get<T = unknown>(key: string, fallback: T): T {
      try {
        const v = getPrefRaw(ns(key));
        return v === undefined || v === null ? fallback : (v as T);
      } catch {
        return fallback;
      }
    },
    set(key: string, value: unknown): void {
      try {
        setPrefRaw(ns(key), value as any);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Reveal an item in the library tab and select it. The graph is usually built
 * from the whole library, so the item is often NOT in the collection currently
 * shown; selectItem() then silently fails. We first switch the collection tree to
 * the item's library root (My Library / the group) so the item is in view, then
 * select it. Returns the resolved item (or null).
 */
async function revealItem(
  win: _ZoteroTypes.MainWindow,
  itemId: number,
): Promise<Zotero.Item | null> {
  const w = win as any;
  const item = Zotero.Items.get(itemId) as Zotero.Item | false;
  if (!item) return null;
  w.Zotero_Tabs?.select?.("zotero-pane");
  const zp = w.ZoteroPane;
  // Try to select in the current view first; if that misses, fall back to the
  // item's library root and retry (covers the whole-library-scope case).
  try {
    const ok = await zp?.selectItem?.(itemId);
    if (ok) return item;
  } catch {
    /* fall through to library-root retry */
  }
  try {
    await zp?.collectionsView?.selectLibrary?.(item.libraryID);
    await zp?.selectItem?.(itemId);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] revealItem retry failed", e);
  }
  return item;
}

/** Open an item: reveal+select in the library tab, then open its reader view. */
function openItemIn(win: _ZoteroTypes.MainWindow, itemId: number): void {
  revealItem(win, itemId)
    .then((item) => {
      if (item) (win as any).ZoteroPane?.viewItems?.([item]);
    })
    .catch((e) => ztoolkit.log("[Bibliometero Insights] openItem failed", e));
}

/** Select an item in the tree without opening its reader. */
function selectItemIn(win: _ZoteroTypes.MainWindow, itemId: number): void {
  revealItem(win, itemId).catch((e) =>
    ztoolkit.log("[Bibliometero Insights] selectItem failed", e),
  );
}

/** Empty Zotero's quick-search box so a selection is not hidden by a filter. */
function clearQuickSearch(win: _ZoteroTypes.MainWindow): void {
  const sb = win.document.getElementById("zotero-tb-search") as any;
  if (sb && sb.value) {
    sb.value = "";
    if (typeof sb.doCommand === "function") sb.doCommand();
  }
}

/**
 * Drill-down: select exactly these items in the item list, so a bar that says
 * 12 leads to the same 12 items (a quick search on the label would match other
 * fields or nothing at all). Opens the library root the data came from, clears
 * the quick search, selects, and returns how many were selected.
 */
async function showItemsIn(
  win: _ZoteroTypes.MainWindow,
  libraryID: number,
  itemIds: number[],
): Promise<number> {
  const w = win as any;
  const ids = (itemIds || []).filter((n) => Number.isFinite(n));
  if (!ids.length) return 0;
  w.Zotero_Tabs?.select?.("zotero-pane");
  const zp = w.ZoteroPane;
  try {
    await zp?.collectionsView?.selectLibrary?.(libraryID);
  } catch {
    /* stay in the current view if the library cannot be selected */
  }
  clearQuickSearch(win);
  try {
    if (typeof zp?.selectItems === "function") await zp.selectItems(ids);
    else if (typeof zp?.selectItem === "function") await zp.selectItem(ids[0]);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] showItems failed", e);
    return 0;
  }
  try {
    return zp?.getSelectedItems?.().length ?? ids.length;
  } catch {
    return ids.length;
  }
}

/** Drill-down: navigate to a Zotero collection by id. */
async function openCollectionIn(
  win: _ZoteroTypes.MainWindow,
  collectionID: number,
): Promise<void> {
  const w = win as any;
  if (!Number.isFinite(collectionID)) return;
  try {
    w.Zotero_Tabs?.select?.("zotero-pane");
    clearQuickSearch(win);
    const cv = w.ZoteroPane?.collectionsView;
    if (typeof cv?.selectCollection === "function") {
      await cv.selectCollection(collectionID);
    } else if (typeof cv?.selectByID === "function") {
      await cv.selectByID("C" + collectionID);
    }
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] openCollection failed", e);
  }
}

export function buildContext(deps: ContextDeps): VizContext {
  const { win, activeId, statusEl, controlsSlot, data } = deps;

  const setStatus = (text: string, opts?: { warn?: boolean }) => {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("bm-warn", !!opts?.warn);
  };

  const ctx: VizContext = {
    win,
    doc: win.document,
    theme(): ThemeInfo {
      return paletteFor(resolveTheme(win));
    },
    // scope() kept only for the frozen VizContext contract (unused by views).
    scope(): VizScope {
      return "library";
    },
    data,
    openItem(itemId: number) {
      openItemIn(win, itemId);
    },
    selectItem(itemId: number) {
      selectItemIn(win, itemId);
    },
    showItems(itemIds: number[], what: string) {
      void showItemsIn(win, deps.libraryID(), itemIds).then((n) => {
        if (!n) {
          setStatus(`Could not select the items for ${what}.`, { warn: true });
          return;
        }
        const noun = n === 1 ? "item" : "items";
        setStatus(`Selected ${n} ${noun} in the item list: ${what}.`);
      });
    },
    openCollection(collectionID: number) {
      void openCollectionIn(win, collectionID);
    },
    scopeLabel(): string {
      let name = "My Library";
      try {
        name = Zotero.Libraries.getName(deps.libraryID()) || name;
      } catch {
        /* keep default */
      }
      return readSource() === "set" ? `Curated set in ${name}` : name;
    },
    prefs: makePrefs(activeId),
    setStatus,
    controlsSlot,
    log(...args: unknown[]) {
      ztoolkit.log(...args);
    },
  };

  // source() is the real accessor going forward. It is attached post-literal
  // because the frozen VizContext type does not (yet) declare it; views that
  // need the source read it via (ctx as any).source().
  (ctx as unknown as { source(): InsightsSource }).source = () => readSource();

  return ctx;
}
