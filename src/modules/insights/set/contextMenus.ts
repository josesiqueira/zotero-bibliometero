import { insightsSet } from "./store";

/**
 * Right-click context menus for the Insights curated set.
 *
 * Two injected menu items, both driven by the live selection at popup time:
 *
 *   1. ITEM menu ("#zotero-itemmenu", id "bibliometero-set-toggle"):
 *      multi-select aware. If EVERY selected regular item is already in the set
 *      the label is "Remove from Insights" and a click removes them; otherwise
 *      the label is "Add to Insights" and a click adds the missing ones. Hidden
 *      when no regular item is selected.
 *
 *   2. COLLECTION menu ("#zotero-collectionmenu", id "bibliometero-set-collection"):
 *      "Add collection to Insights". A click adds the right-clicked collection's
 *      top-level regular items to the set. Shown only for real collection rows.
 *
 * We patch the built-in popups directly (rather than ztoolkit.Menu.register) so
 * the labels can be recomputed on every popupshowing and so we keep precise,
 * per-window teardown. Each window gets its own injected nodes and listeners;
 * unregisterWindow removes both. Injection sweeps any pre-existing same-id node
 * first, so reloads never stack duplicates.
 */

const ITEM_MENU_ID = "zotero-itemmenu";
const COLLECTION_MENU_ID = "zotero-collectionmenu";

const ITEM_TOGGLE_ID = "bibliometero-set-toggle";
const COLLECTION_ADD_ID = "bibliometero-set-collection";

const LABEL_ADD = "Add to Insights";
const LABEL_REMOVE = "Remove from Insights";
const LABEL_ADD_COLLECTION = "Add collection to Insights";

type AnyWindow = Window & typeof globalThis & { ZoteroPane?: any };

/** Per-window bookkeeping so we can detach exactly what we attached. */
interface WindowState {
  itemMenu?: Element;
  itemListener?: (event: Event) => void;
  collectionMenu?: Element;
  collectionListener?: (event: Event) => void;
}

const states = new WeakMap<Window, WindowState>();

function log(...args: unknown[]): void {
  try {
    ztoolkit.log("[Bibliometero Insights] contextMenus", ...args);
  } catch {
    /* logging must never throw */
  }
}

// ---- selection helpers -----------------------------------------------------

/** Selected regular (top-level, non-attachment/note) items, or []. */
function getSelectedRegularItems(win: AnyWindow): any[] {
  try {
    const pane = win.ZoteroPane;
    const items = pane?.getSelectedItems?.();
    if (!Array.isArray(items)) {
      return [];
    }
    return items.filter((it) => {
      try {
        return it && typeof it.isRegularItem === "function" && it.isRegularItem();
      } catch {
        return false;
      }
    });
  } catch (e) {
    log("getSelectedRegularItems failed", e);
    return [];
  }
}

/**
 * The library id for a set of selected items. All selected items share a
 * library in practice; we prefer ZoteroPane's accessor and fall back to the
 * first item's libraryID.
 */
function getSelectionLibraryID(win: AnyWindow, items: any[]): number | null {
  try {
    const pane = win.ZoteroPane;
    const fromPane = pane?.getSelectedLibraryID?.();
    if (typeof fromPane === "number") {
      return fromPane;
    }
  } catch {
    /* fall through to the item-based path */
  }
  try {
    const first = items[0];
    if (first && typeof first.libraryID === "number") {
      return first.libraryID;
    }
  } catch (e) {
    log("getSelectionLibraryID failed", e);
  }
  return null;
}

/** Numeric ids for a list of items, skipping anything without an id. */
function itemIDs(items: any[]): number[] {
  const ids: number[] = [];
  for (const it of items) {
    try {
      if (it && typeof it.id === "number") {
        ids.push(it.id);
      }
    } catch {
      /* skip */
    }
  }
  return ids;
}

/** The right-clicked / selected collection in this window, or null. */
function getSelectedCollection(win: AnyWindow): any | null {
  const pane = win.ZoteroPane;
  // Preferred: ZoteroPane convenience accessor (returns the collection or false).
  try {
    const coll = pane?.getSelectedCollection?.();
    if (coll && typeof coll.getChildItems === "function") {
      return coll;
    }
  } catch {
    /* fall through */
  }
  // Fallback: read the selected row off the collections tree and guard that it
  // is a real collection (not a saved search, library root, or special row).
  try {
    const view = pane?.collectionsView;
    const row =
      view && typeof view.selectedTreeRow !== "undefined"
        ? view.selectedTreeRow
        : view?.getRow?.(view?.selection?.focused);
    const ref = row?.ref;
    if (
      row &&
      typeof row.isCollection === "function" &&
      row.isCollection() &&
      ref &&
      typeof ref.getChildItems === "function"
    ) {
      return ref;
    }
  } catch (e) {
    log("getSelectedCollection fallback failed", e);
  }
  return null;
}

/** Top-level regular items inside a collection (non-recursive). */
function collectionRegularItems(collection: any): any[] {
  try {
    // getChildItems(asIDs=false, includeDeleted=false) -> top-level items.
    const items = collection.getChildItems(false, false);
    if (!Array.isArray(items)) {
      return [];
    }
    return items.filter((it) => {
      try {
        return (
          it && typeof it.isRegularItem === "function" && it.isRegularItem()
        );
      } catch {
        return false;
      }
    });
  } catch (e) {
    log("collectionRegularItems failed", e);
    return [];
  }
}

// ---- DOM helpers -----------------------------------------------------------

/** Remove every node with this id from the document (sweep duplicates). */
function sweepById(doc: Document, id: string): void {
  try {
    let el: Element | null;
    while ((el = doc.getElementById(id))) {
      el.remove();
    }
  } catch (e) {
    log("sweepById failed", id, e);
  }
}

function createMenuItem(doc: Document, id: string, label: string): Element {
  const ns =
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const item = doc.createElementNS(ns, "menuitem");
  item.setAttribute("id", id);
  item.setAttribute("label", label);
  return item;
}

// ---- item menu -------------------------------------------------------------

function onItemPopupShowing(win: AnyWindow, item: Element): void {
  try {
    const regular = getSelectedRegularItems(win);
    if (regular.length === 0) {
      item.setAttribute("hidden", "true");
      return;
    }
    item.removeAttribute("hidden");

    const libraryID = getSelectionLibraryID(win, regular);
    const ids = itemIDs(regular);
    if (libraryID == null || ids.length === 0) {
      item.setAttribute("hidden", "true");
      return;
    }

    const allIn = ids.every((id) => {
      try {
        return insightsSet.has(libraryID, id);
      } catch {
        return false;
      }
    });
    item.setAttribute("label", allIn ? LABEL_REMOVE : LABEL_ADD);
  } catch (e) {
    log("onItemPopupShowing failed", e);
    try {
      item.setAttribute("hidden", "true");
    } catch {
      /* nothing more we can do */
    }
  }
}

function onItemCommand(win: AnyWindow): void {
  try {
    const regular = getSelectedRegularItems(win);
    if (regular.length === 0) {
      return;
    }
    const libraryID = getSelectionLibraryID(win, regular);
    const ids = itemIDs(regular);
    if (libraryID == null || ids.length === 0) {
      return;
    }
    // toggle() adds if any are missing, else removes: matches the shown label.
    insightsSet.toggle(libraryID, ids);
  } catch (e) {
    log("onItemCommand failed", e);
  }
}

// ---- collection menu -------------------------------------------------------

function onCollectionPopupShowing(win: AnyWindow, item: Element): void {
  try {
    const coll = getSelectedCollection(win);
    if (!coll) {
      item.setAttribute("hidden", "true");
      return;
    }
    item.removeAttribute("hidden");
    item.setAttribute("label", LABEL_ADD_COLLECTION);
  } catch (e) {
    log("onCollectionPopupShowing failed", e);
    try {
      item.setAttribute("hidden", "true");
    } catch {
      /* nothing more we can do */
    }
  }
}

function onCollectionCommand(win: AnyWindow): void {
  try {
    const coll = getSelectedCollection(win);
    if (!coll) {
      return;
    }
    let libraryID: number | null = null;
    try {
      if (typeof coll.libraryID === "number") {
        libraryID = coll.libraryID;
      }
    } catch {
      /* fall through */
    }
    if (libraryID == null) {
      return;
    }
    const ids = itemIDs(collectionRegularItems(coll));
    if (ids.length === 0) {
      return;
    }
    insightsSet.add(libraryID, ids);
  } catch (e) {
    log("onCollectionCommand failed", e);
  }
}

// ---- registration ----------------------------------------------------------

function attachItemMenu(win: AnyWindow): void {
  const doc = win.document;
  const menu = doc.getElementById(ITEM_MENU_ID);
  if (!menu) {
    log("item menu not found in window");
    return;
  }

  // Sweep any stale item from a prior generation, then inject one fresh.
  sweepById(doc, ITEM_TOGGLE_ID);

  const item = createMenuItem(doc, ITEM_TOGGLE_ID, LABEL_ADD);
  item.addEventListener("command", () => onItemCommand(win));
  menu.appendChild(item);

  const listener = () => onItemPopupShowing(win, item);
  menu.addEventListener("popupshowing", listener);

  const state = states.get(win) ?? {};
  state.itemMenu = menu;
  state.itemListener = listener;
  states.set(win, state);
}

function attachCollectionMenu(win: AnyWindow): void {
  const doc = win.document;
  const menu = doc.getElementById(COLLECTION_MENU_ID);
  if (!menu) {
    log("collection menu not found in window");
    return;
  }

  sweepById(doc, COLLECTION_ADD_ID);

  const item = createMenuItem(doc, COLLECTION_ADD_ID, LABEL_ADD_COLLECTION);
  item.addEventListener("command", () => onCollectionCommand(win));
  menu.appendChild(item);

  const listener = () => onCollectionPopupShowing(win, item);
  menu.addEventListener("popupshowing", listener);

  const state = states.get(win) ?? {};
  state.collectionMenu = menu;
  state.collectionListener = listener;
  states.set(win, state);
}

export const ContextMenus = {
  /**
   * Inject the Insights menu items into this window's item and collection
   * popups. Idempotent: existing same-id nodes are swept before injecting.
   */
  registerWindow(win: Window): void {
    try {
      const w = win as AnyWindow;
      // Clean any leftover from a previous registration before re-attaching.
      ContextMenus.unregisterWindow(win);
      attachItemMenu(w);
      attachCollectionMenu(w);
    } catch (e) {
      log("registerWindow failed", e);
    }
  },

  /**
   * Remove this window's injected menu items and their popupshowing listeners.
   * Safe to call repeatedly and on windows that were never registered.
   */
  unregisterWindow(win: Window): void {
    const state = states.get(win);
    try {
      if (state?.itemMenu && state.itemListener) {
        state.itemMenu.removeEventListener("popupshowing", state.itemListener);
      }
      if (state?.collectionMenu && state.collectionListener) {
        state.collectionMenu.removeEventListener(
          "popupshowing",
          state.collectionListener,
        );
      }
    } catch (e) {
      log("unregisterWindow listener removal failed", e);
    }
    try {
      const doc = win.document;
      if (doc) {
        sweepById(doc, ITEM_TOGGLE_ID);
        sweepById(doc, COLLECTION_ADD_ID);
      }
    } catch (e) {
      log("unregisterWindow node removal failed", e);
    }
    states.delete(win);
  },
};
