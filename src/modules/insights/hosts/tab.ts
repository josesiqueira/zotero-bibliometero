/**
 * hosts/tab.ts - the pop-out tab HostController for the Insights shell.
 *
 * This is the "Maximize" target: a dedicated Zotero_Tabs tab that hosts the
 * exact same shell the bottom dock does. open(win) creates the tab, splits its
 * container into a header bar + a scrollable body, and returns those two host
 * elements for buildShell() to mount into. close(win) closes the tab.
 *
 * Per-window state (Map<MainWindow, TabState>) mirrors the dock host so the hub
 * can treat both uniformly. The tab's "Restore" button (wired by the hub via
 * setRestoreHandler) returns Insights to the dock.
 */

import type { HostController, HostMount } from "./types";

const TAB_TYPE = () => `${addon.data.config.addonRef}-insights`;

interface TabState {
  win: _ZoteroTypes.MainWindow;
  tabId: string | null;
  container: HTMLElement | null;
  header: HTMLElement | null;
  body: HTMLElement | null;
}

function xhtml(
  doc: Document,
  tag: string,
  cls?: string,
): HTMLElement {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElement;
  if (cls) node.setAttribute("class", cls);
  return node;
}

/**
 * The pop-out tab host. Created once per InsightsHub; tracks per-window tabs.
 * onTabClosed (passed in) lets the hub react when the user closes the tab via
 * its X rather than the Restore button.
 */
export class TabHost implements HostController {
  private readonly states = new Map<_ZoteroTypes.MainWindow, TabState>();
  private restoreHandler: ((win: _ZoteroTypes.MainWindow) => void) | null =
    null;
  private closedHandler: ((win: _ZoteroTypes.MainWindow) => void) | null =
    null;

  /** Called by the hub when the tab's Restore button is pressed. */
  setRestoreHandler(fn: (win: _ZoteroTypes.MainWindow) => void): void {
    this.restoreHandler = fn;
  }

  /** Called by the hub when the tab is closed by the user (its X). */
  setClosedHandler(fn: (win: _ZoteroTypes.MainWindow) => void): void {
    this.closedHandler = fn;
  }

  /** The host kind, surfaced to buildShell so it can render Restore vs Maximize. */
  kind(): "tab" {
    return "tab";
  }

  isOpen(win: _ZoteroTypes.MainWindow): boolean {
    const st = this.states.get(win);
    return !!(st && st.tabId);
  }

  /** Invoke the registered restore handler (used as the header button action). */
  triggerRestore(win: _ZoteroTypes.MainWindow): void {
    try {
      this.restoreHandler?.(win);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] tab restore handler failed", e);
    }
  }

  open(win: _ZoteroTypes.MainWindow): HostMount | null {
    let st = this.states.get(win);
    if (!st) {
      st = { win, tabId: null, container: null, header: null, body: null };
      this.states.set(win, st);
    }

    const Tabs = (win as any).Zotero_Tabs;
    if (!Tabs || typeof Tabs.add !== "function") {
      ztoolkit.log("[Bibliometero Insights] Zotero_Tabs.add unavailable");
      return null;
    }

    // If a tab already exists, just select it and re-use its body/header.
    if (st.tabId && st.body && st.header) {
      try {
        Tabs.select(st.tabId);
        return { body: st.body, header: st.header };
      } catch {
        st.tabId = null;
      }
    }

    let result: { id: string; container: HTMLElement };
    try {
      result = Tabs.add({
        type: TAB_TYPE(),
        title: "Insights",
        select: true,
        // Zotero 9 reads tab.data.icon during select(); omitting throws.
        data: { icon: "" },
        onClose: () => this.onTabClosed(win),
      } as any);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] Tabs.add failed", e);
      return null;
    }

    st.tabId = result.id;
    st.container = result.container;

    const doc = win.document;
    const container = result.container;
    try {
      container.textContent = "";
    } catch {
      /* ignore */
    }

    // The tab container is a plain box; build a column with a header bar and a
    // scrollable body so the shell mounts identically to the dock.
    const root = xhtml(doc, "div", "bm-host bm-host-tab");
    const header = xhtml(doc, "div", "bm-host-header");
    const body = xhtml(doc, "div", "bm-host-body");
    root.appendChild(header);
    root.appendChild(body);
    container.appendChild(root);

    st.header = header;
    st.body = body;
    return { body, header };
  }

  close(win: _ZoteroTypes.MainWindow): void {
    const st = this.states.get(win);
    if (!st) return;
    const tabId = st.tabId;
    st.tabId = null;
    st.container = null;
    st.header = null;
    st.body = null;
    if (tabId) {
      try {
        (win as any).Zotero_Tabs?.close?.(tabId);
      } catch {
        /* ignore */
      }
    }
  }

  private onTabClosed(win: _ZoteroTypes.MainWindow): void {
    const st = this.states.get(win);
    if (st) {
      st.tabId = null;
      st.container = null;
      st.header = null;
      st.body = null;
    }
    try {
      this.closedHandler?.(win);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] tab closed handler failed", e);
    }
  }

  /** Best-effort teardown for a window (window unload / plugin disable). */
  dispose(win: _ZoteroTypes.MainWindow): void {
    this.close(win);
    this.states.delete(win);
  }
}
