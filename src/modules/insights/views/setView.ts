/**
 * setView.ts - "set" VizModule (kind "manage").
 *
 * The curated-set management view: a scrollable list of the papers in the
 * Insights set for the current library. Each row shows the title and a muted
 * "FirstCreator, Year" line, double-clicks to reveal the item in the library,
 * and has a red trash button to remove it. A header shows the count plus
 * "Clear all" and "Add current selection" actions, and a friendly empty state
 * explains how to populate the set. The list re-renders live on any set change
 * (via insightsSet.subscribe), so context-menu adds/removes show immediately.
 *
 * This is not a chart: exportSVG/exportPNG return trivial results (the hub hides
 * export for kind "manage"), they only satisfy the VizModule interface.
 */

import type { VizModule, VizContext, ThemeInfo, ExportResult } from "../types";
import { insightsSet } from "../set/store";

export function createSetView(): VizModule {
  return new SetView();
}

export class SetView implements VizModule {
  readonly id = "set";
  readonly label = "Set";
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
    this.render();
  }

  private libraryID(): number {
    const win = this.ctx?.win as any;
    let id: number | undefined;
    try {
      id = win?.ZoteroPane?.getSelectedLibraryID?.();
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

    let ids: number[] = [];
    try {
      ids = insightsSet.list(libraryID) || [];
    } catch {
      ids = [];
    }

    // Resolve items defensively, skipping any that no longer exist.
    const rows: { id: number; item: any }[] = [];
    for (const id of ids) {
      const item = this.getItem(id);
      if (item) rows.push({ id, item });
    }

    root.appendChild(this.buildHeader(doc, theme, libraryID, rows.length));

    if (rows.length === 0) {
      root.appendChild(this.buildEmpty(doc, theme));
      this.ctx.setStatus("0 papers in the set");
      return;
    }

    const listWrap = doc.createElement("div");
    listWrap.style.flex = "1";
    listWrap.style.minHeight = "0";
    listWrap.style.overflowY = "auto";
    listWrap.style.padding = "4px 0";

    for (const { id, item } of rows) {
      listWrap.appendChild(this.buildRow(doc, theme, libraryID, id, item));
    }
    root.appendChild(listWrap);

    this.ctx.setStatus(
      `${rows.length} paper${rows.length === 1 ? "" : "s"} in the set`,
    );
  }

  private buildHeader(
    doc: Document,
    theme: ThemeInfo,
    libraryID: number,
    count: number,
  ): HTMLElement {
    const header = doc.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "8px";
    header.style.padding = "8px 10px";
    header.style.borderBottom = `1px solid ${theme.border}`;
    header.style.flex = "0 0 auto";

    const label = doc.createElement("span");
    label.textContent = `${count} paper${count === 1 ? "" : "s"} in the set`;
    label.style.fontSize = "13px";
    label.style.fontWeight = "600";
    label.style.color = theme.fg;
    header.appendChild(label);

    const spacer = doc.createElement("span");
    spacer.style.flex = "1";
    header.appendChild(spacer);

    const addBtn = this.makeButton(doc, theme, "Add current selection", false);
    addBtn.addEventListener("click", () => this.addSelection(libraryID));
    header.appendChild(addBtn);

    const clearBtn = this.makeButton(doc, theme, "Clear all", false);
    clearBtn.disabled = count === 0;
    if (count === 0) clearBtn.style.opacity = "0.5";
    clearBtn.addEventListener("click", () => {
      if (count === 0) return;
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

  private buildEmpty(doc: Document, theme: ThemeInfo): HTMLElement {
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
    title.textContent = "The Insights set is empty.";
    title.style.fontSize = "14px";
    title.style.fontWeight = "600";
    title.style.color = theme.fg;
    empty.appendChild(title);

    const hint = doc.createElement("div");
    hint.textContent =
      "Right-click papers in your library and choose Add to Insights, " +
      "or right-click a collection and choose Add collection to Insights.";
    hint.style.fontSize = "12px";
    hint.style.lineHeight = "1.5";
    hint.style.maxWidth = "360px";
    hint.style.color = theme.muted;
    empty.appendChild(hint);

    return empty;
  }

  private buildRow(
    doc: Document,
    theme: ThemeInfo,
    libraryID: number,
    id: number,
    item: any,
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

    const titleEl = doc.createElement("div");
    titleEl.textContent = this.titleOf(item);
    titleEl.style.fontSize = "13px";
    titleEl.style.color = theme.fg;
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

    const trash = doc.createElement("button");
    trash.type = "button";
    trash.title = "Remove from the set";
    trash.setAttribute("aria-label", "Remove from the set");
    trash.style.flex = "0 0 auto";
    trash.style.display = "inline-flex";
    trash.style.alignItems = "center";
    trash.style.justifyContent = "center";
    trash.style.width = "26px";
    trash.style.height = "26px";
    trash.style.padding = "0";
    trash.style.border = `1px solid ${theme.border}`;
    trash.style.borderRadius = "4px";
    trash.style.background = "transparent";
    trash.style.color = "#d23b3b";
    trash.style.cursor = "pointer";
    trash.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M3 4h10M6.5 4V2.6a.6.6 0 0 1 .6-.6h1.8a.6.6 0 0 1 .6.6V4' +
      'M5 4l.6 9a1 1 0 0 0 1 .9h2.8a1 1 0 0 0 1-.9L11 4" ' +
      'fill="none" stroke="currentColor" stroke-width="1.3" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
    trash.addEventListener("mouseenter", () => {
      trash.style.background = "rgba(210,59,59,0.12)";
    });
    trash.addEventListener("mouseleave", () => {
      trash.style.background = "transparent";
    });
    trash.addEventListener("click", (ev) => {
      ev.stopPropagation();
      try {
        insightsSet.remove(libraryID, [id]);
      } catch (e) {
        this.ctx?.log("[set] remove failed", e);
      }
      this.render();
    });
    row.appendChild(trash);

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

  private addSelection(libraryID: number): void {
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
      this.ctx?.setStatus("No regular items selected to add.", { warn: true });
      return;
    }
    try {
      insightsSet.add(libraryID, ids);
    } catch (e) {
      this.ctx?.log("[set] add failed", e);
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
    this.render();
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
        this.root?.querySelectorAll(":scope > div > div").length ?? 0,
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
