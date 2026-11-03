/**
 * hub.ts - the Bibliometero "Insights" hub.
 *
 * Owns the chart/histogram toolbar button, the Insights SHELL (a horizontal nav
 * tab-strip + a topbar with source toggle, Export PNG/SVG and Maximize/Restore,
 * a viewport, and a status line), the live VizModule, and the host it is mounted
 * into. The shell is host-agnostic: buildShell(host) mounts it into whichever
 * host (bottom dock or pop-out tab) is active, so switching hosts keeps ONE
 * active view and ONE state.
 *
 * Default host is the resizable bottom dock (DockHost) inside the library view.
 * Maximize destroys the dock shell and rebuilds the same shell in a full Zotero
 * tab (TabHost); Restore returns it to the dock. The panel always opens in the
 * dock, on the view chosen in Settings (hub.defaultView).
 *
 * Per-window state is a Map<MainWindow, WinState>. Rendering is delegated:
 * VizRegistry.create(id) yields a fresh VizModule; the hub builds its VizContext
 * (context.ts) and drives mount / onResize / onThemeChange / onDataChange /
 * export / destroy. Everything is torn down in unregister / unregisterWindow.
 */

import type { VizContext, VizModule } from "./types";
import { VizRegistry } from "./registry";
import { registerViews, viewTooltip } from "./views";
import { buildContext } from "./context";
import {
  attachThemeWatcher,
  applyThemeClass,
  resolveTheme,
  ThemeWatcher,
} from "./theme";
import { saveExport } from "./save";
import { getPrefRaw, setPrefRaw } from "../../utils/prefs";
import { DockHost } from "./hosts/dock";
import { TabHost } from "./hosts/tab";
import type { HostController } from "./hosts/types";
import { insightsSet } from "./set/store";
import { paneLibraryID } from "./data/extract";
import { createDataAccessors, type DataAccessors } from "./data";

const BUTTON_ID = "bibliometero-insights-button";
const CSS_LINK_ID = "bibliometero-insights-css";
const DATA_DEBOUNCE_MS = 250;
const CSS_VERSION = Date.now();

/**
 * Chart icon: the bar-chart emoji rendered as the toolbar button image. Using a
 * colour emoji (instead of a context-stroke SVG) means it shows up without any
 * -moz-context-properties theming, which the button does not set.
 */
const HISTOGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<text x="12" y="20" font-size="20" text-anchor="middle" ' +
  'dominant-baseline="alphabetic">\u{1F4CA}</text></svg>';

function svgDataUri(svg: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
}

/** Per-window hub state. The shell DOM is rebuilt whenever the host changes. */
interface WinState {
  win: _ZoteroTypes.MainWindow;
  /** The host the shell currently lives in (dock or tab), or null when closed. */
  host: HostController | null;
  root: HTMLElement | null;
  navStrip: HTMLElement | null;
  navButtons: Map<string, HTMLButtonElement>;
  controlsSlot: HTMLElement | null;
  exportButtons: HTMLElement[];
  sourceLibraryBtn: HTMLButtonElement | null;
  sourceSetBtn: HTMLButtonElement | null;
  hostToggleBtn: HTMLButtonElement | null;
  viewport: HTMLElement | null;
  statusEl: HTMLElement | null;
  current: VizModule | null;
  activeId: string | null;
  resizeObs: ResizeObserver | null;
  themeWatcher: ThemeWatcher | null;
  setUnsub: (() => void) | null;
  /** One data cache per window, shared by every view activation. */
  data: DataAccessors | null;
  /** Bumped on every activation; a mount that finishes late is discarded. */
  activation: number;
  /** Per-activation containers, so a stale mount can never touch the live UI. */
  viewHost: HTMLElement | null;
  controlsHost: HTMLElement | null;
  /** Library the current view was rendered for (re-render when it changes). */
  libraryID: number | null;
  /** Detaches the collection-tree selection listener. */
  selectUnsub: (() => void) | null;
  destroyed: boolean;
}

export const InsightsHub = (() => {
  const states = new Map<_ZoteroTypes.MainWindow, WinState>();
  const cssLinks = new WeakMap<_ZoteroTypes.MainWindow, HTMLLinkElement>();
  let notifierID: string | null = null;
  let dataTimer: ReturnType<typeof setTimeout> | null = null;

  const dockHost = new DockHost();
  const tabHost = new TabHost();

  // ---- prefs helpers -------------------------------------------------

  function prefStr(key: string, fallback: string): string {
    try {
      const v = getPrefRaw(key);
      return typeof v === "string" && v.length ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function defaultView(): string {
    const id = prefStr("hub.defaultView", "coauthorship");
    return VizRegistry.has(id) ? id : "coauthorship";
  }

  function source(): "library" | "set" {
    return prefStr("insights.source", "library") === "set" ? "set" : "library";
  }

  function setSource(v: "library" | "set"): void {
    try {
      setPrefRaw("insights.source", v);
    } catch {
      /* ignore */
    }
  }

  // ---- lifecycle -----------------------------------------------------

  const prefObservers: symbol[] = [];
  /** True while the panel's own source switch writes the pref. */
  let changingSource = false;

  /** React when Settings change the theme or the source while the panel is open. */
  function observePrefs(): void {
    const prefix = addon.data.config.prefsPrefix;
    const watch = (key: string, fn: () => void) => {
      try {
        prefObservers.push(
          Zotero.Prefs.registerObserver(`${prefix}.${key}`, fn, true) as any,
        );
      } catch (e) {
        ztoolkit.log("[Bibliometero Insights] pref observer failed", key, e);
      }
    };
    watch("hub.theme", () => {
      for (const st of states.values()) {
        if (!st.root || st.destroyed) continue;
        applyThemeClass(st.root, resolveTheme(st.win));
        st.current?.onThemeChange?.();
      }
    });
    watch("insights.source", () => {
      if (changingSource) return;
      for (const st of states.values()) {
        if (!st.host || st.destroyed || !st.activeId) continue;
        updateSourceUI(st);
        const target =
          st.activeId === "set" && source() === "library"
            ? defaultView()
            : st.activeId;
        void activate(st, target);
      }
    });
  }

  function register(): void {
    registerViews(); // idempotent
    if (!prefObservers.length) observePrefs();
    try {
      (addon.data as any).test = test;
    } catch {
      /* ignore */
    }

    // Maximize (dock) -> pop out to a tab; Restore (tab) -> back to the dock.
    dockHost.setMaximizeHandler((win) => maximize(win));
    tabHost.setRestoreHandler((win) => restore(win));
    // If the user closes the pop-out tab via its X, drop our shell cleanly.
    tabHost.setClosedHandler((win) => onTabClosed(win));

    if (notifierID) return;

    const callback = {
      notify: (event: string, type: string, ids: Array<string | number>) => {
        try {
          onNotify(event, type, ids || []);
        } catch (e) {
          ztoolkit.log("[Bibliometero Insights] notify error", e);
        }
      },
    };
    try {
      notifierID = Zotero.Notifier.registerObserver(
        callback as any,
        ["item", "collection", "collection-item", "tab"],
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
    try {
      dockHost.dispose(win);
    } catch {
      /* ignore */
    }
    try {
      tabHost.dispose(win);
    } catch {
      /* ignore */
    }
    removeButton(win);
    removeCSS(win);
  }

  function unregister(): void {
    for (const sym of prefObservers.splice(0)) {
      try {
        Zotero.Prefs.unregisterObserver(sym as any);
      } catch {
        /* ignore */
      }
    }
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
      try {
        dockHost.dispose(win);
      } catch {
        /* ignore */
      }
      try {
        tabHost.dispose(win);
      } catch {
        /* ignore */
      }
      removeButton(win);
      removeCSS(win);
    }
  }

  function makeState(win: _ZoteroTypes.MainWindow): WinState {
    return {
      win,
      host: null,
      root: null,
      navStrip: null,
      navButtons: new Map(),
      controlsSlot: null,
      exportButtons: [],
      sourceLibraryBtn: null,
      sourceSetBtn: null,
      hostToggleBtn: null,
      viewport: null,
      statusEl: null,
      current: null,
      activeId: null,
      resizeObs: null,
      themeWatcher: null,
      setUnsub: null,
      data: null,
      activation: 0,
      viewHost: null,
      controlsHost: null,
      libraryID: null,
      selectUnsub: null,
      destroyed: false,
    };
  }

  /** The window's data cache, created on first use. */
  function dataFor(st: WinState): DataAccessors {
    if (!st.data) {
      st.data = createDataAccessors({
        getWin: () => st.win,
        getSource: () => source(),
        getNetworkCap: () => {
          const v = Number(getPrefRaw("hub.networkCap"));
          return isFinite(v) && v > 0 ? Math.floor(v) : 400;
        },
      });
    }
    return st.data;
  }

  function currentLibraryID(st: WinState): number {
    try {
      return (
        paneLibraryID((st.win as any).ZoteroPane) ??
        Zotero.Libraries.userLibraryID
      );
    } catch {
      return Zotero.Libraries.userLibraryID;
    }
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
      // The query string defeats Firefox's chrome cache, so an updated plugin
      // never runs with the previous version's stylesheet.
      `chrome://${addon.data.config.addonRef}/content/insights.css?v=${CSS_VERSION}`,
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
    btn.addEventListener("command", () => toggleDock(win));

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

  // ---- host open / toggle --------------------------------------------

  /** Toolbar-button action: toggle the bottom dock (close if open, else open). */
  function toggleDock(win: _ZoteroTypes.MainWindow): void {
    let st = states.get(win);
    if (!st) {
      st = makeState(win);
      states.set(win, st);
    }

    // If Insights is currently popped out to a tab, bring it back to the dock.
    if (st.host && st.host.kind() === "tab") {
      restore(win);
      return;
    }

    if (dockHost.isOpen(win) && st.host) {
      closeShell(st);
      return;
    }
    openIn(st, dockHost);
  }

  /** Build/mount the shell into the given host (dock or tab). */
  function openIn(st: WinState, host: HostController, viewId?: string): void {
    const mount = host.open(st.win);
    if (!mount) {
      ztoolkit.log("[Bibliometero Insights] host open returned no mount");
      return;
    }
    st.host = host;
    buildShell(st, mount.body, mount.header, viewId || defaultView());
  }

  /** Tear the shell down but leave the host chrome to its own close(). */
  function closeShell(st: WinState): void {
    const host = st.host;
    destroyActive(st);
    detachObservers(st);
    clearShellRefs(st);
    st.host = null;
    if (host) {
      try {
        host.close(st.win);
      } catch {
        /* ignore */
      }
    }
  }

  function clearShellRefs(st: WinState): void {
    st.root = null;
    st.navStrip = null;
    st.navButtons.clear();
    st.controlsSlot = null;
    st.exportButtons = [];
    st.sourceLibraryBtn = null;
    st.sourceSetBtn = null;
    st.hostToggleBtn = null;
    st.viewport = null;
    st.statusEl = null;
  }

  function onTabClosed(win: _ZoteroTypes.MainWindow): void {
    const st = states.get(win);
    if (!st) return;
    // The tab host already dropped its chrome; just drop our shell + state so
    // the next toolbar click reopens the dock.
    destroyActive(st);
    detachObservers(st);
    clearShellRefs(st);
    st.host = null;
  }

  // ---- maximize / restore --------------------------------------------

  /** Dock -> tab. Destroy the dock shell, rebuild in a tab, re-activate same view. */
  function maximize(win: _ZoteroTypes.MainWindow): void {
    const st = states.get(win);
    if (!st) return;
    const keepId = st.activeId || defaultView();
    closeShell(st);
    openIn(st, tabHost, keepId);
  }

  /** Tab -> dock. Destroy the tab shell, rebuild in the dock, re-activate. */
  function restore(win: _ZoteroTypes.MainWindow): void {
    const st = states.get(win);
    if (!st) return;
    const keepId = st.activeId || defaultView();
    closeShell(st);
    // Closing the Insights tab makes Zotero select its neighbour, often a PDF
    // reader tab. The dock lives under the item list, so show the library.
    try {
      (win as any).Zotero_Tabs?.select?.("zotero-pane");
    } catch (e) {
      ztoolkit.log(
        "[Bibliometero Insights] could not select the library tab",
        e,
      );
    }
    openIn(st, dockHost, keepId);
  }

  // ---- shell construction (host-agnostic) ----------------------------

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

  /**
   * Build the shell into the host's header + body. The header gets the
   * horizontal nav tab-strip (left) and the source toggle + export + host
   * toggle (right). The body gets the viewport + status line.
   */
  function buildShell(
    st: WinState,
    body: HTMLElement,
    header: HTMLElement,
    viewId: string,
  ): void {
    const doc = st.win.document;
    try {
      header.textContent = "";
      body.textContent = "";
    } catch {
      /* ignore */
    }

    // Theme the host root (both header + body inherit through a shared class on
    // the body's ancestor; we toggle on both for safety).
    const root = (header.parentElement as HTMLElement) || header;
    st.root = root;
    applyThemeClass(root, resolveTheme(st.win));

    // ---- header: nav tab-strip (left) ----
    const navStrip = el(doc, "div", "bm-nav-strip");
    navStrip.setAttribute("role", "tablist");
    navStrip.setAttribute("aria-label", "Insights views");
    st.navStrip = navStrip;
    st.navButtons.clear();
    for (const entry of VizRegistry.list()) {
      const btn = el(doc, "button", "bm-nav-tab") as HTMLButtonElement;
      btn.setAttribute("data-view-id", entry.id);
      btn.setAttribute("role", "tab");
      btn.setAttribute("title", viewTooltip(entry.id) || entry.label);
      btn.textContent = entry.label;
      btn.addEventListener("click", () => void activate(st, entry.id));
      navStrip.appendChild(btn);
      st.navButtons.set(entry.id, btn);
    }
    header.appendChild(navStrip);

    // ---- header: per-view controls slot ----
    const controlsSlot = el(doc, "div", "bm-hub-controls");
    st.controlsSlot = controlsSlot;
    header.appendChild(controlsSlot);

    const spacer = el(doc, "div", "bm-hub-topbar-spacer");
    header.appendChild(spacer);

    // Source, export and maximize stay together, so when the header wraps
    // on a narrow panel they move to the next row as one group.
    const actions = el(doc, "div", "bm-hub-actions");
    header.appendChild(actions);

    // ---- header: source toggle (segmented) ----
    const sourceWrap = el(doc, "div", "bm-source-toggle");
    const srcLib = el(
      doc,
      "button",
      "bm-seg-btn",
      "Whole library",
    ) as HTMLButtonElement;
    srcLib.addEventListener("click", () => onSourceChange(st, "library"));
    const srcSet = el(doc, "button", "bm-seg-btn") as HTMLButtonElement;
    srcSet.addEventListener("click", () => onSourceChange(st, "set"));
    sourceWrap.appendChild(srcLib);
    sourceWrap.appendChild(srcSet);
    actions.appendChild(sourceWrap);
    st.sourceLibraryBtn = srcLib;
    st.sourceSetBtn = srcSet;
    updateSourceUI(st);

    // ---- header: export buttons ----
    const exportPng = el(
      doc,
      "button",
      "bm-hub-btn bm-hub-export",
      "Export PNG",
    ) as HTMLButtonElement;
    exportPng.addEventListener("click", () => void doExport(st, "png"));
    actions.appendChild(exportPng);

    const exportSvg = el(
      doc,
      "button",
      "bm-hub-btn bm-hub-export",
      "Export SVG",
    ) as HTMLButtonElement;
    exportSvg.addEventListener("click", () => void doExport(st, "svg"));
    actions.appendChild(exportSvg);
    st.exportButtons = [exportPng, exportSvg];

    // ---- header: host toggle (Maximize in dock / Restore in tab) ----
    const isTab = st.host?.kind() === "tab";
    const hostToggle = el(
      doc,
      "button",
      "bm-hub-btn bm-host-toggle",
      isTab ? "Restore" : "Maximize",
    ) as HTMLButtonElement;
    hostToggle.setAttribute(
      "title",
      isTab ? "Restore to bottom dock" : "Pop out to a full tab",
    );
    hostToggle.addEventListener("click", () => {
      if (st.host?.kind() === "tab") restore(st.win);
      else maximize(st.win);
    });
    actions.appendChild(hostToggle);
    st.hostToggleBtn = hostToggle;

    // ---- body: viewport + status ----
    const viewport = el(doc, "div", "bm-hub-viewport");
    st.viewport = viewport;
    body.appendChild(viewport);

    const status = el(doc, "div", "bm-hub-status");
    st.statusEl = status;
    body.appendChild(status);

    attachObservers(st);
    void activate(st, viewId);
  }

  // ---- source toggle --------------------------------------------------

  function onSourceChange(st: WinState, next: "library" | "set"): void {
    changingSource = true;
    try {
      setSource(next);
    } finally {
      changingSource = false;
    }
    updateSourceUI(st);
    if (next === "set" && curatedCount(st) === 0) {
      // An empty set draws nothing; open the set view, which explains how to
      // add items.
      void activate(st, "set");
      return;
    }
    // Back to "Whole library": if sitting on the Set management view, return to a
    // visualization; otherwise re-render the current view against the library.
    const target =
      st.activeId === "set" ? defaultView() : st.activeId || defaultView();
    void activate(st, target);
  }

  function curatedCount(st: WinState): number {
    try {
      const libraryID =
        paneLibraryID((st.win as any).ZoteroPane) ??
        Zotero.Libraries.userLibraryID ??
        0;
      return insightsSet.count(libraryID);
    } catch {
      return 0;
    }
  }

  function updateSourceUI(st: WinState): void {
    const cur = source();
    if (st.sourceLibraryBtn) {
      st.sourceLibraryBtn.classList.toggle("bm-active", cur === "library");
    }
    if (st.sourceLibraryBtn) {
      let name = "this library";
      try {
        name = Zotero.Libraries.getName(currentLibraryID(st)) || name;
      } catch {
        /* keep default */
      }
      st.sourceLibraryBtn.title = `All items in ${name}`;
    }
    if (st.sourceSetBtn) {
      st.sourceSetBtn.title = "Only the items you added to the curated set";
      st.sourceSetBtn.textContent = `Curated set (${curatedCount(st)})`;
      st.sourceSetBtn.classList.toggle("bm-active", cur === "set");
    }
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
    const token = ++st.activation;
    st.current = mod;
    st.activeId = id;
    st.libraryID = currentLibraryID(st);

    // Fresh containers per activation: a mount that resolves after the user
    // has moved on writes into detached nodes, never into the live panel.
    const doc = st.win.document;
    const viewHost = el(doc, "div", "bm-view-host");
    const controlsHost = el(doc, "div", "bm-view-controls");
    st.viewport.appendChild(viewHost);
    st.controlsSlot.appendChild(controlsHost);
    st.viewHost = viewHost;
    st.controlsHost = controlsHost;

    for (const [vid, btn] of st.navButtons) {
      const on = vid === id;
      btn.classList.toggle("bm-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }

    // Export only makes sense for drawn views; hide it for the "manage" Set view.
    setExportVisible(st, mod.kind !== "manage");

    const ctx: VizContext = buildContext({
      win: st.win,
      activeId: id,
      statusEl: st.statusEl,
      controlsSlot: controlsHost,
      data: dataFor(st),
      libraryID: () => currentLibraryID(st),
    });

    st.statusEl.textContent = "Reading your library…";
    try {
      await mod.mount(viewHost, ctx);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] view mount failed", id, e);
      if (token === st.activation && st.statusEl) {
        st.statusEl.textContent =
          "This view could not be drawn. Switch views or reopen the panel to try again.";
        st.statusEl.classList.add("bm-warn");
      }
    }
    if (token !== st.activation) {
      // Superseded while loading: destroy now that the mount has finished, so
      // nothing it created (canvas loop, listeners) outlives it.
      try {
        mod.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    if (st.statusEl?.textContent === "Reading your library…") {
      st.statusEl.textContent = "";
    }
    notifyResize(st);
  }

  function setExportVisible(st: WinState, visible: boolean): void {
    for (const b of st.exportButtons) {
      b.style.display = visible ? "" : "none";
    }
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
    st.viewHost?.remove();
    st.controlsHost?.remove();
    st.viewHost = null;
    st.controlsHost = null;
  }

  // ---- export ---------------------------------------------------------

  async function doExport(st: WinState, fmt: "png" | "svg"): Promise<void> {
    if (!st.current) return;
    const say = (text: string, warn = false) => {
      if (!st.statusEl) return;
      st.statusEl.textContent = text;
      st.statusEl.classList.toggle("bm-warn", warn);
    };
    try {
      const result =
        fmt === "png"
          ? await st.current.exportPNG()
          : await st.current.exportSVG();
      const path = await saveExport(st.win, result);
      if (path) say(`Saved ${fmt.toUpperCase()} to ${path}`);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] export failed", fmt, e);
      say(`Export failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  // ---- observers ------------------------------------------------------

  function attachObservers(st: WinState): void {
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

    st.themeWatcher = attachThemeWatcher(st.win, () => {
      if (st.root) applyThemeClass(st.root, resolveTheme(st.win));
      try {
        st.current?.onThemeChange?.();
      } catch (e) {
        ztoolkit.log("[Bibliometero Insights] onThemeChange failed", e);
      }
    });

    // Live set count + refresh when the curated set changes while source=set.
    try {
      st.setUnsub = insightsSet.subscribe(() => {
        if (st.destroyed) return;
        // Drop cached data before the view re-reads it.
        st.data?.invalidate();
        updateSourceUI(st);
        if (source() === "set") {
          try {
            st.current?.onDataChange?.();
          } catch (e) {
            ztoolkit.log("[Bibliometero Insights] set onDataChange failed", e);
          }
        }
      });
    } catch {
      st.setUnsub = null;
    }
    attachLibraryListener(st);
  }

  /** Re-render when the user selects a different library in the left pane. */
  function attachLibraryListener(st: WinState): void {
    try {
      const cv = (st.win as any).ZoteroPane?.collectionsView;
      const onSelect = cv?.onSelect;
      if (!onSelect?.addListener) return;
      const fn = () => {
        if (st.destroyed || !st.host || !st.activeId) return;
        const lib = currentLibraryID(st);
        updateSourceUI(st);
        if (lib !== st.libraryID) void activate(st, st.activeId);
      };
      onSelect.addListener(fn);
      st.selectUnsub = () => onSelect.removeListener?.(fn);
    } catch (e) {
      ztoolkit.log("[Bibliometero Insights] library listener failed", e);
    }
  }

  function detachObservers(st: WinState): void {
    if (st.selectUnsub) {
      try {
        st.selectUnsub();
      } catch {
        /* ignore */
      }
      st.selectUnsub = null;
    }
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
    if (st.setUnsub) {
      try {
        st.setUnsub();
      } catch {
        /* ignore */
      }
      st.setUnsub = null;
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

  const DATA_EVENTS = new Set(["add", "modify", "delete", "trash", "refresh"]);

  function onNotify(
    event: string,
    type: string,
    ids: Array<string | number>,
  ): void {
    if (!addon?.data?.alive) return;
    if (type === "tab") {
      // Switching back to the library tab can resize the dock; nothing else
      // about tabs (opening a PDF, closing one) changes the data.
      if (event !== "select") return;
      for (const st of states.values()) {
        if (st.host && !st.destroyed) {
          st.win.requestAnimationFrame(() => notifyResize(st));
        }
      }
      return;
    }
    if (!DATA_EVENTS.has(event)) return;
    for (const st of states.values()) st.data?.onNotify(event, type, ids);
    scheduleDataChange();
  }

  function scheduleDataChange(): void {
    if (dataTimer) clearTimeout(dataTimer);
    dataTimer = setTimeout(() => {
      dataTimer = null;
      for (const st of states.values()) {
        if (st.destroyed || !st.host) continue;
        try {
          updateSourceUI(st);
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
    const host = st.host;
    destroyActive(st);
    detachObservers(st);
    if (host) {
      try {
        host.close(st.win);
      } catch {
        /* ignore */
      }
    }
    st.host = null;
    clearShellRefs(st);
    st.activeId = null;
    st.data?.dispose?.();
    st.data = null;
  }

  // ---- test hooks -----------------------------------------------------

  function activeStateForTest(): WinState | null {
    for (const st of states.values()) {
      if (st.host && !st.destroyed) return st;
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
      const hooks = viewHooks(st);
      if (hooks.dispatchPointer) return hooks.dispatchPointer(...args);
      // Charts are plain SVG: hovering means pointer events on the first mark.
      if (args[0] !== "hover" || !st?.viewport) return;
      const mark = st.viewport.querySelector(".bm-bar, .bm-year-bar, .bm-arc");
      if (!mark) return;
      const r = (mark as Element).getBoundingClientRect();
      const init = {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      const PE = (st.win as any).PointerEvent || (st.win as any).MouseEvent;
      mark.dispatchEvent(new PE("pointerenter", init));
      mark.dispatchEvent(new PE("pointermove", init));
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
    /** Host introspection for the live harness. */
    getHostKind(): "dock" | "tab" | null {
      return activeStateForTest()?.host?.kind() ?? null;
    },
    maximize(): void {
      const st = activeStateForTest();
      if (st) maximize(st.win);
    },
    restore(): void {
      const st = activeStateForTest();
      if (st) restore(st.win);
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
    /** Toolbar action: toggle the bottom dock. (Name kept for hooks/tests.) */
    openTab: toggleDock,
    toggleDock,
    test,
  };
})();
