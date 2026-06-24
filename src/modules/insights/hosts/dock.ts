/**
 * hosts/dock.ts - the resizable bottom dock HostController.
 *
 * Injects a dock BELOW the items list, inside the items-pane container (a column
 * vbox). Verified DOM:
 *
 *   #zotero-items-pane-container (vbox, column)
 *      #zotero-items-pane   (items toolbar + list; normally the only flexing child)
 *
 * We set #zotero-items-pane to flex:1 (so it shrinks), then append a thin resize
 * handle (manual pointer-drag) and a #bibliometero-dock vbox (remembered height)
 * holding a header bar + a scrollable body. This follows the VS Code terminal
 * model: the list stays visible above, the dock content scrolls when squeezed.
 *
 * close(win) removes the handle + dock and restores #zotero-items-pane's inline
 * style, so teardown leaves Zotero's layout exactly as found. Per-window state
 * lives in a Map<MainWindow, DockState>.
 */

import type { HostController, HostMount } from "./types";
import { getPrefRaw, setPrefRaw } from "../../../utils/prefs";

const CONTAINER_ID = "zotero-items-pane-container";
const ITEMS_PANE_ID = "zotero-items-pane";
const DOCK_ID = "bibliometero-dock";
const HANDLE_ID = "bibliometero-dock-handle";

const DEFAULT_HEIGHT = 340;
const MIN_DOCK = 120;
const MIN_LIST = 120;

const XUL_NS =
  "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

interface DragState {
  pointerId: number;
  startY: number;
  startHeight: number;
}

interface DockState {
  win: _ZoteroTypes.MainWindow;
  container: HTMLElement | null;
  itemsPane: HTMLElement | null;
  /** The inline `flex` value #zotero-items-pane had before we touched it. */
  prevItemsFlex: string | null;
  handle: HTMLElement | null;
  dock: HTMLElement | null;
  header: HTMLElement | null;
  body: HTMLElement | null;
  drag: DragState | null;
  onMove: ((e: PointerEvent) => void) | null;
  onUp: ((e: PointerEvent) => void) | null;
}

function dockHeightPref(): number {
  try {
    const v = Number(getPrefRaw("insights.dockHeight"));
    if (isFinite(v) && v >= MIN_DOCK) return Math.floor(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_HEIGHT;
}

function xulEl(doc: Document, tag: string, cls?: string): HTMLElement {
  let node: HTMLElement;
  try {
    node = (doc as any).createXULElement(tag) as HTMLElement;
  } catch {
    node = doc.createElementNS(XUL_NS, tag) as unknown as HTMLElement;
  }
  if (cls) node.setAttribute("class", cls);
  return node;
}

function htmlEl(doc: Document, tag: string, cls?: string): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (cls) node.setAttribute("class", cls);
  return node;
}

export class DockHost implements HostController {
  private readonly states = new Map<_ZoteroTypes.MainWindow, DockState>();
  private maximizeHandler: ((win: _ZoteroTypes.MainWindow) => void) | null =
    null;

  /** Wired by the hub: the header's Maximize button calls this. */
  setMaximizeHandler(fn: (win: _ZoteroTypes.MainWindow) => void): void {
    this.maximizeHandler = fn;
  }

  kind(): "dock" {
    return "dock";
  }

  isOpen(win: _ZoteroTypes.MainWindow): boolean {
    const st = this.states.get(win);
    return !!(st && st.dock && st.body && st.header);
  }

  /** Invoke the registered maximize handler (used as the header button action). */
  triggerMaximize(win: _ZoteroTypes.MainWindow): void {
    try {
      this.maximizeHandler?.(win);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] dock maximize handler failed", e);
    }
  }

  open(win: _ZoteroTypes.MainWindow): HostMount | null {
    const existing = this.states.get(win);
    if (existing && existing.dock && existing.body && existing.header) {
      return { body: existing.body, header: existing.header };
    }

    const doc = win.document;
    if (!doc) return null;

    const container = doc.getElementById(CONTAINER_ID) as HTMLElement | null;
    const itemsPane = doc.getElementById(ITEMS_PANE_ID) as HTMLElement | null;
    if (!container || !itemsPane) {
      ztoolkit.log(
        "[Bibliometero Insights] dock target not found",
        CONTAINER_ID,
        ITEMS_PANE_ID,
      );
      return null;
    }

    const st: DockState = existing || {
      win,
      container: null,
      itemsPane: null,
      prevItemsFlex: null,
      handle: null,
      dock: null,
      header: null,
      body: null,
      drag: null,
      onMove: null,
      onUp: null,
    };
    st.container = container;
    st.itemsPane = itemsPane;

    try {
      // Make the list flex so it shrinks to give the dock its height.
      st.prevItemsFlex = itemsPane.style.flex || "";
      itemsPane.style.flex = "1 1 0";
      itemsPane.style.minHeight = `${MIN_LIST}px`;

      // Resize handle (manual pointer-drag).
      const handle = htmlEl(doc, "div", "bm-dock-handle");
      handle.id = HANDLE_ID;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", "Resize Insights dock");
      st.handle = handle;

      // Dock container (XUL vbox so it lives happily among XUL siblings).
      const dock = xulEl(doc, "vbox", "bm-dock");
      dock.id = DOCK_ID;
      const height = dockHeightPref();
      dock.style.height = `${height}px`;
      dock.style.minHeight = `${MIN_DOCK}px`;
      st.dock = dock;

      const header = htmlEl(doc, "div", "bm-host-header");
      const body = htmlEl(doc, "div", "bm-host-body");
      dock.appendChild(header);
      dock.appendChild(body);
      st.header = header;
      st.body = body;

      container.appendChild(handle);
      container.appendChild(dock);

      this.wireDrag(st);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] dock open failed", e);
      this.close(win);
      return null;
    }

    this.states.set(win, st);
    return { body: st.body!, header: st.header! };
  }

  private wireDrag(st: DockState): void {
    const handle = st.handle;
    const dock = st.dock;
    const container = st.container;
    if (!handle || !dock || !container) return;

    const onMove = (e: PointerEvent) => {
      const drag = st.drag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      try {
        // Dragging up (smaller clientY) grows the dock.
        const delta = drag.startY - e.clientY;
        let next = drag.startHeight + delta;
        const containerH =
          container.getBoundingClientRect().height ||
          container.clientHeight ||
          0;
        const maxH = Math.max(MIN_DOCK, containerH - MIN_LIST);
        if (next < MIN_DOCK) next = MIN_DOCK;
        if (next > maxH) next = maxH;
        dock.style.height = `${Math.round(next)}px`;
      } catch {
        /* ignore */
      }
    };

    const onUp = (e: PointerEvent) => {
      const drag = st.drag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      st.drag = null;
      try {
        handle.releasePointerCapture?.(drag.pointerId);
      } catch {
        /* ignore */
      }
      handle.classList.remove("bm-dragging");
      // Persist the final height.
      try {
        const h = Math.round(dock.getBoundingClientRect().height || 0);
        if (h >= MIN_DOCK) setPrefRaw("insights.dockHeight", h);
      } catch {
        /* ignore */
      }
    };

    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      try {
        const startHeight =
          dock.getBoundingClientRect().height || dockHeightPref();
        st.drag = {
          pointerId: e.pointerId,
          startY: e.clientY,
          startHeight,
        };
        handle.setPointerCapture?.(e.pointerId);
        handle.classList.add("bm-dragging");
        e.preventDefault();
      } catch {
        /* ignore */
      }
    });
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);

    st.onMove = onMove;
    st.onUp = onUp;
  }

  close(win: _ZoteroTypes.MainWindow): void {
    const st = this.states.get(win);
    if (!st) return;

    // Remove the handle + dock.
    try {
      st.handle?.remove();
    } catch {
      /* ignore */
    }
    try {
      st.dock?.remove();
    } catch {
      /* ignore */
    }

    // Restore #zotero-items-pane inline style.
    try {
      if (st.itemsPane) {
        if (st.prevItemsFlex) {
          st.itemsPane.style.flex = st.prevItemsFlex;
        } else {
          st.itemsPane.style.removeProperty("flex");
        }
        st.itemsPane.style.removeProperty("min-height");
      }
    } catch {
      /* ignore */
    }

    st.handle = null;
    st.dock = null;
    st.header = null;
    st.body = null;
    st.drag = null;
    st.onMove = null;
    st.onUp = null;
    st.prevItemsFlex = null;
  }

  dispose(win: _ZoteroTypes.MainWindow): void {
    this.close(win);
    this.states.delete(win);
  }
}
