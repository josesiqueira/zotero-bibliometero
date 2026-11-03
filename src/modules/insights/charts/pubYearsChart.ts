/**
 * pubYearsChart.ts - "pubs-per-year" VizModule.
 *
 * Vertical bars of items per publication year, every year between the first and
 * the last present (empty years are zero-height, so gaps are visible). Items
 * with no usable date get a separate "No date" bar after a gap. The current
 * year is drawn lighter and labelled "(to date)" so a partial year is not read
 * as a decline. Clicking a bar selects exactly the items it counts.
 *
 * draw() is shared by the live panel and the exported figure.
 */

import type {
  VizModule,
  VizContext,
  ThemeInfo,
  ExportResult,
  PublicationsPerYearData,
} from "../types";
import { svgEl, svgText, createPlot, clearSvg } from "./chartkit/svg";
import { linearScale, niceMax, niceTicks } from "./chartkit/scale";
import { renderValueAxis, type PlotArea } from "./chartkit/axis";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { exportFigure, FONT_FAMILY, longDate } from "./chartkit/figure";

interface Bar {
  label: string;
  year: number | null;
  count: number;
  itemIds: number[];
  partial: boolean;
}

export class PubYearsChart implements VizModule {
  readonly id = "pubs-per-year";
  readonly label = "Publications per year";
  readonly kind = "chart" as const;
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="1" y="9" width="3" height="6" fill="context-stroke"/>' +
    '<rect x="6" y="5" width="3" height="10" fill="context-stroke"/>' +
    '<rect x="11" y="2" width="3" height="13" fill="context-stroke"/></svg>';

  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private tooltip: Tooltip | null = null;
  private data: PublicationsPerYearData | null = null;
  private width = 600;
  private height = 360;

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    container.style.position = "relative";
    const rect = container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width || 600));
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
      this.data = await this.ctx.data.perYear();
    } catch (e) {
      this.ctx.log("[pubs-per-year] perYear failed", e);
      this.data = null;
    }
  }

  private hostXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.container?.getBoundingClientRect();
    return r
      ? { x: clientX - r.left, y: clientY - r.top }
      : { x: clientX, y: clientY };
  }

  private bars(): Bar[] {
    const d = this.data;
    if (!d) return [];
    const thisYear = new Date().getFullYear();
    const out: Bar[] = [];
    for (const b of d.buckets) {
      if (b.year === null) continue;
      const partial = b.year === thisYear;
      out.push({
        label: partial ? `${b.year} (to date)` : String(b.year),
        year: b.year,
        count: b.count,
        itemIds: b.itemIds,
        partial,
      });
    }
    const none = d.buckets.find((b) => b.year === null);
    if (none && none.count > 0) {
      out.push({
        label: "No date",
        year: null,
        count: none.count,
        itemIds: none.itemIds,
        partial: false,
      });
    }
    return out;
  }

  private render(): void {
    if (!this.svg || !this.ctx) return;
    clearSvg(this.svg);
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    const theme = this.ctx.theme();
    this.draw(this.svg, this.width, this.height, theme, true);
    this.updateStatus();
  }

  /** Draw the chart into `root` (live or export). */
  private draw(
    root: SVGElement,
    width: number,
    height: number,
    theme: ThemeInfo,
    interactive: boolean,
  ): void {
    const doc = root.ownerDocument as Document;
    const bars = this.bars();
    const dated = bars.filter((b) => b.year !== null);
    if (!bars.length) {
      root.appendChild(
        svgText(
          doc,
          "No items in this view. Add items, or switch to Whole library.",
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

    const maxCount = bars.reduce((m, b) => Math.max(m, b.count), 0);
    const top = niceMax(maxCount);
    const area: PlotArea = {
      left: 44,
      top: 16,
      width: Math.max(1, width - 44 - 16),
      height: Math.max(1, height - 16 - 34),
    };
    const yScale = linearScale([0, top], [area.top + area.height, area.top]);
    root.appendChild(
      renderValueAxis(doc, area, yScale, niceTicks(maxCount, 5), theme),
    );

    // Slots: one per dated year, a one-slot gap, then "No date".
    const hasNone = bars.length > dated.length;
    const slots = dated.length + (hasNone ? 2 : 0);
    const step = area.width / Math.max(1, slots);
    const barW = Math.max(1, step * 0.72);
    const slotX = (i: number) => area.left + i * step + (step - barW) / 2;
    const yZero = yScale(0);

    // Year labels: as many as fit (about 34 px each), always the first, the
    // last, and round decades in between.
    const fitEvery = Math.max(1, Math.ceil(34 / step));
    const every =
      [1, 2, 5, 10, 20, 25, 50, 100].find((n) => n >= fitEvery) ?? 100;
    const baseline = area.top + area.height;
    root.appendChild(
      svgEl(doc, "line", {
        x1: area.left,
        y1: baseline,
        x2: area.left + area.width,
        y2: baseline,
        stroke: theme.muted,
        "stroke-width": 1,
      }),
    );

    const g = svgEl(doc, "g", { class: "bm-bars" }) as SVGGElement;
    root.appendChild(g);
    bars.forEach((b, idx) => {
      const isNone = b.year === null;
      const slot = isNone ? dated.length + 1 : idx;
      const x = slotX(slot);
      const y = yScale(b.count);
      const h = Math.max(0, yZero - y);
      const rect = svgEl(doc, "rect", {
        x,
        y,
        width: barW,
        height: h,
        rx: Math.min(2, barW / 3),
        fill: isNone ? theme.muted : theme.accent,
        "fill-opacity": b.partial ? 0.45 : 1,
        class: "bm-year-bar",
      });
      const title = svgEl(doc, "title");
      title.textContent = `${b.label}: ${b.count} item${b.count === 1 ? "" : "s"}`;
      rect.appendChild(title);
      g.appendChild(rect);

      const yr = b.year ?? 0;
      const isLast = idx === dated.length - 1;
      const showLabel =
        isNone ||
        yr % every === 0 ||
        (isLast && yr % every >= every / 2) ||
        (idx === 0 && every - (yr % every) >= every / 2);
      if (showLabel) {
        root.appendChild(
          svgText(doc, b.partial ? `${b.year}*` : b.label, {
            x: x + barW / 2,
            y: baseline + 16,
            "text-anchor": "middle",
            "font-size": 11,
            fill: theme.muted,
          }),
        );
      }

      if (!interactive) return;
      const onShow = (ev: Event) => {
        for (const sib of g.querySelectorAll(".bm-year-bar")) {
          (sib as SVGElement).setAttribute(
            "opacity",
            sib === rect ? "1" : "0.35",
          );
        }
        const pe = ev as PointerEvent;
        const xy = this.hostXY(pe.clientX, pe.clientY);
        this.tooltip?.show(
          [
            { text: b.label, variant: "strong" },
            { text: `${b.count} item${b.count === 1 ? "" : "s"}` },
            ...(b.count ? [{ text: "Click to select them" }] : []),
          ],
          xy.x,
          xy.y,
        );
      };
      if (b.count > 0) {
        (rect as unknown as SVGElement).style.cursor = "pointer";
        rect.addEventListener("click", () => {
          this.ctx?.showItems?.(
            b.itemIds,
            isNone ? "items with no date" : `published in ${b.year}`,
          );
        });
      }
      rect.addEventListener("pointerenter", onShow);
      rect.addEventListener("pointermove", onShow);
      rect.addEventListener("pointerleave", () => {
        for (const sib of g.querySelectorAll(".bm-year-bar")) {
          (sib as SVGElement).setAttribute("opacity", "1");
        }
        this.tooltip?.hide();
      });
    });

    if (dated.some((b) => b.partial)) {
      root.appendChild(
        svgText(doc, "* current year, still in progress", {
          x: area.left + area.width,
          y: area.top - 4,
          "text-anchor": "end",
          "font-size": 11,
          fill: theme.muted,
        }),
      );
    }
  }

  private summary(): string {
    const d = this.data;
    if (!d) return "";
    const range =
      d.minYear !== null && d.maxYear !== null
        ? `, ${d.minYear} to ${d.maxYear}`
        : "";
    const missing = d.missing > 0 ? `, ${d.missing} with no date` : "";
    return `${d.total} items${range}${missing}`;
  }

  private updateStatus(): void {
    if (!this.ctx || !this.data) return;
    this.ctx.setStatus(`${this.summary()}. Click a bar to select its items.`);
    this.svg?.setAttribute(
      "aria-label",
      `Publications per year: ${this.summary()}`,
    );
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
        title: "Publications per year",
        caption: `${scope}: ${this.summary()}. ${longDate()}. Zotero Bibliometero.`,
        name: "bibliometero-publications-per-year",
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
      barCount: () => this.svg?.querySelectorAll(".bm-year-bar").length ?? 0,
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}
