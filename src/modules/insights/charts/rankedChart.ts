/**
 * rankedChart.ts - shared base for the ranked bar views (Top sources, Top
 * authors). Owns the Top-N box, data loading, the status line, live drawing
 * and figure export; subclasses only say what to load and how to name it.
 */

import type { VizModule, VizContext, ThemeInfo, ExportResult } from "../types";
import { svgText, createPlot, clearSvg } from "./chartkit/svg";
import { renderRankedBars, type RankedEntry } from "./chartkit/rankedBars";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { exportFigure, FONT_FAMILY, longDate } from "./chartkit/figure";
import { getPrefRaw } from "../../../utils/prefs";

export interface RankedLoad {
  entries: RankedEntry[];
  /** Distinct entries before the Top-N cut (e.g. 201 sources). */
  total: number;
  /** One sentence for the status line and the export caption. */
  summary: string;
}

export abstract class RankedChart implements VizModule {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly kind = "chart" as const;
  abstract readonly icon: string;

  /** Noun for the entries, plural ("sources", "authors"). */
  protected abstract readonly noun: string;
  /** Load the top `n` entries. */
  protected abstract load(ctx: VizContext, n: number): Promise<RankedLoad>;
  /** What a click on `e` selects, e.g. "by Floridi, Luciano". */
  protected abstract describe(e: RankedEntry): string;

  protected ctx: VizContext | null = null;
  private container: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private tooltip: Tooltip | null = null;
  private data: RankedLoad | null = null;
  private failed = false;
  private width = 600;
  private height = 360;
  private shown = 0;

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
    this.injectControl();
    await this.reload();
  }

  private topN(): number {
    // The header box saves a per-chart value; until then the Settings value
    // (hub.topN) is the default.
    const fallback = Number(getPrefRaw("hub.topN")) || 15;
    const v = Number(this.ctx?.prefs.get("topN", fallback));
    return isFinite(v) && v > 0 ? Math.min(100, Math.floor(v)) : 15;
  }

  private injectControl(): void {
    if (!this.ctx) return;
    const doc = this.ctx.doc;
    const wrap = doc.createElement("label");
    wrap.className = "bm-control";
    wrap.textContent = "Show top ";
    const input = doc.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "100";
    input.value = String(this.topN());
    input.setAttribute("aria-label", `Number of ${this.noun} to show`);
    input.addEventListener("change", () => {
      let n = Math.floor(Number(input.value));
      if (!isFinite(n) || n < 1) n = 1;
      if (n > 100) n = 100;
      input.value = String(n);
      this.ctx?.prefs.set("topN", n);
      void this.reload();
    });
    wrap.appendChild(input);
    this.ctx.controlsSlot.appendChild(wrap);
  }

  private async reload(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.data = await this.load(this.ctx, this.topN());
      this.failed = false;
    } catch (e) {
      this.ctx?.log(`[${this.id}] load failed`, e);
      this.data = null;
      this.failed = true;
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
    clearSvg(this.svg);
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.shown = this.draw(
      this.svg,
      this.width,
      this.height,
      this.ctx.theme(),
      true,
    );
    this.updateStatus();
  }

  private draw(
    root: SVGElement,
    width: number,
    height: number,
    theme: ThemeInfo,
    interactive: boolean,
  ): number {
    const doc = root.ownerDocument as Document;
    const d = this.data;
    if (!d || !d.entries.length) {
      const msg = this.failed
        ? `Could not read the ${this.noun}. Switch views to try again.`
        : `No ${this.noun} in this view.`;
      root.appendChild(
        svgText(doc, msg, {
          x: width / 2,
          y: height / 2,
          "text-anchor": "middle",
          "font-size": 13,
          fill: theme.muted,
        }),
      );
      return 0;
    }
    return renderRankedBars(doc, root, {
      entries: d.entries,
      width,
      height,
      theme,
      tooltip: interactive ? this.tooltip || undefined : undefined,
      toHostXY: (cx, cy) => this.hostXY(cx, cy),
      onBarClick: interactive
        ? (e) => this.ctx?.showItems?.(e.itemIds || [], this.describe(e))
        : undefined,
      clickHint: "Click to select these items",
    });
  }

  private updateStatus(): void {
    if (!this.ctx || !this.data) return;
    const d = this.data;
    const cut =
      this.shown < d.entries.length
        ? ` Showing ${this.shown} of the top ${d.entries.length} that fit; make the panel taller to see more.`
        : "";
    this.ctx.setStatus(`${d.summary}.${cut} Click a bar to select its items.`);
    this.svg?.setAttribute("aria-label", `${this.label}: ${d.summary}`);
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
    await this.reload();
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
        title: this.label,
        caption: `${scope}: ${this.data?.summary ?? ""}. ${longDate()}. Zotero Bibliometero.`,
        name: `bibliometero-${this.id}`,
      },
      (root, w, h, theme) => {
        this.draw(root, w, h, theme, false);
      },
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
      barCount: () => this.svg?.querySelectorAll(".bm-bar").length ?? 0,
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}
