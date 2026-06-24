/**
 * context.ts - builds the VizContext handed to every view at mount.
 *
 * Wires the four environment concerns the contract (types.ts) requires:
 *  - theme(): current ThemeInfo (re-read live so onThemeChange picks up flips).
 *  - scope(): the `hub.scope` pref (library/view/selection).
 *  - data: accessors created by insights/data (createDataAccessors), parameterized
 *    by the active window, the current scope, and the network node cap pref.
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

function readScope(): VizScope {
  try {
    const v = getPrefRaw("hub.scope");
    if (v === "view" || v === "selection") return v;
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

/** Open an item: switch to the library tab, select, and open its view. */
function openItemIn(win: _ZoteroTypes.MainWindow, itemId: number): void {
  try {
    const w = win as any;
    w.Zotero_Tabs?.select?.("zotero-pane");
    w.ZoteroPane?.selectItem?.(itemId);
    const item = Zotero.Items.get(itemId) as Zotero.Item | false;
    if (item) w.ZoteroPane?.viewItems?.([item]);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] openItem failed", e);
  }
}

/** Select an item in the tree without opening it. */
function selectItemIn(win: _ZoteroTypes.MainWindow, itemId: number): void {
  try {
    const w = win as any;
    w.Zotero_Tabs?.select?.("zotero-pane");
    w.ZoteroPane?.selectItem?.(itemId);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] selectItem failed", e);
  }
}

export function buildContext(deps: ContextDeps): VizContext {
  const { win, activeId, statusEl, controlsSlot } = deps;

  const data: VizDataAccessors = createDataAccessors({
    getWin: () => win,
    getScope: () => readScope(),
    getNetworkCap: () => readNetworkCap(),
  });

  const ctx: VizContext = {
    win,
    doc: win.document,
    theme(): ThemeInfo {
      return paletteFor(resolveTheme(win));
    },
    scope(): VizScope {
      return readScope();
    },
    data,
    openItem(itemId: number) {
      openItemIn(win, itemId);
    },
    selectItem(itemId: number) {
      selectItemIn(win, itemId);
    },
    focusAuthor(authorKey: string, label: string) {
      deps.focusAuthor(authorKey, label);
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

  return ctx;
}
