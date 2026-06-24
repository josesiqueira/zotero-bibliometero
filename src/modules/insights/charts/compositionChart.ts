/**
 * compositionChart.ts - "composition" VizModule.
 *
 * Two donut charts side by side: byType and byCollection. Each donut has an SVG
 * ring of arcs (arcPath, innerRadius ~0.6), a centre total, and an HTML legend
 * beside it (renderLegend) with bidirectional hover highlight: hovering an arc
 * highlights the legend row and vice-versa. Hovering an arc also shows a tooltip
 * {label, count, percent}. When the container is narrow the two donut blocks
 * stack vertically (handled in onResize -> render with a layout decision).
 *
 * Colours come from theme.series (colour-blind-safe); a single-category dataset
 * still renders a full ring without NaN geometry.
 */

import type {
  VizModule,
  VizContext,
  ThemeInfo,
  ExportResult,
  CompositionData,
  CompositionSegment,
} from "../types";
import { svgEl, svgText, arcPath } from "./chartkit/svg";
import { colorForKey } from "./chartkit/palette";
import { createTooltip, type Tooltip } from "./chartkit/tooltip";
import { renderLegend, type Legend, type LegendEntry } from "./chartkit/legend";
import { serializeSVG, svgToPng } from "./chartkit/exporter";

export function createCompositionChart(): VizModule {
  return new CompositionChart();
}

interface DonutBlock {
  wrap: HTMLElement;
  svg: SVGSVGElement;
  legend: Legend;
  segments: CompositionSegment[];
  arcByKey: Map<string, SVGElement>;
  title: string;
}

const NARROW_PX = 560;

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
  /** Outer flex row that holds the two donut blocks. */
  private root: HTMLElement | null = null;
  private tooltip: Tooltip | null = null;
  private data: CompositionData | null = null;
  private blocks: DonutBlock[] = [];
  /** Single export SVG that composes both donuts (built lazily on export). */
  private width = 700;
  private height = 360;

  async mount(container: HTMLElement, ctx: VizContext): Promise<void> {
    this.ctx = ctx;
    this.container = container;
    container.textContent = "";
    container.style.position = "relative";
    const rect = container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width || 700));
    this.height = Math.max(1, Math.floor(rect.height || 360));

    this.root = ctx.doc.createElement("div");
    this.root.style.display = "flex";
    this.root.style.width = "100%";
    this.root.style.height = "100%";
    this.root.style.boxSizing = "border-box";
    container.appendChild(this.root);

    this.tooltip = createTooltip(ctx.doc, container, ctx.theme());

    try {
      this.data = await ctx.data.composition();
    } catch (e) {
      ctx.log("[composition] fetch failed", e);
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

  private clearBlocks(): void {
    for (const b of this.blocks) {
      b.legend.destroy();
    }
    this.blocks = [];
    if (this.root) this.root.textContent = "";
  }

  private render(): void {
    if (!this.root || !this.ctx || !this.tooltip) return;
    const theme = this.ctx.theme();
    this.clearBlocks();

    const d = this.data;
    if (!d || d.total === 0) {
      this.renderEmpty(theme, "No items to summarize in this scope.");
      this.updateStatus();
      return;
    }

    const narrow = this.width < NARROW_PX;
    this.root.style.flexDirection = narrow ? "column" : "row";
    this.root.style.gap = narrow ? "10px" : "16px";

    const blockW = narrow ? this.width : Math.floor((this.width - 16) / 2);
    const blockH = narrow
      ? Math.floor((this.height - 10) / 2)
      : this.height;

    this.buildBlock(
      "By item type",
      d.byType,
      blockW,
      blockH,
      d.total,
      theme,
    );
    this.buildBlock(
      "By collection",
      d.byCollection,
      blockW,
      blockH,
      d.total,
      theme,
      d.uncategorized,
    );
    this.updateStatus();
  }

  private buildBlock(
    title: string,
    rawSegments: CompositionSegment[],
    blockW: number,
    blockH: number,
    grandTotal: number,
    theme: ThemeInfo,
    uncategorized?: number,
  ): void {
    if (!this.root || !this.ctx || !this.tooltip) return;
    const doc = this.ctx.doc;

    // Optionally fold an "uncategorized" wedge into the collection donut.
    const segments = rawSegments.slice();
    if (uncategorized && uncategorized > 0) {
      segments.push({
        key: "__uncategorized",
        label: "Uncategorized",
        count: uncategorized,
      });
    }

    const wrap = doc.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.flex = "1 1 0";
    wrap.style.minWidth = "0";
    wrap.style.alignItems = "stretch";

    const heading = doc.createElement("div");
    heading.style.fontSize = "12px";
    heading.style.fontWeight = "600";
    heading.style.marginBottom = "4px";
    heading.style.color = theme.fg;
    heading.textContent = title;
    wrap.appendChild(heading);

    const body = doc.createElement("div");
    body.style.display = "flex";
    body.style.flex = "1 1 0";
    body.style.minHeight = "0";
    body.style.gap = "8px";
    body.style.alignItems = "center";
    wrap.appendChild(body);

    // Donut SVG sized to the smaller of half-block-width / block-height.
    const donutBox = Math.max(
      60,
      Math.min(blockW * 0.5, blockH - 28),
    );
    const svg = svgEl(doc, "svg", {
      xmlns: "http://www.w3.org/2000/svg",
      width: donutBox,
      height: donutBox,
      viewBox: `0 0 ${donutBox} ${donutBox}`,
    }) as SVGSVGElement;
    svg.style.flex = "0 0 auto";
    body.appendChild(svg);

    const total = segments.reduce((s, x) => s + x.count, 0) || 1;
    const cx = donutBox / 2;
    const cy = donutBox / 2;
    const outerR = donutBox / 2 - 4;
    const innerR = outerR * 0.6;

    const arcByKey = new Map<string, SVGElement>();
    const legendEntries: LegendEntry[] = [];
    let angle = -Math.PI / 2; // start at 12 o'clock

    segments.forEach((seg, i) => {
      const frac = seg.count / total;
      const start = angle;
      const end = angle + frac * Math.PI * 2;
      angle = end;
      const color = colorForKey(i, theme.series);
      const percent = frac * 100;

      // Single-category guard: a full ring still needs a valid (clamped) path.
      const dAttr = arcPath(cx, cy, innerR, outerR, start, end);
      const path = svgEl(doc, "path", {
        d: dAttr,
        fill: color,
        stroke: theme.bg,
        "stroke-width": 1,
        class: "bm-arc",
      });
      const titleEl = svgEl(doc, "title");
      titleEl.textContent = `${seg.label}: ${seg.count} (${Math.round(
        percent,
      )}%)`;
      path.appendChild(titleEl);
      arcByKey.set(seg.key, path);

      // Drill-down: collection slice -> open the collection; item-type slice ->
      // select that type's items in the library.
      (path as unknown as SVGElement).style.cursor = "pointer";
      path.addEventListener("click", () => {
        void this.onArcClick(seg.key);
      });

      const block = this.findBlockLater();
      path.addEventListener("pointerenter", (ev) => {
        this.highlightArc(block, seg.key);
        const xy = this.hostXY(
          (ev as PointerEvent).clientX,
          (ev as PointerEvent).clientY,
        );
        this.tooltip!.show(
          [
            { text: seg.label, variant: "strong" },
            { text: `${seg.count} (${Math.round(percent)}%)` },
          ],
          xy.x,
          xy.y,
        );
      });
      path.addEventListener("pointermove", (ev) => {
        const xy = this.hostXY(
          (ev as PointerEvent).clientX,
          (ev as PointerEvent).clientY,
        );
        this.tooltip!.show(
          [
            { text: seg.label, variant: "strong" },
            { text: `${seg.count} (${Math.round(percent)}%)` },
          ],
          xy.x,
          xy.y,
        );
      });
      path.addEventListener("pointerleave", () => {
        this.highlightArc(block, null);
        this.tooltip!.hide();
      });
      svg.appendChild(path);

      legendEntries.push({
        key: seg.key,
        label: seg.label,
        color,
        count: seg.count,
        percent,
      });
    });

    // Centre total.
    svg.appendChild(
      svgText(doc, String(grandTotal), {
        x: cx,
        y: cy - 1,
        "text-anchor": "middle",
        "font-size": Math.max(12, Math.round(innerR * 0.5)),
        "font-weight": 600,
        fill: theme.fg,
      }),
    );
    svg.appendChild(
      svgText(doc, "items", {
        x: cx,
        y: cy + Math.round(innerR * 0.45),
        "text-anchor": "middle",
        "font-size": 9,
        fill: theme.muted,
      }),
    );

    const legendWrap = doc.createElement("div");
    legendWrap.style.flex = "1 1 0";
    legendWrap.style.minWidth = "0";
    legendWrap.style.maxHeight = "100%";
    legendWrap.style.overflow = "hidden";
    body.appendChild(legendWrap);

    // Push the block now so highlightArc closures can resolve it.
    const blockObj: DonutBlock = {
      wrap,
      svg,
      legend: null as unknown as Legend,
      segments,
      arcByKey,
      title,
    };
    this.blocks.push(blockObj);

    const legend = renderLegend(doc, legendEntries, theme, {
      onHover: (key) => this.highlightArc(blockObj, key),
    });
    blockObj.legend = legend;
    legendWrap.appendChild(legend.el);

    this.root.appendChild(wrap);
  }

  /** Resolve the block being built; the most recently pushed one. */
  /**
   * Drill-down when a donut slice is clicked. Collection slices (key "c:<id>")
   * navigate to that collection; item-type slices select that type's items in
   * the library. The "Other" aggregate matches no type, so it is a safe no-op.
   */
  private async onArcClick(key: string): Promise<void> {
    if (!this.ctx) return;
    if (key.startsWith("c:")) {
      const id = parseInt(key.slice(2), 10);
      if (Number.isFinite(id)) this.ctx.openCollection?.(id);
      return;
    }
    try {
      const items = await this.ctx.data.items();
      const ids = items
        .filter((it) => {
          try {
            return it.itemType === key;
          } catch {
            return false;
          }
        })
        .map((it) => it.id);
      this.ctx.revealItems?.(ids);
    } catch (e) {
      this.ctx.log?.("[composition] drill-down failed", e);
    }
  }

  private findBlockLater(): DonutBlock {
    // Closures created during buildBlock reference the block pushed at the end
    // of that same call; return a thunk-resolved reference via index.
    const idx = this.blocks.length;
    const self = this;
    return new Proxy({} as DonutBlock, {
      get(_t, prop) {
        const b = self.blocks[idx];
        return b ? (b as any)[prop] : undefined;
      },
    });
  }

  private highlightArc(block: DonutBlock, key: string | null): void {
    if (!block) return;
    for (const [k, arc] of block.arcByKey) {
      arc.setAttribute("opacity", key === null || k === key ? "1" : "0.35");
    }
    block.legend?.highlight(key);
  }

  private renderEmpty(theme: ThemeInfo, msg: string): void {
    if (!this.root || !this.ctx) return;
    const p = this.ctx.doc.createElement("div");
    p.style.flex = "1 1 auto";
    p.style.display = "flex";
    p.style.alignItems = "center";
    p.style.justifyContent = "center";
    p.style.color = theme.muted;
    p.style.fontSize = "13px";
    p.textContent = msg;
    this.root.appendChild(p);
  }

  private updateStatus(): void {
    if (!this.ctx || !this.data) return;
    const d = this.data;
    const uncat =
      d.uncategorized > 0 ? `, ${d.uncategorized} uncategorized` : "";
    this.ctx.setStatus(
      `${d.total} items, ${d.byType.length} types${uncat}`,
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
    if (!this.ctx) return;
    try {
      this.data = await this.ctx.data.composition();
    } catch (e) {
      this.ctx.log("[composition] refetch failed", e);
    }
    this.render();
  }

  destroy(): void {
    this.clearBlocks();
    this.tooltip?.destroy();
    this.tooltip = null;
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
    this.data = null;
  }

  /**
   * Compose both donuts into one standalone SVG for export. Builds an offscreen
   * <svg> laying the two donut groups side by side with their titles.
   */
  private buildExportSvg(theme: ThemeInfo): SVGSVGElement {
    const doc = this.ctx!.doc;
    const w = this.width;
    const h = this.height;
    const svg = svgEl(doc, "svg", {
      xmlns: "http://www.w3.org/2000/svg",
      width: w,
      height: h,
      viewBox: `0 0 ${w} ${h}`,
    }) as SVGSVGElement;
    if (this.blocks.length === 0) {
      const t = svgText(doc, "No data", {
        x: w / 2,
        y: h / 2,
        "text-anchor": "middle",
        "font-size": 14,
        fill: theme.muted,
      });
      svg.appendChild(t);
      return svg;
    }
    const n = this.blocks.length;
    const colW = w / n;
    this.blocks.forEach((b, i) => {
      const g = svgEl(doc, "g", {
        transform: `translate(${i * colW + 10}, 28)`,
      });
      const heading = svgText(doc, b.title, {
        x: 0,
        y: -10,
        "font-size": 12,
        "font-weight": 600,
        fill: theme.fg,
      });
      g.appendChild(heading);
      // Clone the live donut svg's children (arcs + centre text).
      const clone = b.svg.cloneNode(true) as SVGSVGElement;
      const inner = svgEl(doc, "g");
      while (clone.firstChild) inner.appendChild(clone.firstChild);
      g.appendChild(inner);
      svg.appendChild(g);
    });
    return svg;
  }

  async exportSVG(): Promise<ExportResult> {
    if (!this.ctx) throw new Error("chart not mounted");
    const theme = this.ctx.theme();
    const composed = this.buildExportSvg(theme);
    const text = serializeSVG(composed, theme);
    return { text, suggestedName: "bibliometero-composition", format: "svg" };
  }

  async exportPNG(): Promise<ExportResult> {
    if (!this.ctx) throw new Error("chart not mounted");
    const theme = this.ctx.theme();
    const composed = this.buildExportSvg(theme);
    const text = serializeSVG(composed, theme);
    const blob = await svgToPng(
      this.ctx.doc,
      text,
      this.width,
      this.height,
      2,
      theme.bg,
    );
    return { blob, suggestedName: "bibliometero-composition", format: "png" };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      arcCount: () =>
        this.blocks.reduce(
          (sum, b) => sum + b.svg.querySelectorAll(".bm-arc").length,
          0,
        ),
      getTooltipText: () => this.tooltip?.el.textContent ?? "",
    };
  }
}
