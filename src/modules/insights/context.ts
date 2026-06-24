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
import { createDataAccessors } from "./data";

/** What the hub must supply for a context to be built. */
export interface ContextDeps {
  win: _ZoteroTypes.MainWindow;
  /** Stable id of the view this context is for (prefs namespace). */
  activeId: string;
  /** Shared status-line element. */
  statusEl: HTMLElement;
  /** Topbar slot a view may fill with its own controls. */
  controlsSlot: HTMLElement;
  /** Ask the hub to switch to the co-authorship view focused on an author. */
  focusAuthor(authorKey: string, label: string): void;
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

function readNetworkCap(): number {
  try {
    const v = Number(getPrefRaw("hub.networkCap"));
    if (isFinite(v) && v > 0) return Math.floor(v);
  } catch {
    /* ignore */
  }
  return 400;
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

/**
 * Drill-down: take the user to the library and run Zotero's quick search for
 * `text` (author name / year / source), so the matching papers filter into the
 * items list and they can browse them normally. Reversible by clearing the
 * search. We jump to My Library first so the search covers everything.
 */
async function searchLibraryIn(
  win: _ZoteroTypes.MainWindow,
  text: string,
): Promise<void> {
  const w = win as any;
  const q = (text || "").trim();
  if (!q) return;
  try {
    w.Zotero_Tabs?.select?.("zotero-pane");
    try {
      await w.ZoteroPane?.collectionsView?.selectLibrary?.(
        Zotero.Libraries.userLibraryID,
      );
    } catch {
      /* stay in the current collection if selecting the library fails */
    }
    const sb = win.document.getElementById("zotero-tb-search") as any;
    if (sb) {
      sb.value = q;
      if (typeof sb.doCommand === "function") sb.doCommand();
      else sb.dispatchEvent(new win.Event("command", { bubbles: true }));
    } else if (typeof w.ZoteroPane?.search === "function") {
      w.ZoteroPane.search(q);
    }
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] searchLibrary failed", e);
  }
}

export function buildContext(deps: ContextDeps): VizContext {
  const { win, activeId, statusEl, controlsSlot } = deps;

  const data: VizDataAccessors = createDataAccessors({
    getWin: () => win,
    // The data layer keys its cache on the source ("library" | "set"); pass the
    // source through the (frozen) getScope getter. Agent 5's data layer reads
    // `insights.source` for "set"; treating source as the scope key is by design.
    getScope: () => readSource() as unknown as VizScope,
    getNetworkCap: () => readNetworkCap(),
  });

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
    focusAuthor(authorKey: string, label: string) {
      // Clicking an author now finds their papers in the library (not a jump to
      // another graph). authorKey is unused; the display label drives the search.
      void authorKey;
      void searchLibraryIn(win, label);
    },
    searchLibrary(text: string) {
      void searchLibraryIn(win, text);
    },
    prefs: makePrefs(activeId),
    setStatus(text: string, opts?: { warn?: boolean }) {
      statusEl.textContent = text || "";
      statusEl.classList.toggle("bm-warn", !!opts?.warn);
    },
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
