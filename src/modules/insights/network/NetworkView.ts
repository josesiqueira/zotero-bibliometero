/**
 * NetworkView.ts - reusable canvas network component (a VizModule).
 *
 * Parameterized by a NetModel passed to the constructor. Owns:
 *   - the canvas (devicePixelRatio-correct backing store),
 *   - the ForceSim,
 *   - the InteractionController (pointer state machine),
 *   - a ViewTransform { scale, tx, ty },
 *   - a hover tooltip (DOM overlay),
 *   - a small toolbar built into ctx.controlsSlot (Re-layout / Fit / Release pins).
 *
 * The wrapping view (coauthorshipView / authorPaperView) converts its dataset
 * into a NetModel and hands it here, so this class never touches Zotero data
 * shapes. It does call ctx.openItem for the one-click-to-paper behaviour.
 *
 * The three quality fixes live in forceSim.ts (#1), interaction.ts (#2) and the
 * click routing below (#3).
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
  nodeRadius,
  styleFromTheme,
  type SceneState,
  type SceneStyle,
  type SvgBounds,
  type ViewTransform,
} from "./scene";

const FIT_PADDING = 60;

export class NetworkView implements VizModule {
  readonly id: string;
  readonly label: string;
  readonly icon =
    '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="4" cy="4" r="2" fill="context-stroke"/><circle cx="12" cy="6" r="2" fill="context-stroke"/><circle cx="7" cy="12" r="2" fill="context-stroke"/><line x1="4" y1="4" x2="12" y2="6" stroke="context-stroke"/><line x1="4" y1="4" x2="7" y2="12" stroke="context-stroke"/></svg>';
  readonly kind = "network" as const;

  private model: NetModel;
  private ctx: VizContext | null = null;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private cctx: CanvasRenderingContext2D | null = null;
  private tooltip: HTMLElement | null = null;

  private sim: ForceSim;
  private interaction: InteractionController | null = null;
  private view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
  private style: SceneStyle | null = null;

  private highlight = new Set<string>();
  private hover: string | null = null;

  private rafHandle = 0;
  private looping = false;
  private destroyed = false;
  private didFirstFit = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  // Bound toolbar buttons (for cleanup).
  private toolbarEl: HTMLElement | null = null;

  constructor(id: string, label: string, model: NetModel) {
    this.id = id;
    this.label = label;
    this.model = model;
    this.sim = new ForceSim();
  }

  /** Replace the model in place (onDataChange) and re-run layout. */
  setModel(model: NetModel): void {
    this.model = model;
    this.highlight.clear();
    this.hover = null;
    this.didFirstFit = false;
    this.sim.setGraph(model);
    this.startLoop();
  }

  // ---- VizModule lifecycle -------------------------------------------

  mount(container: HTMLElement, ctx: VizContext): void {
    this.ctx = ctx;
    this.destroyed = false;
    const doc = ctx.doc;

    const host = doc.createElement("div");
    host.className = "bibliometero-network-host";
    host.style.position = "relative";
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.overflow = "hidden";

    const canvas = doc.createElement("canvas");
    canvas.className = "bibliometero-network-canvas";
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);

    const tooltip = doc.createElement("div");
    tooltip.className = "bibliometero-network-tooltip";
    tooltip.style.position = "absolute";
    tooltip.style.pointerEvents = "none";
    host.appendChild(tooltip);

    container.appendChild(host);

    this.host = host;
    this.canvas = canvas;
    this.tooltip = tooltip;
    const cctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!cctx) throw new Error("NetworkView: 2D context unavailable");
    this.cctx = cctx;

    this.style = styleFromTheme(ctx.theme());

    // Size the backing store from the host box.
    const w = host.clientWidth || container.clientWidth || 600;
    const h = host.clientHeight || container.clientHeight || 400;
    this.resizeCanvas(w, h);
    this.sim.setCenter(this.cssW / 2, this.cssH / 2);
    this.sim.setGraph(this.model);

    this.buildToolbar(ctx);
    this.attachInteraction();
    this.startLoop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    if (this.interaction) this.interaction.detach();
    this.interaction = null;
    if (this.toolbarEl && this.toolbarEl.parentNode) {
      this.toolbarEl.parentNode.removeChild(this.toolbarEl);
    }
    this.toolbarEl = null;
    if (this.host && this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
    this.host = null;
    this.canvas = null;
    this.cctx = null;
    this.tooltip = null;
  }

  onResize(width: number, height: number): void {
    if (this.destroyed || !this.canvas) return;
    this.resizeCanvas(width, height);
    this.sim.setCenter(this.cssW / 2, this.cssH / 2);
    // Do NOT reheat on resize; just redraw at the new size.
    this.requestDraw();
  }

  onThemeChange(): void {
    if (this.destroyed || !this.ctx) return;
    this.style = styleFromTheme(this.ctx.theme());
    this.requestDraw();
  }

  onDataChange(): void {
    // The wrapping view re-fetches and calls setModel(); nothing to do here.
  }

  async exportPNG(): Promise<ExportResult> {
    const bounds = this.fitBounds();
    const scale = 2;
    const doc = this.ctx?.doc || (this.canvas && this.canvas.ownerDocument);
    const off = doc
      ? (doc.createElement("canvas") as HTMLCanvasElement)
      : (null as unknown as HTMLCanvasElement);
    const pad = FIT_PADDING;
    const outW = Math.max(1, Math.round((bounds.width + pad * 2) * scale));
    const outH = Math.max(1, Math.round((bounds.height + pad * 2) * scale));
    off.width = outW;
    off.height = outH;
    const octx = off.getContext("2d") as CanvasRenderingContext2D | null;
    const style = this.style || styleFromTheme(this.ctx!.theme());
    if (octx) {
      // World transform that maps fit-bounds (+padding) to the offscreen canvas.
      const view: ViewTransform = {
        scale,
        tx: (-bounds.minX + pad) * scale,
        ty: (-bounds.minY + pad) * scale,
      };
      const backend = new CanvasBackend(octx, 1);
      const state: SceneState = {
        highlight: new Set(),
        hover: null,
        showLabels: true,
        cssW: outW,
        cssH: outH,
      };
      drawScene(this.model, view, style, state, backend);
    }
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        off.toBlob((b) => resolve(b), "image/png");
      } catch {
        resolve(null);
      }
    });
    return {
      blob: blob || undefined,
      suggestedName: `bibliometero-${this.id}`,
      format: "png",
    };
  }

  async exportSVG(): Promise<ExportResult> {
    const inner = this.fitBounds();
    const pad = FIT_PADDING;
    const bounds: SvgBounds = {
      minX: inner.minX - pad,
      minY: inner.minY - pad,
      width: inner.width + pad * 2,
      height: inner.height + pad * 2,
    };
    const style = this.style || styleFromTheme(this.ctx!.theme());
    const backend = new SvgBackend(bounds);
    // Identity world view: SVG emits world coords directly with a viewBox.
    const view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
    const state: SceneState = {
      highlight: new Set(),
      hover: null,
      showLabels: true,
      cssW: bounds.width,
      cssH: bounds.height,
    };
    drawScene(this.model, view, style, state, backend);
    return {
      text: backend.serialize(),
      suggestedName: `bibliometero-${this.id}`,
      format: "svg",
    };
  }

  testHooks(): Record<string, (...args: any[]) => any> {
    return {
      getNodePositions: () => {
        const out: Record<string, { x: number; y: number; fx: number | null; fy: number | null }> = {};
        for (const n of this.model.nodes) {
          out[n.id] = { x: n.x, y: n.y, fx: n.fx, fy: n.fy };
        }
        return out;
      },
      isSettled: () => this.sim.settled,
      dispatchPointer: (type: "down" | "move" | "up" | "cancel", x: number, y: number) => {
        if (this.interaction) this.interaction.dispatch(type, x, y);
      },
      getTooltipText: () => (this.tooltip ? this.tooltip.textContent || "" : ""),
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
      const running = this.sim.tick();
      this.draw();
      // Fit once, the first time the layout settles.
      if (!running && !this.didFirstFit) {
        this.didFirstFit = true;
        this.fit();
        this.draw();
      }
      if (running) {
        this.rafHandle = win.requestAnimationFrame(step);
      } else {
        // Settled: STOP the rAF loop (quality fix #1). Positions are frozen.
        this.looping = false;
        this.rafHandle = 0;
      }
    };
    this.rafHandle = win.requestAnimationFrame(step);
  }

  private stopLoop(): void {
    const win = this.canvas?.ownerDocument?.defaultView;
    if (this.rafHandle && win) win.cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.looping = false;
  }

  /** Draw one frame; if the loop is stopped, also schedules a single frame. */
  private requestDraw(): void {
    if (this.looping) return; // the loop already redraws every frame
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

  private fitBounds(): { minX: number; minY: number; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.model.nodes) {
      const r = nodeRadius(n);
      if (n.x - r < minX) minX = n.x - r;
      if (n.y - r < minY) minY = n.y - r;
      if (n.x + r > maxX) maxX = n.x + r;
      if (n.y + r > maxY) maxY = n.y + r;
    }
    if (!isFinite(minX)) {
      return { minX: 0, minY: 0, width: this.cssW || 1, height: this.cssH || 1 };
    }
    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  /** Zoom-to-bounds (toolbar Fit + first-settle). */
  private fit(): void {
    const b = this.fitBounds();
    const vw = this.cssW;
    const vh = this.cssH;
    const scale = Math.min(
      4,
      Math.max(0.1, Math.min((vw - FIT_PADDING) / b.width, (vh - FIT_PADDING) / b.height)),
    );
    const cx = b.minX + b.width / 2;
    const cy = b.minY + b.height / 2;
    this.view = { scale, tx: vw / 2 - cx * scale, ty: vh / 2 - cy * scale };
  }

  // ---- Toolbar --------------------------------------------------------

  private buildToolbar(ctx: VizContext): void {
    const doc = ctx.doc;
    const bar = doc.createElement("div");
    bar.className = "bibliometero-network-toolbar";

    const mk = (label: string, title: string, onClick: () => void) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "bibliometero-network-btn";
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", onClick);
      bar.appendChild(btn);
      return btn;
    };

    mk("Re-layout", "Reheat the force layout", () => {
      this.sim.reheat();
      this.startLoop();
    });
    mk("Fit", "Zoom to fit all nodes", () => {
      this.fit();
      this.requestDraw();
    });
    mk("Release pins", "Unpin all dragged nodes", () => {
      this.sim.releaseAll();
      this.sim.reheat();
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
        // Quality fix #1: drag-start does a single small bump, never reheat.
        this.sim.nudge(0.3);
        this.startLoop();
      },
      requestDraw: () => this.requestDraw(),
      onPan: (tx, ty) => {
        this.view.tx = tx;
        this.view.ty = ty;
      },
      onNodeClick: (node) => this.onNodeClick(node),
      onBackgroundClick: () => {
        if (this.highlight.size) {
          this.highlight.clear();
          this.requestDraw();
        }
      },
      onHover: (node, x, y) => this.onHover(node, x, y),
      onZoom: (factor, x, y) => this.onZoom(factor, x, y),
    });
    this.interaction.attach();
  }

  /** Quality fix #3: one click opens an item; author clicks highlight. */
  private onNodeClick(node: NetNode): void {
    if (node.kind === "item" && node.openable && typeof node.itemId === "number") {
      this.ctx?.openItem(node.itemId);
      return;
    }
    // Author / non-openable node: highlight it + its incident neighbours.
    const hi = new Set<string>([node.id]);
    for (const e of this.model.edges) {
      if (e.source === node.id) hi.add(e.target);
      else if (e.target === node.id) hi.add(e.source);
    }
    this.highlight = hi;
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
      this.showTooltip(this.tooltipFor(node), x, y);
    } else {
      this.canvas.style.cursor = "default";
      this.hideTooltip();
    }
  }

  private tooltipFor(node: NetNode): string {
    if (node.kind === "item" && node.openable) {
      return `${node.label}\nClick to open · drag to pin`;
    }
    const papers = Math.max(0, Math.round(node.weight));
    return `${node.label} · ${papers} paper${papers === 1 ? "" : "s"} · click to highlight`;
  }

  private showTooltip(text: string, x: number, y: number): void {
    if (!this.tooltip || !this.ctx) return;
    this.tooltip.textContent = "";
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = this.ctx.doc.createElement("div");
      if (i > 0) line.className = "bibliometero-tip-sub";
      line.textContent = lines[i];
      this.tooltip.appendChild(line);
    }
    this.tooltip.classList.add("bibliometero-show");
    const hostW = this.host?.clientWidth || 0;
    const tipW = this.tooltip.offsetWidth || 0;
    let left = x + 14;
    if (left + tipW > hostW) left = Math.max(4, x - tipW - 14);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${y + 14}px`;
  }

  private hideTooltip(): void {
    if (this.tooltip) this.tooltip.classList.remove("bibliometero-show");
  }

  private onZoom(factor: number, x: number, y: number): void {
    const newScale = Math.min(6, Math.max(0.08, this.view.scale * factor));
    const wx = (x - this.view.tx) / this.view.scale;
    const wy = (y - this.view.ty) / this.view.scale;
    this.view.scale = newScale;
    this.view.tx = x - wx * newScale;
    this.view.ty = y - wy * newScale;
    this.requestDraw();
  }
}
