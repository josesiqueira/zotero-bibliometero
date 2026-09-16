/**
 * insights/set/rowHighlight.ts — Insights-set membership cue in the item tree.
 *
 * Marks rows in Zotero's main item list according to their membership in the
 * active Insights scope, so you can see at a glance which papers are curated:
 *   - include mode: items IN the include list get a positive highlight (they
 *     are the analysed set).
 *   - exclude mode: items IN the exclude list are dimmed (dropped from analysis).
 *   - everything else renders normally.
 *
 * HOW IT HOOKS THE TREE. Zotero's ItemTree renders rows through a windowed list
 * (`itemsView.tree._jsWindow`). That object's `renderItem(index, oldElem)` is
 * the function actually invoked for every (re)painted row, including on scroll.
 * We chain it: call the original, then add/remove our class on the returned row
 * node based on the item at `index`. We also chain the instance/prototype
 * `_renderItem` (used by refreshAndMaintainSelection) and re-wrap after a
 * collection change rebuilds the windowed list. We wrap ON TOP of whatever is
 * already there (e.g. another row-decorating plugin) rather than replacing it.
 *
 * REPAINT. On a membership/mode change we re-render only the currently-rendered
 * rows (via `_jsWindow.rerenderItem` over `_renderedRows`), falling back to
 * `refreshAndMaintainSelection()`. Plain `tree.invalidate()` is NOT enough: it
 * does not re-run the row renderer for already-cached rows.
 *
 * STYLING. We inject our own <style> element (not the panel stylesheet) so the
 * rules are always present and fresh, independent of whether the Insights panel
 * is open and immune to chrome:// stylesheet caching.
 *
 * Defensive throughout: a failure to decorate one row must never break Zotero's
 * own rendering.
 */

import { insightsSet } from "./store";

const ROW_INCLUDED = "bm-row-included";
const ROW_EXCLUDED = "bm-row-excluded";
const STYLE_ID = "bibliometero-rowhighlight-style";
/** Marker set on our wrapper functions so we never double-wrap. */
const WRAP_FLAG = "__bibliometeroRowWrap";

const CSS = `
.row.${ROW_INCLUDED} {
  background-color: rgba(46, 160, 67, 0.18) !important;
  box-shadow: inset 3px 0 0 0 rgba(46, 160, 67, 0.95) !important;
}
.row.${ROW_INCLUDED}.selected {
  /* a just-added row is selected; keep the green visible (deeper when selected). */
  background-color: rgba(46, 160, 67, 0.34) !important;
}
.row.${ROW_EXCLUDED} {
  opacity: 0.45 !important;
}
`;

/** Windows we are currently decorating (for targeted repaint). */
const windows = new Set<any>();
/** Unsubscribe handle for the set-store subscription (set up once). */
let unsubscribe: (() => void) | null = null;
/** Debounce handle for repaint. */
let repaintTimer: ReturnType<typeof setTimeout> | null = null;
/** Prototypes we wrapped, so we can restore them on teardown. */
const wrappedProtos = new Set<any>();

/** Add/remove our membership class on a freshly-rendered row node. */
function decorateRow(view: any, index: number, node: any): void {
  if (!node || !node.classList) return;
  // Rows are recycled, so always clear our classes before re-deciding.
  node.classList.remove(ROW_INCLUDED, ROW_EXCLUDED);
  let item: any;
  try {
    item = view.getRow(index)?.ref;
  } catch {
    return;
  }
  if (!item || typeof item.isRegularItem !== "function") return;
  try {
    if (!item.isRegularItem()) return;
  } catch {
    return;
  }
  let mode: "exclude" | "include";
  let inActive: boolean;
  try {
    const lib = item.libraryID;
    mode = insightsSet.getMode(lib);
    inActive = insightsSet.has(lib, item.id);
  } catch {
    return;
  }
  if (!inActive) return; // not curated -> render normally
  node.classList.add(mode === "include" ? ROW_INCLUDED : ROW_EXCLUDED);
}

/** Inject (once per window) the membership-cue stylesheet. */
function ensureStyle(win: any): void {
  try {
    const doc = win.document;
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.documentElement || doc.head || doc.body)?.appendChild(style);
  } catch {
    /* styling is best-effort */
  }
}

/**
 * Wrap the windowed-list `renderItem` for an ItemTree instance so every painted
 * row is decorated. `view` is closed over so the decorator can resolve the item.
 */
function wrapJsWindow(view: any): void {
  try {
    const jw = view?.tree?._jsWindow;
    if (!jw || typeof jw.renderItem !== "function") return;
    if ((jw.renderItem as any)[WRAP_FLAG]) return; // already ours
    const orig = jw.renderItem;
    const wrapped = function (this: any, index: number, oldElem?: any): any {
      const node = orig.call(this, index, oldElem);
      try {
        decorateRow(view, index, node);
      } catch {
        /* never break row rendering */
      }
      return node;
    };
    (wrapped as any)[WRAP_FLAG] = true;
    (wrapped as any).__bmOrig = orig;
    jw.renderItem = wrapped;
  } catch {
    /* ignore */
  }
}

/** Wrap a prototype/instance `_renderItem` once (idempotent). */
function wrapRenderItem(target: any): boolean {
  try {
    const cur = target?._renderItem;
    if (typeof cur !== "function") return false;
    if ((cur as any)[WRAP_FLAG]) return true;
    const wrapped = function (this: any, ...args: any[]): any {
      const node = cur.apply(this, args);
      try {
        decorateRow(this, args[0], node);
      } catch {
        /* never break row rendering */
      }
      return node;
    };
    (wrapped as any)[WRAP_FLAG] = true;
    (wrapped as any).__bmOrig = cur;
    target._renderItem = wrapped;
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap `changeCollectionTreeRow` on the prototype so that after a collection
 * switch (which rebuilds the windowed list) we re-wrap and repaint.
 */
function wrapChangeCollection(proto: any): void {
  try {
    const cur = proto?.changeCollectionTreeRow;
    if (typeof cur !== "function" || (cur as any)[WRAP_FLAG]) return;
    const wrapped = function (this: any, ...args: any[]): any {
      const result = cur.apply(this, args);
      const after = () => {
        try {
          wrapJsWindow(this);
        } catch {
          /* ignore */
        }
        scheduleRepaint();
      };
      // changeCollectionTreeRow returns a promise; chain when possible.
      if (result && typeof result.then === "function") {
        result.then(after, after);
      } else {
        after();
      }
      return result;
    };
    (wrapped as any)[WRAP_FLAG] = true;
    (wrapped as any).__bmOrig = cur;
    proto.changeCollectionTreeRow = wrapped;
    wrappedProtos.add(proto);
  } catch {
    /* ignore */
  }
}

/** Ensure all hooks are in place for a window's current item view. */
function ensureWindowWrapped(win: any): void {
  ensureStyle(win);
  let iv: any;
  try {
    iv = win?.ZoteroPane?.itemsView;
  } catch {
    iv = null;
  }
  if (!iv) return;
  try {
    const proto = Object.getPrototypeOf(iv);
    if (proto) {
      if (wrapRenderItem(proto)) wrappedProtos.add(proto);
      wrapChangeCollection(proto);
    }
  } catch {
    /* ignore */
  }
  if (Object.prototype.hasOwnProperty.call(iv, "_renderItem")) {
    wrapRenderItem(iv);
  }
  wrapJsWindow(iv);
}

/** Re-render the currently-rendered rows of a window (cheap, no data reload). */
function repaintWindow(win: any): void {
  let iv: any;
  try {
    iv = win?.ZoteroPane?.itemsView;
  } catch {
    iv = null;
  }
  if (!iv) return;
  wrapJsWindow(iv); // the windowed list may have been rebuilt
  const jw = iv?.tree?._jsWindow;
  try {
    if (jw && jw._renderedRows && typeof jw.rerenderItem === "function") {
      for (const index of Array.from(jw._renderedRows.keys()) as number[]) {
        try {
          jw.rerenderItem(index);
        } catch {
          /* skip a bad row */
        }
      }
      return;
    }
  } catch {
    /* fall through to the heavier refresh */
  }
  try {
    iv.refreshAndMaintainSelection?.();
  } catch {
    /* best-effort */
  }
}

/** Repaint the item tree in every registered window (debounced). */
function scheduleRepaint(): void {
  if (repaintTimer) clearTimeout(repaintTimer);
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    for (const win of windows) {
      try {
        ensureWindowWrapped(win);
        repaintWindow(win);
        // A second pass on the next frame catches a transient state where the
        // windowed list had not finished (re)rendering its rows yet, so the
        // highlight always appears immediately rather than after the next click.
        win.requestAnimationFrame?.(() => {
          try {
            repaintWindow(win);
          } catch {
            /* best-effort */
          }
        });
      } catch {
        /* best-effort repaint */
      }
    }
  }, 80);
}

export const RowHighlight = {
  /** Start decorating the item tree in this window. Retries until the view exists. */
  registerWindow(win: any): void {
    windows.add(win);
    if (!unsubscribe) {
      try {
        unsubscribe = insightsSet.subscribe(() => scheduleRepaint());
      } catch {
        unsubscribe = null;
      }
    }
    // The itemsView may not exist yet at window load; retry a few times, then
    // do one repaint so any already-curated rows pick up the cue.
    let attempts = 0;
    const tryWrap = () => {
      if (!windows.has(win)) return;
      ensureWindowWrapped(win);
      const ready = !!win?.ZoteroPane?.itemsView?.tree?._jsWindow;
      if (ready) {
        repaintWindow(win);
        return;
      }
      if (attempts++ < 20) {
        try {
          win.setTimeout(tryWrap, 250);
        } catch {
          /* window gone */
        }
      }
    };
    tryWrap();
  },

  /** Stop tracking a window. */
  unregisterWindow(win: any): void {
    windows.delete(win);
    try {
      win?.document?.getElementById(STYLE_ID)?.remove();
    } catch {
      /* ignore */
    }
  },

  /** Tear down: restore wrapped prototypes, drop the style + subscription. */
  unregister(): void {
    if (repaintTimer) {
      clearTimeout(repaintTimer);
      repaintTimer = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
    for (const proto of wrappedProtos) {
      for (const key of ["_renderItem", "changeCollectionTreeRow"]) {
        try {
          const cur = proto[key];
          if (cur && (cur as any)[WRAP_FLAG] && (cur as any).__bmOrig) {
            proto[key] = (cur as any).__bmOrig;
          }
        } catch {
          /* ignore */
        }
      }
    }
    wrappedProtos.clear();
    for (const win of windows) {
      try {
        // Restore the windowed-list wrapper so a persisted _jsWindow does not
        // keep calling this (now stale) module's closure after a hot reload.
        const jw = win?.ZoteroPane?.itemsView?.tree?._jsWindow;
        const cur = jw?.renderItem;
        if (cur && (cur as any)[WRAP_FLAG] && (cur as any).__bmOrig) {
          jw.renderItem = (cur as any).__bmOrig;
        }
        win?.document?.getElementById(STYLE_ID)?.remove();
        win?.ZoteroPane?.itemsView?.refreshAndMaintainSelection?.();
      } catch {
        /* ignore */
      }
    }
    windows.clear();
  },
};
