/**
 * hub.ts - the Bibliometero "Insights" hub.
 *
 * Owns the chart/histogram toolbar button, the dedicated "Insights" tab, the
 * collapsible sidebar of six views, the topbar (active label + per-view controls
 * + Export PNG/SVG + Maximize), the shared status line, and the live VizModule.
 *
 * Per-window state mirrors GraphViewFactory: a Map<MainWindow,WinState>, a lazy
 * Zotero_Tabs.add({ data:{icon:""} }), a CSS <link> injected once per window, a
 * global notifier debounced into onDataChange, a ResizeObserver on the viewport,
 * and a matchMedia listener (theme.ts) that reapplies the theme class. Everything
 * is torn down in unregister / unregisterWindow.
 *
 * Rendering is delegated: the hub never draws. VizRegistry.create(id) yields a
 * fresh VizModule; the hub builds its VizContext (context.ts) and calls mount /
 * onResize / onThemeChange / onDataChange / exportPNG / exportSVG / destroy.
 */

import type { VizContext, VizModule } from "./types";
import { VizRegistry } from "./registry";
import { registerViews } from "./views";
import { buildContext } from "./context";
import {
  attachThemeWatcher,
  applyThemeClass,
  resolveTheme,
  ThemeWatcher,
} from "./theme";
import { saveExport } from "./save";
import { getPrefRaw, setPrefRaw } from "../../utils/prefs";

const TAB_TYPE = () => `${addon.data.config.addonRef}-insights`;
const BUTTON_ID = "bibliometero-insights-button";
const CSS_LINK_ID = "bibliometero-insights-css";
const DATA_DEBOUNCE_MS = 250;

/** Histogram (bars) icon, stroked with context-stroke for currentColor recolour. */
const HISTOGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="context-stroke" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><line x1="3" y1="21" x2="21" y2="21"/>' +
  '<rect x="4.5" y="11" width="3.4" height="8"/>' +
  '<rect x="10.3" y="6" width="3.4" height="13"/>' +
  '<rect x="16.1" y="13" width="3.4" height="6"/></svg>';

function svgDataUri(svg: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

/** Per-window hub state. Heavy DOM is created lazily on first tab open. */
interface WinState {
  win: _ZoteroTypes.MainWindow;
  tabId: string | null;
  container: HTMLElement | null;
  root: HTMLElement | null;
  sidebar: HTMLElement | null;
  navButtons: Map<string, HTMLButtonElement>;
  topbarLabel: HTMLElement | null;
  controlsSlot: HTMLElement | null;
  viewport: HTMLElement | null;
  statusEl: HTMLElement | null;
  current: VizModule | null;
  activeId: string | null;
  resizeObs: ResizeObserver | null;
  themeWatcher: ThemeWatcher | null;
  destroyed: boolean;
}

export const InsightsHub = (() => {
  const states = new Map<_ZoteroTypes.MainWindow, WinState>();
  const cssLinks = new WeakMap<_ZoteroTypes.MainWindow, HTMLLinkElement>();
  let notifierID: string | null = null;
  let dataTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- prefs helpers -------------------------------------------------

  function prefStr(key: string, fallback: string): string {
    try {
      const v = getPrefRaw(key);
      return typeof v === "string" && v.length ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function prefBool(key: string, fallback: boolean): boolean {
    try {
      const v = getPrefRaw(key);
      return typeof v === "boolean" ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function defaultView(): string {
    const id = prefStr("hub.defaultView", "coauthorship");
    return VizRegistry.has(id) ? id : "coauthorship";
  }

  function lastView(): string {
    const id = prefStr("hub.lastView", defaultView());
    return VizRegistry.has(id) ? id : defaultView();
  }

  // ---- lifecycle -----------------------------------------------------

  function register(): void {
    registerViews(); // idempotent
    if (notifierID) return;

    const callback = {
      notify: (event: string, type: string) => {
        try {
          onNotify(event, type);
        } catch (e) {
          ztoolkit.log("[Bibliometero Insights] notify error", e);
        }
      },
    };
    try {
      notifierID = Zotero.Notifier.registerObserver(
        callback as any,
        ["item", "collection", "tab"],
        "bibliometero-insights",
      );
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] notifier registration failed", e);
    }
  }

  function registerWindow(win: _ZoteroTypes.MainWindow): void {
    if (states.has(win)) return;
    injectCSS(win);
    injectButton(win);
    states.set(win, makeState(win));
  }

  function unregisterWindow(win: _ZoteroTypes.MainWindow): void {
    const st = states.get(win);
    if (st) {
      teardownState(st);
      states.delete(win);
    }
    removeButton(win);
    removeCSS(win);
  }

  function unregister(): void {
    if (notifierID) {
      try {
        Zotero.Notifier.unregisterObserver(notifierID);
      } catch {
        /* ignore */
      }
      notifierID = null;
    }
    if (dataTimer) {
      clearTimeout(dataTimer);
      dataTimer = null;
    }
    for (const st of states.values()) teardownState(st);
    states.clear();
    for (const win of Zotero.getMainWindows()) {
      removeButton(win);
      removeCSS(win);
    }
  }

  function makeState(win: _ZoteroTypes.MainWindow): WinState {
    return {
      win,
      tabId: null,
      container: null,
      root: null,
      sidebar: null,
      navButtons: new Map(),
      topbarLabel: null,
      controlsSlot: null,
      viewport: null,
      statusEl: null,
      current: null,
      activeId: null,
      resizeObs: null,
      themeWatcher: null,
      destroyed: false,
    };
  }

  // ---- CSS + button injection ----------------------------------------

  function injectCSS(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc || cssLinks.has(win) || doc.getElementById(CSS_LINK_ID)) return;
    const link = doc.createElement("link") as unknown as HTMLLinkElement;
    link.id = CSS_LINK_ID;
    link.setAttribute("type", "text/css");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute(
      "href",
      `chrome://${addon.data.config.addonRef}/content/insights.css`,
    );
    doc.documentElement?.appendChild(link);
    cssLinks.set(win, link);
  }

  function removeCSS(win: _ZoteroTypes.MainWindow): void {
    const link = cssLinks.get(win);
    if (link) {
      try {
        link.remove();
      } catch {
        /* ignore */
      }
      cssLinks.delete(win);
    }
    try {
      win.document?.getElementById(CSS_LINK_ID)?.remove();
    } catch {
      /* ignore */
    }
  }

  function injectButton(win: _ZoteroTypes.MainWindow): void {
    const doc = win.document;
    if (!doc) return;
    if (doc.getElementById(BUTTON_ID)) return;
    const toolbar = doc.getElementById("zotero-tabs-toolbar");
    if (!toolbar) return;

    const btn = doc.createXULElement("toolbarbutton") as any;
    btn.id = BUTTON_ID;
    btn.setAttribute("class", "zotero-tb-button bibliometero-insights-button");
    btn.setAttribute("tooltiptext", "Insights");
    btn.setAttribute("aria-label", "Insights");
    btn.style.listStyleImage = svgDataUri(HISTOGRAM_SVG);
    btn.addEventListener("command", () => openTab(win));

    // Anchor before Stylero's theme toggle if present, else the tabs menu.
    const anchor =
      doc.getElementById("stylero-theme-toggle") ||
      doc.getElementById("zotero-tb-tabs-menu");
    if (anchor && anchor.parentElement === toolbar) {
      toolbar.insertBefore(btn, anchor);
    } else {
      toolbar.insertBefore(btn, toolbar.firstChild);
    }
  }

  function removeButton(win: _ZoteroTypes.MainWindow): void {
    try {
      win.document?.getElementById(BUTTON_ID)?.remove();
    } catch {
      /* ignore */
    }
  }

  // ---- tab open / mount ----------------------------------------------

  function openTab(win: _ZoteroTypes.MainWindow): void {
    let st = states.get(win);
    if (!st) {
      st = makeState(win);
      states.set(win, st);
    }

    const Tabs = (win as any).Zotero_Tabs;
    if (!Tabs || typeof Tabs.add !== "function") {
      ztoolkit.log("[Bibliometero Insights] Zotero_Tabs.add unavailable");
      return;
    }

    if (st.tabId) {
      try {
        Tabs.select(st.tabId);
        return;
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
        onClose: () => onTabClosed(win),
      } as any);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] Tabs.add failed", e);
      return;
    }

    st.tabId = result.id;
    st.container = result.container;
    mountShell(st);
  }

  function onTabClosed(win: _ZoteroTypes.MainWindow): void {
    const st = states.get(win);
    if (!st) return;
    destroyActive(st);
    detachObservers(st);
    st.tabId = null;
    st.container = null;
    st.root = null;
    st.sidebar = null;
    st.navButtons.clear();
    st.topbarLabel = null;
    st.controlsSlot = null;
    st.viewport = null;
    st.statusEl = null;
    st.activeId = null;
  }

  function el(
    doc: Document,
    tag: string,
    cls?: string,
    text?: string,
  ): HTMLElement {
    const node = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElement;
    if (cls) node.setAttribute("class", cls);
    if (text != null) node.textContent = text;
    return node;
  }

  function mountShell(st: WinState): void {
    const doc = st.win.document;
    const container = st.container!;
    container.textContent = "";

    const root = el(doc, "div", "bm-hub-root");
    st.root = root;
    applyThemeClass(root, resolveTheme(st.win));

    // ---- sidebar ----
    const sidebar = el(doc, "div", "bm-hub-sidebar");
    st.sidebar = sidebar;
    if (prefBool("hub.sidebarCollapsed", false)) {
      sidebar.classList.add("bm-collapsed");
    }

    const brand = el(doc, "div", "bm-hub-brand", "Insights");
    sidebar.appendChild(brand);

    const nav = el(doc, "div", "bm-hub-nav");
    st.navButtons.clear();
    for (const entry of VizRegistry.list()) {
      const btn = el(doc, "button", "bm-hub-nav-btn") as HTMLButtonElement;
      btn.setAttribute("data-view-id", entry.id);
      btn.setAttribute("title", entry.label);
      const labelSpan = el(doc, "span", "bm-hub-nav-label", entry.label);
      btn.appendChild(labelSpan);
      btn.addEventListener("click", () => void activate(st, entry.id));
      nav.appendChild(btn);
      st.navButtons.set(entry.id, btn);
    }
    sidebar.appendChild(nav);
    root.appendChild(sidebar);

    // ---- main ----
    const main = el(doc, "div", "bm-hub-main");

    const topbar = el(doc, "div", "bm-hub-topbar");
    const topbarLabel = el(doc, "div", "bm-hub-active-label");
    st.topbarLabel = topbarLabel;
    topbar.appendChild(topbarLabel);

    const controlsSlot = el(doc, "div", "bm-hub-controls");
    st.controlsSlot = controlsSlot;
    topbar.appendChild(controlsSlot);

    const spacer = el(doc, "div", "bm-hub-topbar-spacer");
    topbar.appendChild(spacer);

    const exportPng = el(
      doc,
      "button",
      "bm-hub-btn bm-hub-export",
      "Export PNG",
    ) as HTMLButtonElement;
    exportPng.addEventListener("click", () => void doExport(st, "png"));
    topbar.appendChild(exportPng);

    const exportSvg = el(
      doc,
      "button",
      "bm-hub-btn bm-hub-export",
      "Export SVG",
    ) as HTMLButtonElement;
    exportSvg.addEventListener("click", () => void doExport(st, "svg"));
    topbar.appendChild(exportSvg);

    const maximize = el(
      doc,
      "button",
      "bm-hub-btn bm-hub-maximize",
      "Maximize",
    ) as HTMLButtonElement;
    maximize.setAttribute("title", "Collapse / expand sidebar");
    maximize.addEventListener("click", () => toggleSidebar(st));
    topbar.appendChild(maximize);

    main.appendChild(topbar);

    const viewport = el(doc, "div", "bm-hub-viewport");
    st.viewport = viewport;
    main.appendChild(viewport);

    const status = el(doc, "div", "bm-hub-status");
    st.statusEl = status;
    main.appendChild(status);

    root.appendChild(main);
    container.appendChild(root);

    attachObservers(st);

    // Activate the persisted view (default coauthorship).
    void activate(st, lastView());
  }

  // ---- view activation ------------------------------------------------

  async function activate(st: WinState, id: string): Promise<void> {
    if (st.destroyed || !st.viewport || !st.controlsSlot || !st.statusEl) {
      return;
    }
    if (!VizRegistry.has(id)) id = defaultView();

    destroyActive(st);
    st.viewport.textContent = "";
    st.controlsSlot.textContent = "";
    st.statusEl.textContent = "";
    st.statusEl.classList.remove("bm-warn");

    const mod = VizRegistry.create(id);
    if (!mod) return;
    st.current = mod;
    st.activeId = id;

    const entry = VizRegistry.list().find((e) => e.id === id);
    if (st.topbarLabel) st.topbarLabel.textContent = entry?.label || id;

    // Highlight nav.
    for (const [vid, btn] of st.navButtons) {
      btn.classList.toggle("bm-active", vid === id);
    }

    const ctx: VizContext = buildContext({
      win: st.win,
      activeId: id,
      statusEl: st.statusEl,
      controlsSlot: st.controlsSlot,
      focusAuthor: (key, label) => onFocusAuthor(st, key, label),
    });

    try {
      await mod.mount(st.viewport, ctx);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] view mount failed", id, e);
    }

    // Persist + initial size after mount.
    try {
      setPrefRaw("hub.lastView", id);
    } catch {
      /* ignore */
    }
    notifyResize(st);
  }

  function destroyActive(st: WinState): void {
    if (st.current) {
      try {
        st.current.destroy();
      } catch (e) {
        ztoolkit.log("[Bibliometero Insights] view destroy failed", e);
      }
      st.current = null;
    }
  }

  function onFocusAuthor(st: WinState, key: string, label: string): void {
    void label;
    void key;
    // Cross-link: switch to the co-authorship view. (The view reads selection
    // itself; we just bring it to front.)
    void activate(st, "coauthorship");
  }

  // ---- sidebar collapse ----------------------------------------------

  function toggleSidebar(st: WinState): void {
    if (!st.sidebar) return;
    const collapsed = st.sidebar.classList.toggle("bm-collapsed");
    try {
      setPrefRaw("hub.sidebarCollapsed", collapsed);
    } catch {
      /* ignore */
    }
    // Layout changed; let the view re-measure on the next frame.
    st.win.requestAnimationFrame(() => notifyResize(st));
  }

  // ---- export ---------------------------------------------------------

  async function doExport(st: WinState, fmt: "png" | "svg"): Promise<void> {
    if (!st.current) return;
    try {
      const result =
        fmt === "png"
          ? await st.current.exportPNG()
          : await st.current.exportSVG();
      await saveExport(st.win, result);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] export failed", fmt, e);
    }
  }

  // ---- observers ------------------------------------------------------

  function attachObservers(st: WinState): void {
    // ResizeObserver on the viewport.
    try {
      const ROCtor = (st.win as any).ResizeObserver as
        | (new (cb: () => void) => ResizeObserver)
        | undefined;
      if (ROCtor && st.viewport) {
        const obs = new ROCtor(() => notifyResize(st));
        obs.observe(st.viewport);
        st.resizeObs = obs;
      }
    } catch {
      st.resizeObs = null;
    }

    // matchMedia theme watcher: reapply class + notify active view.
    st.themeWatcher = attachThemeWatcher(st.win, () => {
      if (st.root) applyThemeClass(st.root, resolveTheme(st.win));
      try {
        st.current?.onThemeChange?.();
      } catch (e) {
        ztoolkit.log("[Bibliometero Insights] onThemeChange failed", e);
      }
    });
  }

  function detachObservers(st: WinState): void {
    if (st.resizeObs) {
      try {
        st.resizeObs.disconnect();
      } catch {
        /* ignore */
      }
      st.resizeObs = null;
    }
    if (st.themeWatcher) {
      st.themeWatcher.detach();
      st.themeWatcher = null;
    }
  }

  function notifyResize(st: WinState): void {
    if (!st.current || !st.viewport) return;
    const rect = st.viewport.getBoundingClientRect();
    const w = rect.width || st.viewport.clientWidth || 0;
    const h = rect.height || st.viewport.clientHeight || 0;
    if (w <= 0 || h <= 0) return;
    try {
      st.current.onResize?.(w, h);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] onResize failed", e);
    }
  }

  // ---- notifier (data change) ----------------------------------------

  function onNotify(event: string, type: string): void {
    if (!addon?.data?.alive) return;
    if (type === "tab" && event === "select") {
      // A tab became active; re-measure the (possibly previously zero-sized)
      // viewport for whichever window owns that tab.
      for (const st of states.values()) {
        if (st.tabId && !st.destroyed) {
          st.win.requestAnimationFrame(() => notifyResize(st));
        }
      }
      return;
    }
    // item/collection add/modify/delete/trash -> data is stale.
    scheduleDataChange();
  }

  function scheduleDataChange(): void {
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => {
      dataTimer = null;
      // The insights/data module owns its own notifier-driven cache
      // invalidation; the hub only re-renders the active view.
      for (const st of states.values()) {
        if (st.destroyed || !st.tabId) continue;
        try {
          st.current?.onDataChange?.();
        } catch (e) {
          ztoolkit.log("[Bibliometero Insights] onDataChange failed", e);
        }
      }
    }, DATA_DEBOUNCE_MS);
  }

  // ---- teardown -------------------------------------------------------

  function teardownState(st: WinState): void {
    st.destroyed = true;
    destroyActive(st);
    detachObservers(st);
    if (st.tabId) {
      try {
        (st.win as any).Zotero_Tabs?.close?.(st.tabId);
      } catch {
        /* ignore */
      }
      st.tabId = null;
    }
    st.container = null;
    st.root = null;
    st.sidebar = null;
    st.navButtons.clear();
    st.topbarLabel = null;
    st.controlsSlot = null;
    st.viewport = null;
    st.statusEl = null;
    st.activeId = null;
  }

  // ---- test hooks -----------------------------------------------------

  function activeStateForTest(): WinState | null {
    for (const st of states.values()) {
      if (st.tabId && !st.destroyed) return st;
    }
    return null;
  }

  function viewHooks(st: WinState | null): Record<string, any> {
    try {
      return st?.current?.testHooks?.() || {};
    } catch {
      return {};
    }
  }

  const test = {
    getActiveView(): string | null {
      return activeStateForTest()?.activeId ?? null;
    },
    async switchView(id: string): Promise<void> {
      const st = activeStateForTest();
      if (st) await activate(st, id);
    },
    getNodePositions(): any {
      const st = activeStateForTest();
      return viewHooks(st).getNodePositions?.();
    },
    isSettled(): boolean {
      const st = activeStateForTest();
      return !!viewHooks(st).isSettled?.();
    },
    dispatchPointer(...args: any[]): any {
      const st = activeStateForTest();
      return viewHooks(st).dispatchPointer?.(...args);
    },
    async exportView(id: string, fmt: "png" | "svg"): Promise<any> {
      const st = activeStateForTest();
      if (!st) return null;
      if (st.activeId !== id) await activate(st, id);
      if (!st.current) return null;
      return fmt === "png"
        ? await st.current.exportPNG()
        : await st.current.exportSVG();
    },
    getTooltipText(...args: any[]): any {
      const st = activeStateForTest();
      return viewHooks(st).getTooltipText?.(...args);
    },
  };

  // Surface read-only test hooks on the addon instance data.
  try {
    (addon.data as any).test = test;
  } catch {
    /* ignore */
  }

  return {
    register,
    registerWindow,
    unregisterWindow,
    unregister,
    openTab,
    test,
  };
})();
