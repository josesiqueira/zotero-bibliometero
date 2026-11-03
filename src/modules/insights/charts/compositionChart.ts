/**
 * compositionChart.ts - "composition" VizModule: what kinds of items the
 * library holds and how they are filed.
 *
 * - Item types: a donut, because every item has exactly one type, so the
 *   slices are parts of one whole. Beyond six types the rest fold into
 *   "Other types". The legend is drawn in SVG so exports keep it.
 * - Collections: ranked bars, not a donut, because an item can sit in several
 *   collections; the bars count items per collection and the note says so.
 *   "Unfiled" (Zotero's word for items in no collection) comes last, muted.
 *
 * Clicking a slice or bar selects exactly those items; a collection bar opens
 * the collection. One draw() serves the panel and the exported figure.
 */

import type {
  VizModule,
  VizContext,
  ThemeInfo,
  ExportResult,
  CompositionData,
  CompositionSegment,
} from "../types";
import { svgEl, svgText, arcPath, createPlot, clearSvg } from "./chartkit/svg";
import { renderRankedBars, type RankedEntry } from "./chartkit/rankedBars";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { exportFigure, FONT_FAMILY, longDate } from "./chartkit/figure";

const MAX_TYPES = 6;
const STACK_BELOW_PX = 640;

export class CompositionChart implements VizModule {
  readonly id = "composition";
  readonly label = "Composition";
  readonly kind = "chart" as const;
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M8 1a7 7 0 1 0 7 7H8z" fill="context-stroke"/>' +
    '<circle cx="8" cy="8" r="3" fill="none"/></svg>';

  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private tooltip: Tooltip | null = null;
  private data: CompositionData | null = null;
  private failed = false;
  private width = 700;
  private height = 360;

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    container.style.position = "relative";
    const rect = container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width || 700));
    this.height = Math.max(1, Math.floor(rect.height || 360));
    this.svg = createPlot(ctx.doc, this.width, this.height);
    this.svg.setAttribute("font-family", FONT_FAMILY);
    this.svg.setAttribute("role", "img");
    container.appendChild(this.svg);
    this.tooltip = createTooltip(ctx.doc, container, ctx.theme());
    await this.load();
    this.render();
  }

  private async load(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.data = await this.ctx.data.composition();
      this.failed = false;
    } catch (e) {
      this.ctx.log("[composition] fetch failed", e);
      this.data = null;
      this.failed = true;
    }
  }

  private hostXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.container?.getBoundingClientRect();
    return r
      ? { x: clientX - r.left, y: clientY - r.top }
      : { x: clientX, y: clientY };
  }

  private render(): void {
    if (!this.svg || !this.ctx) return;
    clearSvg(this.svg);
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.draw(this.svg, this.width, this.height, this.ctx.theme(), true);
    this.updateStatus();
  }

  /** Item types folded to MAX_TYPES slices. */
  private typeSlices(d: CompositionData): CompositionSegment[] {
    if (d.byType.length <= MAX_TYPES) return d.byType;
    const head = d.byType.slice(0, MAX_TYPES - 1);
    const tail = d.byType.slice(MAX_TYPES - 1);
    return [
      ...head,
      {
        key: "__other_types",
        label: "Other types",
        count: tail.reduce((n, s) => n + s.count, 0),
        itemIds: tail.flatMap((s) => s.itemIds),
      },
    ];
  }

  private draw(
    root: SVGElement,
    width: number,
    height: number,
    theme: ThemeInfo,
    interactive: boolean,
  ): void {
    const doc = root.ownerDocument as Document;
    const d = this.data;
    if (!d || d.total === 0) {
      root.appendChild(
        svgText(
          doc,
          this.failed
            ? "Could not read the items. Switch views to try again."
            : "No items in this view.",
          {
            x: width / 2,
            y: height / 2,
            "text-anchor": "middle",
            "font-size": 13,
            fill: theme.muted,
          },
        ),
      );
      return;
    }

    // Inner margin so headings and bars do not touch the panel edge.
    const pad = 12;
    const inner = svgEl(doc, "g", {
      transform: `translate(${pad}, ${pad / 2})`,
    });
    root.appendChild(inner);
    root = inner;
    width -= pad * 2;
    height -= pad;
    const stacked = width < STACK_BELOW_PX;
    const gap = 28;
    const boxW = stacked ? width : Math.floor((width - gap) / 2);
    const boxH = stacked ? Math.floor((height - gap) / 2) : height;

    const left = svgEl(doc, "g", {});
    const right = svgEl(doc, "g", {
      transform: stacked
        ? `translate(0, ${boxH + gap})`
        : `translate(${boxW + gap}, 0)`,
    });
    root.appendChild(left);
    root.appendChild(right);
    this.drawTypes(left, boxW, boxH, theme, interactive, d);
    this.drawCollections(right, boxW, boxH, theme, interactive, d);
  }

  private heading(
    root: SVGElement,
    text: string,
    note: string,
    theme: ThemeInfo,
  ): void {
    const doc = root.ownerDocument as Document;
    const h = svgText(doc, text, {
      x: 0,
      y: 14,
      "font-size": 13,
      "font-weight": 600,
      fill: theme.fg,
    });
    root.appendChild(h);
    if (note) {
      root.appendChild(
        svgText(doc, note, { x: 0, y: 31, "font-size": 11, fill: theme.muted }),
      );
    }
  }

  private drawTypes(
    root: SVGElement,
    w: number,
    h: number,
    theme: ThemeInfo,
    interactive: boolean,
    d: CompositionData,
  ): void {
    const doc = root.ownerDocument as Document;
    this.heading(root, "Item types", "", theme);
    const slices = this.typeSlices(d);
    const top = 26;
    const size = Math.max(60, Math.min(h - top - 4, w * 0.45, 300));
    const cx = size / 2;
    const cy = top + size / 2;
    const outer = size / 2 - 2;
    const inner = outer * 0.6;
    const colors = slices.map((s, i) =>
      s.key === "__other_types"
        ? theme.muted
        : theme.series[i % theme.series.length]!,
    );

    const arcs: SVGElement[] = [];
    const rows: SVGElement[] = [];
    const highlight = (i: number | null) => {
      arcs.forEach((a, j) =>
        a.setAttribute("opacity", i === null || i === j ? "1" : "0.35"),
      );
      rows.forEach((r, j) =>
        r.setAttribute("opacity", i === null || i === j ? "1" : "0.45"),
      );
    };

    let angle = -Math.PI / 2;
    slices.forEach((s, i) => {
      const frac = s.count / d.total;
      const end = angle + frac * Math.PI * 2;
      const path = svgEl(doc, "path", {
        d: arcPath(cx, cy, inner, outer, angle, end),
        fill: colors[i],
        stroke: theme.bg,
        "stroke-width": 1.5,
        class: "bm-arc",
      });
      angle = end;
      const t = svgEl(doc, "title");
      t.textContent = `${s.label}: ${s.count} (${pct(s.count, d.total)})`;
      path.appendChild(t);
      root.appendChild(path);
      arcs.push(path);
    });

    root.appendChild(
      svgText(doc, String(d.total), {
        x: cx,
        y: cy + 2,
        "text-anchor": "middle",
        "font-size": Math.max(14, Math.round(inner * 0.42)),
        "font-weight": 600,
        fill: theme.fg,
      }),
    );
    root.appendChild(
      svgText(doc, "items", {
        x: cx,
        y: cy + 2 + Math.max(12, Math.round(inner * 0.3)),
        "text-anchor": "middle",
        "font-size": 11,
        fill: theme.muted,
      }),
    );

    // Legend beside the donut: swatch, name, count and share.
    const lx = size + 18;
    const rowH = 20;
    const ly0 = cy - (slices.length * rowH) / 2 + rowH / 2;
    slices.forEach((s, i) => {
      const y = ly0 + i * rowH;
      const row = svgEl(doc, "g", { class: "bm-legend-row" });
      row.appendChild(
        svgEl(doc, "rect", {
          x: lx,
          y: y - 6,
          width: 11,
          height: 11,
          rx: 2,
          fill: colors[i],
        }),
      );
      row.appendChild(
        svgText(doc, s.label, {
          x: lx + 18,
          y: y + 4,
          "font-size": 12,
          fill: theme.fg,
        }),
      );
      row.appendChild(
        svgText(doc, `${s.count}  ${pct(s.count, d.total)}`, {
          x: Math.min(w, lx + 18 + 210),
          y: y + 4,
          "text-anchor": "end",
          "font-size": 12,
          fill: theme.muted,
        }),
      );
      root.appendChild(row);
      rows.push(row);
    });

    if (!interactive) return;
    slices.forEach((s, i) => {
      for (const el of [arcs[i]!, rows[i]!]) {
        (el as SVGElement).style.cursor = "pointer";
        el.addEventListener("pointerenter", (ev) => {
          highlight(i);
          const pe = ev as PointerEvent;
          const xy = this.hostXY(pe.clientX, pe.clientY);
          this.tooltip?.show(
            [
              { text: s.label, variant: "strong" },
              { text: `${s.count} items, ${pct(s.count, d.total)} of all` },
              { text: "Click to select them" },
            ],
            xy.x,
            xy.y,
          );
        });
        el.addEventListener("pointerleave", () => {
          highlight(null);
          this.tooltip?.hide();
        });
        el.addEventListener("click", () => {
          this.ctx?.showItems?.(s.itemIds, `${s.label.toLowerCase()} items`);
        });
      }
    });
  }

  private drawCollections(
    root: SVGElement,
    w: number,
    h: number,
    theme: ThemeInfo,
    interactive: boolean,
    d: CompositionData,
  ): void {
    const doc = root.ownerDocument as Document;
    this.heading(
      root,
      "Top-level collections (with their subcollections)",
      "An item can be in several collections, so bars can add up to more than the total.",
      theme,
    );
    const entries: RankedEntry[] = d.byCollection.map((s) => ({
      label: s.label,
      value: s.count,
      key: s.key,
      itemIds: s.itemIds,
      muted: s.key === "__other",
    }));
    if (d.uncategorized > 0) {
      entries.push({
        label: "Unfiled",
        value: d.uncategorized,
        key: "__unfiled",
        itemIds: d.uncategorizedIds,
        muted: true,
      });
    }
    if (!entries.length) {
      root.appendChild(
        svgText(doc, "No collections.", {
          x: 0,
          y: 60,
          "font-size": 12,
          fill: theme.muted,
        }),
      );
      return;
    }
    const g = svgEl(doc, "g", { transform: "translate(0, 38)" });
    root.appendChild(g);
    renderRankedBars(doc, g, {
      entries,
      width: w,
      height: Math.max(40, h - 38),
      theme,
      tooltip: interactive ? this.tooltip || undefined : undefined,
      toHostXY: (cx, cy) => this.hostXY(cx, cy),
      detail: (e) => `${pct(e.value, d.total)} of all items`,
      clickHint: "Click to select these items",
      onBarClick: interactive
        ? (e) => {
            if (e.key.startsWith("c:")) {
              const id = parseInt(e.key.slice(2), 10);
              if (Number.isFinite(id)) this.ctx?.openCollection?.(id);
            } else {
              this.ctx?.showItems?.(
                e.itemIds || [],
                e.key === "__unfiled"
                  ? "unfiled items"
                  : "in other collections",
              );
            }
          }
        : undefined,
    });
  }

  private summary(): string {
    const d = this.data;
    if (!d) return "";
    const types = `${d.byType.length} item type${d.byType.length === 1 ? "" : "s"}`;
    const unfiled = d.uncategorized > 0 ? `, ${d.uncategorized} unfiled` : "";
    return `${d.total} items, ${types}${unfiled}`;
  }

  private updateStatus(): void {
    if (!this.ctx || !this.data) return;
    this.ctx.setStatus(
      `${this.summary()}. Click a slice or bar to select its items.`,
    );
    this.svg?.setAttribute("aria-label", `Composition: ${this.summary()}`);
  }

  onResize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.render();
  }

  onThemeChange(): void {
    if (this.tooltip && this.ctx) this.tooltip.applyTheme(this.ctx.theme());
    this.render();
  }

  async onDataChange(): Promise<void> {
    await this.load();
    this.render();
  }

  destroy(): void {
    this.tooltip?.destroy();
    this.tooltip = null;
    this.svg?.remove();
    this.svg = null;
    this.container = null;
    this.ctx = null;
    this.data = null;
  }

  private exportAs(fmt: "svg" | "png"): Promise<ExportResult> {
    if (!this.ctx) throw new Error("chart not mounted");
    const scope = this.ctx.scopeLabel?.() || "My Library";
    return exportFigure(
      this.ctx.doc,
      fmt,
      {
        title: "Item types and collections",
        caption: `${scope}: ${this.summary()}. ${longDate()}. Zotero Bibliometero.`,
        name: "bibliometero-composition",
      },
      (root, w, h, theme) => this.draw(root, w, h, theme, false),
    );
  }

  exportSVG(): Promise<ExportResult> {
    return this.exportAs("svg");
  }

  exportPNG(): Promise<ExportResult> {
    return this.exportAs("png");
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      arcCount: () => this.svg?.querySelectorAll(".bm-arc").length ?? 0,
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}

function pct(n: number, total: number): string {
  if (!total) return "0%";
  const p = (n / total) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}
