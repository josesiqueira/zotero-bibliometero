/**
 * setView.ts - "set" VizModule (kind "manage").
 *
 * The EXCLUSIONS management view. The analysis scope is always "My Library minus
 * excluded items"; this view shows which papers are currently excluded so you
 * can restore them. A header shows "N analysed of T, M excluded" plus
 * "Exclude selection" and "Restore all" actions. The body lists the EXCLUDED
 * papers, each struck through and dimmed with a "Restore" button, double-click
 * reveals the item. When nothing is excluded it shows a friendly state telling
 * the user the whole library is being analysed and how to exclude items. The
 * list re-renders live on any exclusion change (via insightsSet.subscribe), so
 * context-menu exclude/include actions show immediately.
 *
 * This is not a chart: exportSVG/exportPNG return trivial results (the hub hides
 * export for kind "manage"), they only satisfy the VizModule interface.
 */

import type { VizModule, VizContext, ThemeInfo, ExportResult } from "../types";
import { insightsSet } from "../set/store";
import { paneLibraryID } from "../data/extract";

export function createSetView(): VizModule {
  return new SetView();
}

export class SetView implements VizModule {
  readonly id = "set";
  readonly label = "Manage";
  readonly kind = "manage" as const;
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 2h7a1 1 0 0 1 1 1v11l-4.5-2.5L3 15V3a1 1 0 0 1 1-1z" ' +
    'fill="none" stroke="context-stroke" stroke-width="1.4" ' +
    'stroke-linejoin="round"/></svg>';

  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Cached count of regular items in the library (null until first computed). */
  private totalRegular: number | null = null;

  mount(container: HTMLElement, ctx: VizContext): void {
    this.ctx = ctx;
    this.container = container;
    container.textContent = "";

    const root = ctx.doc.createElement("div");
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.minHeight = "0";
    root.style.boxSizing = "border-box";
    container.appendChild(root);
    this.root = root;

    this.unsubscribe = insightsSet.subscribe(() => this.render());
    void this.refreshTotal();
    this.render();
  }

  /** Recompute the library's regular-item total, then re-render the header. */
  private async refreshTotal(): Promise<void> {
    const libraryID = this.libraryID();
    let n = 0;
    try {
      const all = await (Zotero as any).Items?.getAll(libraryID, true);
      for (const it of (all as any[]) || []) {
        try {
          if (
            it &&
            typeof it.isRegularItem === "function" &&
            it.isRegularItem() &&
            !(typeof it.isFeedItem === "function" && it.isFeedItem())
          ) {
            n++;
          }
        } catch {
          /* skip malformed item */
        }
      }
      this.totalRegular = n;
    } catch {
      this.totalRegular = null;
    }
    this.render();
  }

  private libraryID(): number {
    const win = this.ctx?.win as any;
    let id: number | undefined;
    try {
      id = paneLibraryID(win?.ZoteroPane);
    } catch {
      id = undefined;
    }
    if (typeof id !== "number") {
      try {
        id = (Zotero as any).Libraries?.userLibraryID;
      } catch {
        id = undefined;
      }
    }
    return typeof id === "number" ? id : 1;
  }

  /** Resolve a Zotero item, returning null if it is missing. */
  private getItem(id: number): any | null {
    try {
      const item = (Zotero as any).Items?.get(id);
      return item || null;
    } catch {
      return null;
    }
  }

  private titleOf(item: any): string {
    try {
      const t = item.getField("title");
      if (t) return String(t);
    } catch {
      /* ignore */
    }
    try {
      const dt = item.getDisplayTitle?.();
      if (dt) return String(dt);
    } catch {
      /* ignore */
    }
    return "(untitled)";
  }

  private firstCreatorOf(item: any): string {
    try {
      const fc = item.firstCreator;
      if (fc) return String(fc);
    } catch {
      /* ignore */
    }
    try {
      const creators = item.getCreatorsJSON?.();
      if (creators && creators.length) {
        const c = creators[0];
        const name = c.lastName || c.name || c.firstName || "";
        if (name) return String(name);
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  private yearOf(item: any): string {
    try {
      const y = item.getField("year");
      if (y) return String(y);
    } catch {
      /* ignore */
    }
    try {
      const date = item.getField("date");
      if (date) {
        const m = String(date).match(/\d{4}/);
        if (m) return m[0];
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  private render(): void {
    if (!this.root || !this.ctx) return;
    const doc = this.ctx.doc;
    const theme = this.ctx.theme();
    const libraryID = this.libraryID();

    const root = this.root;
    root.textContent = "";
    root.style.background = theme.bg;
    root.style.color = theme.fg;

    let mode: "exclude" | "include" = "exclude";
    try {
      mode = insightsSet.getMode(libraryID);
    } catch {
      mode = "exclude";
    }
    const include = mode === "include";

    // The active list: included items in include mode, excluded in exclude mode.
    let ids: number[] = [];
    try {
      ids = insightsSet.list(libraryID) || [];
    } catch {
      ids = [];
    }

    // Resolve list items defensively, skipping any that no longer exist.
    const rows: { id: number; item: any }[] = [];
    for (const id of ids) {
      const item = this.getItem(id);
      if (item) rows.push({ id, item });
    }

    const listed = rows.length; // excluded count, or included count
    const total = this.totalRegular;
    const analyzed = include
      ? listed
      : total != null
        ? Math.max(0, total - listed)
        : null;

    // Mode switch + header + how-to line.
    root.appendChild(this.buildModeControl(doc, theme, libraryID, mode));
    root.appendChild(
      this.buildHeader(doc, theme, total, analyzed, listed, include),
    );
    root.appendChild(this.buildHint(doc, theme, libraryID, include));

    if (listed === 0) {
      root.appendChild(this.buildEmptyState(doc, theme, analyzed, include));
      this.ctx.setStatus(
        include
          ? "No items included yet"
          : analyzed != null
            ? `${analyzed} paper${analyzed === 1 ? "" : "s"} analysed, none excluded`
            : "Nothing excluded",
      );
      return;
    }

    const listWrap = doc.createElement("div");
    listWrap.className = "bm-set-list";
    listWrap.style.flex = "1";
    listWrap.style.minHeight = "0";
    listWrap.style.overflowY = "auto";
    listWrap.style.padding = "4px 0";

    for (const { id, item } of rows) {
      listWrap.appendChild(
        this.buildRow(doc, theme, libraryID, id, item, include),
      );
    }
    root.appendChild(listWrap);

    this.ctx.setStatus(
      include
        ? `${listed} included paper${listed === 1 ? "" : "s"} analysed`
        : analyzed != null
          ? `${analyzed} analysed, ${listed} excluded`
          : `${listed} excluded`,
    );
  }

  /** The 2-option scope-mode switch (exclude vs include). */
  private buildModeControl(
    doc: Document,
    theme: ThemeInfo,
    libraryID: number,
    mode: "exclude" | "include",
  ): HTMLElement {
    // role=group + aria-pressed buttons: announced semantics match the
    // click-only behaviour (we intentionally did not hand-roll roving-tabindex
    // radio keyboard navigation).
    const wrap = doc.createElement("div");
    wrap.className = "bm-scope-mode";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Analysis scope");
    wrap.style.display = "flex";
    wrap.style.gap = "0";
    wrap.style.padding = "8px 10px";
    wrap.style.borderBottom = `1px solid ${theme.border}`;
    wrap.style.flex = "0 0 auto";

    const mk = (
      value: "exclude" | "include",
      label: string,
      first: boolean,
    ): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      const active = mode === value;
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.textContent = label;
      b.style.flex = "1";
      b.style.fontSize = "12px";
      b.style.padding = "5px 8px";
      b.style.cursor = "pointer";
      b.style.border = `1px solid ${theme.border}`;
      if (!first) b.style.borderLeft = "none";
      b.style.borderRadius = first ? "4px 0 0 4px" : "0 4px 4px 0";
      b.style.background = active ? theme.accent : "transparent";
      b.style.color = active ? theme.bg : theme.fg;
      b.style.fontWeight = active ? "600" : "400";
      b.addEventListener("click", () => {
        if (mode === value) return;
        try {
          insightsSet.setMode(libraryID, value);
        } catch (e) {
          this.ctx?.log("[set] setMode failed", e);
        }
        // setMode notifies subscribers, which re-renders this view.
      });
      return b;
    };

    wrap.appendChild(mk("exclude", "Whole library, minus excluded", true));
    wrap.appendChild(mk("include", "Only included items", false));
    return wrap;
  }

  private buildHeader(
    doc: Document,
    theme: ThemeInfo,
    total: number | null,
    analyzed: number | null,
    listed: number,
    include: boolean,
  ): HTMLElement {
    const header = doc.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "8px";
    header.style.padding = "8px 10px";
    header.style.borderBottom = `1px solid ${theme.border}`;
    header.style.flex = "0 0 auto";

    const libraryID = this.libraryID();

    const labelWrap = doc.createElement("div");
    labelWrap.style.display = "flex";
    labelWrap.style.flexDirection = "column";

    const title = doc.createElement("span");
    title.textContent = include ? "Insights set" : "My Library";
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    title.style.color = theme.fg;
    labelWrap.appendChild(title);

    const sub = doc.createElement("span");
    if (include) {
      sub.textContent =
        listed > 0
          ? `${listed} included paper${listed === 1 ? "" : "s"} analysed`
          : "No items included yet";
    } else if (analyzed != null && total != null) {
      sub.textContent =
        listed > 0
          ? `${analyzed} of ${total} analysed, ${listed} excluded`
          : `${analyzed} paper${analyzed === 1 ? "" : "s"} analysed`;
    } else {
      // total not yet counted: avoid a perpetual "counting" if it failed.
      sub.textContent =
        listed > 0
          ? `${listed} excluded`
          : "Your whole library is being analysed";
    }
    sub.style.fontSize = "11px";
    sub.style.color = theme.muted;
    labelWrap.appendChild(sub);

    header.appendChild(labelWrap);

    const spacer = doc.createElement("span");
    spacer.style.flex = "1";
    header.appendChild(spacer);

    const selBtn = this.makeButton(
      doc,
      theme,
      include ? "Add selection" : "Exclude selection",
      false,
    );
    selBtn.addEventListener("click", () => this.addSelectionToActive(libraryID));
    header.appendChild(selBtn);

    const clearBtn = this.makeButton(
      doc,
      theme,
      include ? "Clear all" : "Restore all",
      false,
    );
    clearBtn.disabled = listed === 0;
    if (listed === 0) clearBtn.style.opacity = "0.5";
    clearBtn.addEventListener("click", () => {
      if (listed === 0) return;
      try {
        insightsSet.clear(libraryID);
      } catch (e) {
        this.ctx?.log("[set] clear failed", e);
      }
      this.render();
    });
    header.appendChild(clearBtn);

    return header;
  }

  /** The always-visible "how to curate" affordance line (mode-aware). */
  private buildHint(
    doc: Document,
    theme: ThemeInfo,
    libraryID: number,
    include: boolean,
  ): HTMLElement {
    void libraryID;
    const hint = doc.createElement("div");
    hint.textContent = include
      ? "Right-click items in your library and choose “Add to Insights” to " +
        "analyse only those."
      : "Right-click items in your library and choose “Exclude from Insights” " +
        "to drop them from your analysis.";
    hint.style.flex = "0 0 auto";
    hint.style.fontSize = "11px";
    hint.style.lineHeight = "1.5";
    hint.style.color = theme.muted;
    hint.style.padding = "8px 10px";
    hint.style.borderBottom = `1px solid ${theme.border}`;
    return hint;
  }

  /** Mode-aware empty state (no exclusions yet, or no inclusions yet). */
  private buildEmptyState(
    doc: Document,
    theme: ThemeInfo,
    analyzed: number | null,
    include: boolean,
  ): HTMLElement {
    const empty = doc.createElement("div");
    empty.style.flex = "1";
    empty.style.minHeight = "0";
    empty.style.display = "flex";
    empty.style.flexDirection = "column";
    empty.style.alignItems = "center";
    empty.style.justifyContent = "center";
    empty.style.textAlign = "center";
    empty.style.padding = "24px";
    empty.style.gap = "8px";

    const title = doc.createElement("div");
    title.textContent = include ? "Build your Insights set" : "Nothing excluded.";
    title.style.fontSize = "14px";
    title.style.fontWeight = "600";
    title.style.color = theme.fg;
    empty.appendChild(title);

    const body = doc.createElement("div");
    body.textContent = include
      ? "Insights will analyse only the items you add. Right-click any item and choose “Add to Insights”."
      : analyzed != null
        ? `Your whole library (${analyzed} paper${analyzed === 1 ? "" : "s"}) is being analysed.`
        : "Your whole library is being analysed.";
    body.style.fontSize = "12px";
    body.style.lineHeight = "1.5";
    body.style.maxWidth = "360px";
    body.style.color = theme.muted;
    empty.appendChild(body);

    return empty;
  }

  private buildRow(
    doc: Document,
    theme: ThemeInfo,
    libraryID: number,
    id: number,
    item: any,
    include: boolean,
  ): HTMLElement {
    const row = doc.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "6px 10px";
    row.style.borderBottom = `1px solid ${theme.border}`;
    row.style.cursor = "default";
    row.title = "Double-click to reveal in the library";

    row.addEventListener("mouseenter", () => {
      row.style.background = theme.grid;
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "";
    });
    row.addEventListener("dblclick", () => {
      try {
        this.ctx?.openItem(id);
      } catch (e) {
        this.ctx?.log("[set] openItem failed", e);
      }
    });

    const textWrap = doc.createElement("div");
    textWrap.style.flex = "1";
    textWrap.style.minWidth = "0";
    textWrap.style.overflow = "hidden";

    // In exclude mode the listed items are EXCLUDED: they read as "removed from
    // analysis" (struck through, dimmed). In include mode they are the active
    // set, shown plainly.
    if (!include) row.style.opacity = "0.6";

    const titleEl = doc.createElement("div");
    titleEl.textContent = this.titleOf(item);
    titleEl.style.fontSize = "13px";
    titleEl.style.color = theme.fg;
    if (!include) titleEl.style.textDecoration = "line-through";
    titleEl.style.whiteSpace = "nowrap";
    titleEl.style.overflow = "hidden";
    titleEl.style.textOverflow = "ellipsis";
    textWrap.appendChild(titleEl);

    const creator = this.firstCreatorOf(item);
    const year = this.yearOf(item);
    const metaParts: string[] = [];
    if (creator) metaParts.push(creator);
    if (year) metaParts.push(year);
    const metaEl = doc.createElement("div");
    metaEl.textContent = metaParts.join(", ");
    metaEl.style.fontSize = "11px";
    metaEl.style.color = theme.muted;
    metaEl.style.whiteSpace = "nowrap";
    metaEl.style.overflow = "hidden";
    metaEl.style.textOverflow = "ellipsis";
    textWrap.appendChild(metaEl);

    row.appendChild(textWrap);

    const restore = doc.createElement("button");
    restore.type = "button";
    restore.textContent = include ? "Remove" : "Restore";
    restore.title = include
      ? "Remove this paper from the Insights set"
      : "Include this paper in the analysis again";
    restore.setAttribute(
      "aria-label",
      include ? "Remove from the Insights set" : "Restore to the analysis",
    );
    restore.style.flex = "0 0 auto";
    restore.style.display = "inline-flex";
    restore.style.alignItems = "center";
    restore.style.justifyContent = "center";
    restore.style.height = "26px";
    restore.style.padding = "0 10px";
    restore.style.fontSize = "12px";
    restore.style.border = `1px solid ${theme.border}`;
    restore.style.borderRadius = "4px";
    restore.style.background = "transparent";
    restore.style.color = theme.fg;
    restore.style.cursor = "pointer";
    restore.addEventListener("mouseenter", () => {
      restore.style.background = theme.grid;
    });
    restore.addEventListener("mouseleave", () => {
      restore.style.background = "transparent";
    });
    restore.addEventListener("click", (ev) => {
      ev.stopPropagation();
      try {
        insightsSet.remove(libraryID, [id]);
      } catch (e) {
        this.ctx?.log("[set] remove failed", e);
      }
      this.render();
    });
    row.appendChild(restore);

    return row;
  }

  private makeButton(
    doc: Document,
    theme: ThemeInfo,
    text: string,
    primary: boolean,
  ): HTMLButtonElement {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.style.flex = "0 0 auto";
    btn.style.fontSize = "12px";
    btn.style.padding = "4px 10px";
    btn.style.borderRadius = "4px";
    btn.style.cursor = "pointer";
    btn.style.border = `1px solid ${theme.border}`;
    if (primary) {
      btn.style.background = theme.accent;
      btn.style.color = theme.bg;
      btn.style.borderColor = theme.accent;
    } else {
      btn.style.background = "transparent";
      btn.style.color = theme.fg;
    }
    return btn;
  }

  /** Add the current library selection to the ACTIVE list (exclude or include). */
  private addSelectionToActive(libraryID: number): void {
    const win = this.ctx?.win as any;
    let ids: number[] = [];
    try {
      const selected: any[] = win?.ZoteroPane?.getSelectedItems?.() || [];
      ids = selected
        .filter((it) => {
          try {
            return it && it.isRegularItem && it.isRegularItem();
          } catch {
            return false;
          }
        })
        .map((it) => {
          try {
            return Number(it.id);
          } catch {
            return NaN;
          }
        })
        .filter((n) => isFinite(n));
    } catch (e) {
      this.ctx?.log("[set] read selection failed", e);
      ids = [];
    }
    if (ids.length === 0) {
      this.ctx?.setStatus("No regular items selected.", { warn: true });
      return;
    }
    try {
      insightsSet.add(libraryID, ids);
    } catch (e) {
      this.ctx?.log("[set] add selection failed", e);
    }
    this.render();
  }

  onResize(): void {
    // Flow layout reflows on its own; nothing to recompute.
  }

  onThemeChange(): void {
    this.render();
  }

  onDataChange(): void {
    // Item add/delete can change the library total, so recompute it.
    void this.refreshTotal();
  }

  destroy(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribe = null;
    if (this.root) {
      try {
        this.root.remove();
      } catch {
        /* ignore */
      }
    }
    this.root = null;
    if (this.container) this.container.textContent = "";
    this.container = null;
    this.ctx = null;
  }

  async exportSVG(): Promise<ExportResult> {
    return {
      text: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      suggestedName: "bibliometero-set",
      format: "svg",
    };
  }

  async exportPNG(): Promise<ExportResult> {
    // Management view: no raster export. Return a 1x1 transparent PNG so the
    // interface is satisfied without crashing (the hub hides export for "manage").
    const blob = new Blob([new Uint8Array(0)], { type: "image/png" });
    return { blob, suggestedName: "bibliometero-set", format: "png" };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      rowCount: () =>
        this.root?.querySelector(".bm-set-list")?.childElementCount ?? 0,
      isEmpty: () => {
        const lib = this.libraryID();
        try {
          return (insightsSet.list(lib) || []).length === 0;
        } catch {
          return true;
        }
      },
    };
  }
}
