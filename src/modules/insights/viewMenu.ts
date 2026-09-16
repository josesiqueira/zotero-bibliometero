/**
 * insights/viewMenu.ts — "Show Bibliometero" checkbox in the View menu.
 *
 * Injects a `type="checkbox"` menuitem into the main window's View menu popup
 * (#menu_viewPopup). Clicking it toggles the Insights panel (same action as the
 * toolbar button); the checkmark is refreshed on every popupshowing to reflect
 * whether the panel is currently open.
 *
 * We patch the built-in popup directly (rather than ztoolkit.Menu.register) so
 * we keep precise, per-window teardown and so the checked state can be recomputed
 * each time the menu opens. Each window gets its own injected node + listener;
 * unregisterWindow removes both. Injection sweeps any pre-existing same-id node
 * first, so reloads never stack duplicates.
 */

import { InsightsHub } from "./hub";

const VIEW_MENU_POPUP_ID = "menu_viewPopup";
const TOGGLE_ID = "bibliometero-view-toggle";
const LABEL = "Show Bibliometero";

type AnyWindow = Window & typeof globalThis & { ZoteroPane?: any };

interface WindowState {
  popup?: Element;
  listener?: (event: Event) => void;
}

const states = new WeakMap<Window, WindowState>();

function log(...args: unknown[]): void {
  try {
    ztoolkit.log("[Bibliometero Insights] viewMenu", ...args);
  } catch {
    /* logging must never throw */
  }
}

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

function createCheckboxItem(doc: Document): Element {
  const ns = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const item = doc.createElementNS(ns, "menuitem");
  item.setAttribute("id", TOGGLE_ID);
  item.setAttribute("type", "checkbox");
  item.setAttribute("label", LABEL);
  return item;
}

/** Reflect the live open state in the checkmark each time the menu opens. */
function onPopupShowing(win: AnyWindow, item: Element): void {
  try {
    if (InsightsHub.isOpen(win as any)) {
      item.setAttribute("checked", "true");
    } else {
      item.removeAttribute("checked");
    }
  } catch (e) {
    log("onPopupShowing failed", e);
  }
}

function onCommand(win: AnyWindow): void {
  try {
    InsightsHub.toggleDock(win as any);
  } catch (e) {
    log("onCommand failed", e);
  }
}

function attach(win: AnyWindow): void {
  const doc = win.document;
  const popup = doc.getElementById(VIEW_MENU_POPUP_ID);
  if (!popup) {
    log("view menu popup not found in window");
    return;
  }

  // Sweep any stale item from a prior generation, then inject one fresh.
  sweepById(doc, TOGGLE_ID);

  const item = createCheckboxItem(doc);
  item.addEventListener("command", () => onCommand(win));
  popup.appendChild(item);

  const listener = () => onPopupShowing(win, item);
  popup.addEventListener("popupshowing", listener);

  states.set(win, { popup, listener });
}

export const ViewMenu = {
  /** Inject the "Show Bibliometero" checkbox into this window's View menu. */
  registerWindow(win: Window): void {
    try {
      const w = win as AnyWindow;
      // Clean any leftover from a previous registration before re-attaching.
      ViewMenu.unregisterWindow(win);
      attach(w);
    } catch (e) {
      log("registerWindow failed", e);
    }
  },

  /** Remove this window's injected menuitem and its popupshowing listener. */
  unregisterWindow(win: Window): void {
    const state = states.get(win);
    try {
      if (state?.popup && state.listener) {
        state.popup.removeEventListener("popupshowing", state.listener);
      }
    } catch (e) {
      log("unregisterWindow listener removal failed", e);
    }
    try {
      const doc = win.document;
      if (doc) sweepById(doc, TOGGLE_ID);
    } catch (e) {
      log("unregisterWindow node removal failed", e);
    }
    states.delete(win);
  },
};
