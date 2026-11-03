/**
 * NetworkView.ts - reusable canvas network component (a VizModule).
 *
 * Parameterized by a NetModel and a few presentation options passed by the
 * wrapping view (coauthorshipView / authorPaperView). Owns:
 *   - the canvas (devicePixelRatio-correct backing store) and its draw loop,
 *   - the ForceSim, run several steps per frame so a layout settles in about a
 *     second, and kept zoomed to fit while it settles unless the user pans,
 *     zooms or drags,
 *   - the InteractionController (pointer state machine: drag to pin, pan,
 *     wheel zoom, click),
 *   - a hover tooltip and a legend overlay (DOM),
 *   - a small toolbar in ctx.controlsSlot (Re-layout / Fit / Release pins),
 *   - figure export (the same scene drawn into a fixed-size light figure).
 *
 * Clicks: an openable item node opens the item; any other node highlights
 * itself and its neighbours (the wrapper explains it on the status line); a
 * double-click on a node with itemIds selects those items in the library.
 */

import type {
  ExportResult,
  NetModel,
  NetNode,
  VizContext,
  VizModule,
} from "../types";
import { ForceSim } from "./forceSim";
import { InteractionController } from "./interaction";
import {
  CanvasBackend,
  SvgBackend,
  drawScene,
  esc,
  styleFromTheme,
  type SceneState,
  type SceneStyle,
  type ViewTransform,
} from "./scene";
import { svgToPng } from "../charts/chartkit/exporter";
import {
  exportTheme,
  FONT_FAMILY,
  isoDate,
  FIGURE_W,
  FIGURE_H,
} from "../charts/chartkit/figure";

const FIT_PADDING = 48;
/** Milliseconds of simulation per frame, and the frame interval. The loop runs
 * on a timer, not requestAnimationFrame, so a layout still finishes while the
 * window is hidden or minimized (Firefox pauses animation frames then). */
const FRAME_BUDGET_MS = 12;
const FRAME_MS = 16;
const DOUBLE_CLICK_MS = 450;

export interface LegendEntry {
  label: string;
  /** Explicit colour, or a group index resolved against the theme. */
  color?: string;
  group?: number;
}

export interface NetworkOptions {
  /** A node was selected (clicked) or the selection cleared (null). */
  onSelect?(node: NetNode | null, neighbours: NetNode[]): void;
  /** Legend rows (colour meaning) plus one line explaining size and lines. */
  legend?(): { entries: LegendEntry[]; note: string };
  /** Figure title and caption for exports. */
  figure?(): { title: string; caption: string; name: string };
}

export class NetworkView implements VizModule {
  readonly id: string;
  readonly label: string;
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="4" r="2" fill="context-stroke"/><circle cx="12" cy="6" r="2" fill="context-stroke"/><circle cx="7" cy="12" r="2" fill="context-stroke"/><line x1="4" y1="4" x2="12" y2="6" stroke="context-stroke"/><line x1="4" y1="4" x2="7" y2="12" stroke="context-stroke"/></svg>';
  readonly kind = "network" as const;

  private model: NetModel;
  private opts: NetworkOptions;
  private ctx: VizContext | null = null;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cctx: CanvasRenderingContext2D | null = null;
  private tooltip: HTMLElement | null = null;
  private legendEl: HTMLElement | null = null;

  private sim: ForceSim;
  private interaction: InteractionController | null = null;
  private view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
  private style: SceneStyle | null = null;

  private highlight = new Set<string>();
  private hover: string | null = null;
  private lastClick: { id: string; at: number } | null = null;

  private rafHandle = 0;
  private looping = false;
  private destroyed = false;
  /** Keep fitting the view while the layout settles, until the user moves it. */
  private autoFit = true;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private toolbarEl: HTMLElement | null = null;

  constructor(
    id: string,
    label: string,
    model: NetModel,
    opts: NetworkOptions = {},
  ) {
    this.id = id;
    this.label = label;
    this.model = model;
    this.opts = opts;
    this.sim = new ForceSim();
    this.tuneForces();
  }

  /** Scale repulsion and link length to the graph size. */
  private tuneForces(): void {
    const n = this.model.nodes.length;
    const charge = -Math.max(220, Math.round(1.2 * n));
    const linkDistance = n > 250 ? 60 : n > 80 ? 52 : 46;
    this.sim.setParams({ charge, linkDistance, gravity: 0.03 });
  }

  /**
   * Replace the model (data refresh). Nodes that still exist keep their
   * position and pin, so the map does not reshuffle when one item changes.
   */
  setModel(model: NetModel): void {
    const old = new Map(this.model.nodes.map((n) => [n.id, n]));
    let kept = 0;
    for (const n of model.nodes) {
      const o = old.get(n.id);
      if (!o) continue;
      n.x = o.x;
      n.y = o.y;
      n.fx = o.fx;
      n.fy = o.fy;
      kept++;
    }
    this.model = model;
    this.highlight.clear();
    this.hover = null;
    this.tuneForces();
    this.sim.setGraph(model);
    if (kept > model.nodes.length * 0.6) this.sim.nudge(0.3);
    else this.autoFit = true;
    this.renderLegend();
    this.startLoop();
  }

  // ---- VizModule lifecycle -------------------------------------------

  mount(container: HTMLElement, ctx: VizContext): void {
    this.ctx = ctx;
    this.destroyed = false;
    const doc = ctx.doc;

    const host = doc.createElement("div");
    host.className = "bibliometero-network-host";
    const canvas = doc.createElement("canvas");
    canvas.className = "bibliometero-network-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", this.label);
    host.appendChild(canvas);
    const legend = doc.createElement("div");
    legend.className = "bibliometero-network-legend";
    host.appendChild(legend);
    const tooltip = doc.createElement("div");
    tooltip.className = "bibliometero-network-tooltip";
    host.appendChild(tooltip);
    container.appendChild(host);

    this.host = host;
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.legendEl = legend;
    const cctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!cctx) throw new Error("NetworkView: 2D context unavailable");
    this.cctx = cctx;
    this.style = styleFromTheme(ctx.theme());

    const w = host.clientWidth || container.clientWidth || 600;
    const h = host.clientHeight || container.clientHeight || 400;
    this.resizeCanvas(w, h);
    this.sim.setCenter(0, 0);
    this.sim.setGraph(this.model);

    this.buildToolbar(ctx);
    this.attachInteraction();
    this.renderLegend();
    this.sim.setAspect(this.mapArea().w / this.mapArea().h);
    this.startLoop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    this.interaction?.detach();
    this.interaction = null;
    this.toolbarEl?.remove();
    this.toolbarEl = null;
    this.host?.remove();
    this.host = null;
    this.canvas = null;
    this.cctx = null;
    this.tooltip = null;
    this.legendEl = null;
  }

  onResize(width: number, height: number): void {
    if (this.destroyed || !this.canvas) return;
    const wasFit = this.autoFit || this.sim.settled;
    this.resizeCanvas(width, height);
    this.sim.setAspect(this.mapArea().w / this.mapArea().h);
    if (wasFit && this.autoFit) this.fit();
    this.requestDraw();
  }

  onThemeChange(): void {
    if (this.destroyed || !this.ctx) return;
    this.style = styleFromTheme(this.ctx.theme());
    this.renderLegend();
    this.requestDraw();
  }

  onDataChange(): void {
    // The wrapping view re-fetches and calls setModel().
  }

  // ---- Export: the same scene, as a light figure with title and legend -----

  private figureSvg(): string {
    const theme = exportTheme();
    const style = styleFromTheme(theme);
    const fig = this.opts.figure?.() ?? {
      title: this.label,
      caption: "",
      name: `bibliometero-${this.id}`,
    };
    const legend = this.opts.legend?.();
    const legendW = legend && legend.entries.length ? 240 : 0;
    const top = 68;
    const bottom = 48;
    const boxX = 24;
    const boxW = FIGURE_W - 48 - legendW;
    const boxH = FIGURE_H - top - bottom;

    const b = this.fitBounds();
    const scale = Math.min(4, (boxW - 90) / b.width, (boxH - 60) / b.height);
    const view: ViewTransform = {
      scale,
      tx: boxX + boxW / 2 - (b.minX + b.width / 2) * scale,
      ty: top + boxH / 2 - (b.minY + b.height / 2) * scale,
    };
    const backend = new SvgBackend();
    const state: SceneState = {
      highlight: new Set(),
      hover: null,
      showLabels: true,
      cssW: boxX + boxW,
      cssH: top + boxH,
    };
    drawScene(this.model, view, style, state, backend);

    const parts: string[] = [];
    parts.push(
      `<rect x="0" y="0" width="${FIGURE_W}" height="${FIGURE_H}" fill="${theme.bg}"/>`,
    );
    parts.push(
      `<text x="32" y="44" font-size="22" font-weight="600" fill="${theme.fg}">${esc(fig.title)}</text>`,
    );
    parts.push(backend.markup());
    if (legend && legend.entries.length) {
      const lx = FIGURE_W - 24 - legendW + 12;
      let y = top + 10;
      for (const e of legend.entries) {
        const color =
          e.color ??
          (typeof e.group === "number" && e.group >= 0
            ? style.groups[e.group % style.groups.length] || style.neutral
            : style.neutral);
        parts.push(`<circle cx="${lx + 6}" cy="${y}" r="6" fill="${color}"/>`);
        parts.push(
          `<text x="${lx + 18}" y="${y + 4}" font-size="13" fill="${theme.fg}">${esc(e.label)}</text>`,
        );
        y += 22;
      }
      parts.push(
        `<text x="${lx}" y="${y + 10}" font-size="12" fill="${theme.muted}">${esc(legend.note)}</text>`,
      );
    }
    parts.push(
      `<text x="32" y="${FIGURE_H - 22}" font-size="13" fill="${theme.muted}">${esc(fig.caption)}</text>`,
    );
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${FIGURE_W}" height="${FIGURE_H}" ` +
      `viewBox="0 0 ${FIGURE_W} ${FIGURE_H}" font-family="${esc(FONT_FAMILY)}">\n` +
      parts.join("\n") +
      `\n</svg>\n`
    );
  }

  private figureName(): string {
    const name = this.opts.figure?.().name ?? `bibliometero-${this.id}`;
    return `${name}-${isoDate()}`;
  }

  async exportSVG(): Promise<ExportResult> {
    return {
      text: this.figureSvg(),
      suggestedName: this.figureName(),
      format: "svg",
    };
  }

  async exportPNG(): Promise<ExportResult> {
    const doc = this.ctx?.doc || this.canvas?.ownerDocument;
    if (!doc) throw new Error("network not mounted");
    const blob = await svgToPng(
      doc,
      this.figureSvg(),
      FIGURE_W,
      FIGURE_H,
      2,
      "#ffffff",
    );
    return { blob, suggestedName: this.figureName(), format: "png" };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      // Positions in canvas CSS pixels (what dispatchPointer takes), so the
      // live harness can point at a node and compare drag tracking directly.
      getNodePositions: () =>
        this.model.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          itemId: n.itemId,
          x: n.x * this.view.scale + this.view.tx,
          y: n.y * this.view.scale + this.view.ty,
        })),
      isSettled: () => this.sim.settled,
      getView: () => ({
        scale: this.view.scale,
        tx: this.view.tx,
        ty: this.view.ty,
      }),
      dispatchPointer: (
        type: "down" | "move" | "up" | "cancel",
        x: number,
        y: number,
      ) => {
        if (this.interaction) this.interaction.dispatch(type, x, y);
      },
      getTooltipText: () =>
        this.tooltip ? this.tooltip.textContent || "" : "",
      getLegendText: () =>
        this.legendEl ? this.legendEl.textContent || "" : "",
    };
  }

  // ---- Canvas / loop --------------------------------------------------

  private resizeCanvas(cssW: number, cssH: number): void {
    if (!this.canvas) return;
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    const win = this.canvas.ownerDocument?.defaultView;
    this.dpr = (win && win.devicePixelRatio) || 1;
    const w = Math.max(1, Math.round(this.cssW * this.dpr));
    const h = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private startLoop(): void {
    if (this.looping || this.destroyed) return;
    const win = this.canvas?.ownerDocument?.defaultView;
    if (!win) return;
    this.looping = true;
    const step = () => {
      if (this.destroyed) {
        this.looping = false;
        return;
      }
      // Several simulation steps per frame, within a time budget.
      const start = Date.now();
      let running = true;
      do {
        running = this.sim.tick();
      } while (running && Date.now() - start < FRAME_BUDGET_MS);
      if (this.autoFit) this.fit();
      this.draw();
      if (running) {
        this.rafHandle = win.setTimeout(step, FRAME_MS);
      } else {
        // Settled: stop the loop; positions stay frozen until the next drag.
        this.looping = false;
        this.rafHandle = 0;
      }
    };
    this.rafHandle = win.setTimeout(step, 0);
  }

  private stopLoop(): void {
    const win = this.canvas?.ownerDocument?.defaultView;
    if (this.rafHandle && win) win.clearTimeout(this.rafHandle);
    this.rafHandle = 0;
    this.looping = false;
  }

  /** Draw one frame; if the loop is stopped, schedule a single frame. */
  private requestDraw(): void {
    if (this.looping) return;
    const win = this.canvas?.ownerDocument?.defaultView;
    if (!win) {
      this.draw();
      return;
    }
    win.requestAnimationFrame(() => {
      if (!this.destroyed) this.draw();
    });
  }

  private draw(): void {
    if (!this.cctx || !this.style) return;
    const backend = new CanvasBackend(this.cctx, this.dpr);
    const state: SceneState = {
      highlight: this.highlight,
      hover: this.hover,
      showLabels: true,
      cssW: this.cssW,
      cssH: this.cssH,
    };
    drawScene(this.model, this.view, this.style, state, backend);
  }

  // ---- Fit / bounds ---------------------------------------------------

  private fitBounds(): {
    minX: number;
    minY: number;
    width: number;
    height: number;
  } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // Node discs and labels are screen-sized; the fit padding leaves room.
    for (const n of this.model.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, width: 1, height: 1 };
    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  /** Zoom to show the whole graph (toolbar Fit, and while the layout settles). */
  private fit(): void {
    const b = this.fitBounds();
    const a = this.mapArea();
    const scale = Math.min(
      2.5,
      Math.max(
        0.05,
        Math.min(
          (a.w - FIT_PADDING * 2) / b.width,
          (a.h - FIT_PADDING * 2) / b.height,
        ),
      ),
    );
    this.view = {
      scale,
      tx: a.x + a.w / 2 - (b.minX + b.width / 2) * scale,
      ty: a.h / 2 - (b.minY + b.height / 2) * scale,
    };
  }

  /**
   * The part of the canvas the map is fitted into: everything right of the
   * legend when the panel is wide enough, so no node hides behind it.
   */
  private mapArea(): { x: number; w: number; h: number } {
    const vw = Math.max(1, this.cssW);
    const vh = Math.max(1, this.cssH);
    const lw = this.legendEl?.offsetWidth ?? 0;
    const left = lw > 0 && vw - lw > 2 * vh * 0.8 ? lw + 40 : 0;
    return { x: left, w: vw - left, h: vh };
  }

  // ---- Legend + toolbar ----------------------------------------------

  private renderLegend(): void {
    const el = this.legendEl;
    if (!el || !this.ctx || !this.style) return;
    el.textContent = "";
    const legend = this.opts.legend?.();
    if (!legend) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const doc = this.ctx.doc;
    for (const e of legend.entries) {
      const row = doc.createElement("div");
      row.className = "bm-legend-row";
      const dot = doc.createElement("span");
      dot.className = "bm-legend-dot";
      dot.style.background =
        e.color ??
        (typeof e.group === "number" && e.group >= 0
          ? this.style.groups[e.group % this.style.groups.length] ||
            this.style.neutral
          : this.style.neutral);
      row.appendChild(dot);
      const text = doc.createElement("span");
      text.className = "bm-legend-text";
      text.textContent = e.label;
      row.appendChild(text);
      el.appendChild(row);
    }
    const note = doc.createElement("div");
    note.className = "bm-legend-note";
    note.textContent = legend.note;
    el.appendChild(note);
  }

  private buildToolbar(ctx: VizContext): void {
    const doc = ctx.doc;
    const bar = doc.createElement("div");
    bar.className = "bibliometero-network-toolbar";
    const mk = (label: string, title: string, onClick: () => void) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "bm-hub-btn";
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", onClick);
      bar.appendChild(btn);
    };
    mk("Fit", "Zoom to show the whole map", () => {
      this.fit();
      this.requestDraw();
    });
    mk("Re-layout", "Lay the map out again from the current positions", () => {
      this.autoFit = true;
      this.sim.reheat();
      this.startLoop();
    });
    mk("Release pins", "Let nodes you dragged move freely again", () => {
      this.sim.releaseAll();
      this.sim.nudge(0.4);
      this.startLoop();
    });
    ctx.controlsSlot.appendChild(bar);
    this.toolbarEl = bar;
  }

  // ---- Interaction wiring --------------------------------------------

  private attachInteraction(): void {
    if (!this.canvas) return;
    this.interaction = new InteractionController(this.canvas, {
      getModel: () => this.model,
      getView: () => this.view,
      localPoint: (ev) => {
        const rect = this.canvas!.getBoundingClientRect();
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      },
      pinNode: (id, wx, wy) => this.sim.pin(id, wx, wy),
      nudgeSim: () => {
        // Drag start: one small bump so neighbours relax; never a full reheat.
        this.autoFit = false;
        this.sim.nudge(0.3);
        this.startLoop();
      },
      requestDraw: () => this.requestDraw(),
      onPan: (tx, ty) => {
        this.autoFit = false;
        this.view.tx = tx;
        this.view.ty = ty;
      },
      onNodeClick: (node) => this.onNodeClick(node),
      onBackgroundClick: () => {
        if (this.highlight.size) {
          this.highlight.clear();
          this.opts.onSelect?.(null, []);
          this.requestDraw();
        }
      },
      onHover: (node, x, y) => this.onHover(node, x, y),
      onZoom: (factor, x, y) => this.onZoom(factor, x, y),
    });
    this.interaction.attach();
  }

  private neighbours(node: NetNode): NetNode[] {
    const ids = new Set<string>();
    for (const e of this.model.edges) {
      if (e.source === node.id) ids.add(e.target);
      else if (e.target === node.id) ids.add(e.source);
    }
    return this.model.nodes.filter((n) => ids.has(n.id));
  }

  private onNodeClick(node: NetNode): void {
    const now = Date.now();
    const isDouble =
      this.lastClick &&
      this.lastClick.id === node.id &&
      now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { id: node.id, at: now };

    if (
      node.kind === "item" &&
      node.openable &&
      typeof node.itemId === "number"
    ) {
      // One click selects the item in the list (visible above the dock); a
      // double-click opens it.
      if (isDouble) this.ctx?.openItem(node.itemId);
      else this.ctx?.selectItem(node.itemId);
      return;
    }
    if (isDouble && node.itemIds?.length) {
      this.ctx?.showItems?.(node.itemIds, `by ${node.label}`);
      return;
    }
    const near = this.neighbours(node);
    this.highlight = new Set<string>([node.id, ...near.map((n) => n.id)]);
    this.opts.onSelect?.(node, near);
    this.requestDraw();
  }

  private onHover(node: NetNode | null, x: number, y: number): void {
    const newHover = node ? node.id : null;
    if (newHover !== this.hover) {
      this.hover = newHover;
      this.requestDraw();
    }
    if (!this.canvas) return;
    if (node) {
      const openable = node.kind === "item" && node.openable;
      this.canvas.style.cursor = openable ? "pointer" : "default";
      this.showTooltip(this.tooltipLines(node), x, y);
    } else {
      this.canvas.style.cursor = "";
      this.hideTooltip();
    }
  }

  private tooltipLines(node: NetNode): string[] {
    const lines = [node.label, ...(node.details || [])];
    if (node.kind === "item" && node.openable)
      lines.push("Click to select, double-click to open");
    else if (node.itemIds?.length)
      lines.push("Click to highlight, double-click to select items");
    return lines;
  }

  private showTooltip(lines: string[], x: number, y: number): void {
    if (!this.tooltip || !this.ctx) return;
    this.tooltip.textContent = "";
    lines.forEach((text, i) => {
      const line = this.ctx!.doc.createElement("div");
      line.className = i === 0 ? "bm-tip-title" : "bm-tip-sub";
      line.textContent = text;
      this.tooltip!.appendChild(line);
    });
    this.tooltip.classList.add("bibliometero-show");
    const hostW = this.host?.clientWidth || 0;
    const hostH = this.host?.clientHeight || 0;
    const tipW = this.tooltip.offsetWidth || 0;
    const tipH = this.tooltip.offsetHeight || 0;
    let left = x + 14;
    if (left + tipW > hostW) left = Math.max(4, x - tipW - 14);
    let top = y + 14;
    if (top + tipH > hostH) top = Math.max(4, y - tipH - 10);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltip?.classList.remove("bibliometero-show");
  }

  private onZoom(factor: number, x: number, y: number): void {
    this.autoFit = false;
    const newScale = Math.min(6, Math.max(0.05, this.view.scale * factor));
    const wx = (x - this.view.tx) / this.view.scale;
    const wy = (y - this.view.ty) / this.view.scale;
    this.view.scale = newScale;
    this.view.tx = x - wx * newScale;
    this.view.ty = y - wy * newScale;
    this.requestDraw();
  }
}
