/**
 * pubYearsChart.ts - "pubs-per-year" VizModule.
 *
 * Vertical bar histogram over PublicationsPerYearData.buckets. Y is a linear
 * scale [0, niceMax(maxCount)] with nice ticks + gridlines; X is a band scale
 * over the year keys (the null/missing bucket renders last as an "Unknown" bar).
 * Hovering a bar shows {year, count} and dims its siblings. X labels rotate when
 * the axis is dense. Theme colours come from ctx.theme(); export is consistent
 * because every colour is set as a concrete attribute.
 */

import type {
  VizModule,
  VizContext,
  ThemeInfo,
  ExportResult,
  PublicationsPerYearData,
} from "../types";
import { svgEl, svgText, createPlot, clearSvg } from "./chartkit/svg";
import { linearScale, bandScale, niceMax, niceTicks } from "./chartkit/scale";
import { renderValueAxis, renderBandAxis, type PlotArea } from "./chartkit/axis";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { serializeSVG, svgToPng } from "./chartkit/exporter";

const UNKNOWN_KEY = "__unknown";

export function createPubYearsChart(): VizModule {
  return new PubYearsChart();
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
    container.textContent = "";
    container.style.position = "relative";
    const rect = container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width || 600));
    this.height = Math.max(1, Math.floor(rect.height || 360));

    this.svg = createPlot(ctx.doc, this.width, this.height);
    container.appendChild(this.svg);
    this.tooltip = createTooltip(ctx.doc, container, ctx.theme());

    try {
      this.data = await ctx.data.perYear();
    } catch (e) {
      ctx.log("[pubs-per-year] perYear failed", e);
      this.data = null;
    }
    this.render();
  }

  private hostXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.container?.getBoundingClientRect();
    return r
      ? { x: clientX - r.left, y: clientY - r.top }
      : { x: clientX, y: clientY };
  }

  private render(): void {
    if (!this.svg || !this.ctx) return;
    const theme = this.ctx.theme();
    clearSvg(this.svg);
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);

    const d = this.data;
    if (!d || d.buckets.length === 0) {
      this.renderEmpty(theme, "No dated items in this scope.");
      this.updateStatus();
      return;
    }

    // Order: ascending years, the null bucket rendered last as "Unknown".
    const dated = d.buckets.filter((b) => b.year !== null);
    const nullBucket = d.buckets.find((b) => b.year === null);
    const keyed: { key: string; label: string; count: number }[] = dated.map(
      (b) => ({ key: String(b.year), label: String(b.year), count: b.count }),
    );
    if (nullBucket && nullBucket.count > 0) {
      keyed.push({
        key: UNKNOWN_KEY,
        label: "Unknown",
        count: nullBucket.count,
      });
    }
    if (keyed.length === 0) {
      this.renderEmpty(theme, "No dated items in this scope.");
      this.updateStatus();
      return;
    }

    const maxCount = keyed.reduce((m, b) => Math.max(m, b.count), 0);
    const top = niceMax(maxCount);

    const area: PlotArea = {
      left: 40,
      top: 14,
      width: Math.max(1, this.width - 40 - 12),
      height: Math.max(1, this.height - 14 - 40),
    };
    const yScale = linearScale([0, top], [area.top + area.height, area.top]);
    const xScale = bandScale(
      keyed.map((b) => b.key),
      [area.left, area.left + area.width],
      0.25,
    );

    // Axes + gridlines first (under the bars).
    this.svg.appendChild(
      renderValueAxis(this.ctx.doc, area, yScale, niceTicks(maxCount, 5), theme),
    );
    // Rotate x labels when bars are narrow; thin them if extremely dense.
    const dense = xScale.bandwidth < 26;
    const everyNth = xScale.step < 14 ? Math.ceil(14 / xScale.step) : 1;
    const labelMap = new Map(keyed.map((b) => [b.key, b.label]));
    this.svg.appendChild(
      renderBandAxis(
        this.ctx.doc,
        area,
        xScale,
        (k) => labelMap.get(k) ?? k,
        theme,
        { rotate: dense, everyNth },
      ),
    );

    // Bars.
    const barsG = svgEl(this.ctx.doc, "g", { class: "bm-bars" }) as SVGGElement;
    const yZero = yScale(0);
    keyed.forEach((b) => {
      const band = xScale(b.key);
      if (!band) return;
      const y = yScale(b.count);
      const h = Math.max(0, yZero - y);
      const isUnknown = b.key === UNKNOWN_KEY;
      const rect = svgEl(this.ctx!.doc, "rect", {
        x: band.start,
        y,
        width: band.width,
        height: h,
        rx: 2,
        fill: isUnknown ? theme.muted : theme.accent,
        class: "bm-year-bar",
      });
      const titleEl = svgEl(this.ctx!.doc, "title");
      titleEl.textContent = `${b.label}: ${b.count}`;
      rect.appendChild(titleEl);

      const onShow = (ev: Event) => {
        for (const sib of barsG.querySelectorAll(".bm-year-bar")) {
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
          ],
          xy.x,
          xy.y,
        );
      };
      rect.addEventListener("pointerenter", onShow);
      rect.addEventListener("pointermove", onShow);
      rect.addEventListener("pointerleave", () => {
        for (const sib of barsG.querySelectorAll(".bm-year-bar")) {
          (sib as SVGElement).setAttribute("opacity", "1");
        }
        this.tooltip?.hide();
      });
      barsG.appendChild(rect);
    });
    this.svg.appendChild(barsG);
    this.updateStatus();
  }

  private renderEmpty(theme: ThemeInfo, msg: string): void {
    if (!this.svg || !this.ctx) return;
    this.svg.appendChild(
      svgText(this.ctx.doc, msg, {
        x: this.width / 2,
        y: this.height / 2,
        "text-anchor": "middle",
        "font-size": 13,
        fill: theme.muted,
      }),
    );
  }

  private updateStatus(): void {
    if (!this.ctx || !this.data) return;
    const d = this.data;
    const range =
      d.minYear !== null && d.maxYear !== null
        ? `${d.minYear} to ${d.maxYear}`
        : "no dated items";
    const missing = d.missing > 0 ? `, ${d.missing} undated` : "";
    this.ctx.setStatus(`${d.total} items (${range})${missing}`);
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
    if (!this.ctx) return;
    try {
      this.data = await this.ctx.data.perYear();
    } catch (e) {
      this.ctx.log("[pubs-per-year] refetch failed", e);
    }
    this.render();
  }

  destroy(): void {
    this.tooltip?.destroy();
    this.tooltip = null;
    if (this.svg) {
      try {
        this.svg.remove();
      } catch {
        /* ignore */
      }
    }
    this.svg = null;
    if (this.container) this.container.textContent = "";
    this.container = null;
    this.ctx = null;
    this.data = null;
  }

  async exportSVG(): Promise<ExportResult> {
    if (!this.svg || !this.ctx) throw new Error("chart not mounted");
    const text = serializeSVG(this.svg, this.ctx.theme());
    return { text, suggestedName: "bibliometero-pubs-per-year", format: "svg" };
  }

  async exportPNG(): Promise<ExportResult> {
    if (!this.svg || !this.ctx) throw new Error("chart not mounted");
    const theme = this.ctx.theme();
    const text = serializeSVG(this.svg, theme);
    const blob = await svgToPng(
      this.ctx.doc,
      text,
      this.width,
      this.height,
      2,
      theme.bg,
    );
    return {
      blob,
      suggestedName: "bibliometero-pubs-per-year",
      format: "png",
    };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      barCount: () => this.svg?.querySelectorAll(".bm-year-bar").length ?? 0,
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}
