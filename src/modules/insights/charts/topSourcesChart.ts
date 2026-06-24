/**
 * topSourcesChart.ts - "top-sources" VizModule.
 *
 * Horizontal ranked bars of the most frequent journals/conferences via the
 * shared renderRankedBars builder. Labels are truncated, with the full name in
 * the tooltip and a <title>. A footer "+N more" line appears when there are more
 * distinct sources than rows shown. A Top-N number input is injected into
 * ctx.controlsSlot and re-fetches on change.
 */

import type {
  VizModule,
  VizContext,
  ThemeInfo,
  ExportResult,
  TopSourcesData,
} from "../types";
import { svgText, createPlot, clearSvg } from "./chartkit/svg";
import { renderRankedBars, type RankedEntry } from "./chartkit/rankedBars";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { serializeSVG, svgToPng } from "./chartkit/exporter";

export function createTopSourcesChart(): VizModule {
  return new TopSourcesChart();
}

const FOOTER_H = 22;

export class TopSourcesChart implements VizModule {
  readonly id = "top-sources";
  readonly label = "Top sources";
  readonly kind = "chart" as const;
  readonly icon =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="1" y="2" width="13" height="2.5" fill="context-stroke"/>' +
    '<rect x="1" y="6.75" width="9" height="2.5" fill="context-stroke"/>' +
    '<rect x="1" y="11.5" width="5" height="2.5" fill="context-stroke"/></svg>';

  private ctx: VizContext | null = null;
  private container: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private tooltip: Tooltip | null = null;
  private data: TopSourcesData | null = null;
  private control: HTMLElement | null = null;
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
    this.injectControl();
    await this.fetch();
    this.render();
  }

  private topN(): number {
    const v = Number(this.ctx?.prefs.get("topN", 15));
    return isFinite(v) && v > 0 ? Math.floor(v) : 15;
  }

  private injectControl(): void {
    if (!this.ctx) return;
    const doc = this.ctx.doc;
    const wrap = doc.createElement("label");
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "4px";
    wrap.style.fontSize = "12px";
    wrap.textContent = "Top ";
    const input = doc.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "100";
    input.value = String(this.topN());
    input.style.width = "56px";
    input.addEventListener("change", () => {
      let n = Math.floor(Number(input.value));
      if (!isFinite(n) || n < 1) n = 1;
      if (n > 100) n = 100;
      input.value = String(n);
      this.ctx?.prefs.set("topN", n);
      void this.refetchAndRender();
    });
    wrap.appendChild(input);
    this.ctx.controlsSlot.appendChild(wrap);
    this.control = wrap;
  }

  private async fetch(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.data = await this.ctx.data.topSources(this.topN());
    } catch (e) {
      this.ctx.log("[top-sources] fetch failed", e);
      this.data = null;
    }
  }

  private async refetchAndRender(): Promise<void> {
    await this.fetch();
    this.render();
  }

  private hostXY(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.container?.getBoundingClientRect();
    return r
      ? { x: clientX - r.left, y: clientY - r.top }
      : { x: clientX, y: clientY };
  }

  private render(): void {
    if (!this.svg || !this.ctx || !this.tooltip) return;
    const theme = this.ctx.theme();
    clearSvg(this.svg);
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);

    const d = this.data;
    if (!d || d.entries.length === 0) {
      this.renderEmpty(theme, "No sources found in this scope.");
      this.updateStatus();
      return;
    }

    const hasFooter = d.total > d.entries.length;
    const barsH = Math.max(1, this.height - (hasFooter ? FOOTER_H : 0));
    const entries: RankedEntry[] = d.entries.map((e) => ({
      label: e.name,
      value: e.count,
      key: e.name,
    }));
    renderRankedBars(this.ctx.doc, this.svg, {
      entries,
      width: this.width,
      height: barsH,
      theme,
      maxLabelChars: 28,
      tooltip: this.tooltip,
      toHostXY: (cx, cy) => this.hostXY(cx, cy),
      onBarClick: (e) => this.ctx?.searchLibrary?.(e.label),
    });

    if (hasFooter) {
      this.svg.appendChild(
        svgText(
          this.ctx.doc,
          `+${d.total - d.entries.length} more sources`,
          {
            x: this.width - 12,
            y: this.height - 7,
            "text-anchor": "end",
            "font-size": 10,
            "font-style": "italic",
            fill: theme.muted,
          },
        ),
      );
    }
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
    const missing = d.missing > 0 ? `, ${d.missing} without a source` : "";
    this.ctx.setStatus(
      `${d.total} distinct source${d.total === 1 ? "" : "s"}${missing}`,
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
    await this.refetchAndRender();
  }

  destroy(): void {
    this.tooltip?.destroy();
    this.tooltip = null;
    if (this.control) {
      try {
        this.control.remove();
      } catch {
        /* ignore */
      }
    }
    this.control = null;
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
    return { text, suggestedName: "bibliometero-top-sources", format: "svg" };
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
    return { blob, suggestedName: "bibliometero-top-sources", format: "png" };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      barCount: () => this.svg?.querySelectorAll(".bm-bar").length ?? 0,
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}
