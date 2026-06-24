/**
 * scene.ts - Backend-neutral scene description for the network renderer.
 *
 * `drawScene(model, view, style, backend)` walks edges -> nodes -> labels and
 * emits primitives (line / circle / ring / text) to a Backend. The SAME walk
 * drives the live canvas, the PNG export (CanvasBackend) and the SVG export
 * (SvgBackend), so they can never diverge.
 *
 * No Zotero references; dependency-free.
 */

import type { NetModel, NetNode, ThemeInfo } from "../types";

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** Resolved drawing style derived from a ThemeInfo (see styleFromTheme). */
export interface SceneStyle {
  bg: string;
  edge: string;
  edgeDim: string;
  label: string;
  labelDim: string;
  selectionRing: string;
  hoverGlow: string;
  /** Fill per NodeKind. */
  kindColors: { item: string; author: string; tag: string };
  /** Dimmed fill used when a selection/highlight exists. */
  nodeDim: string;
}

/** Backend the scene walk emits primitives to. All coords are WORLD space. */
export interface SceneBackend {
  /** Paint the background over the whole viewport (screen-space rect). */
  background(color: string, cssW: number, cssH: number): void;
  /** Begin drawing in world space (pan/zoom applied by the backend). */
  beginWorld(view: ViewTransform): void;
  line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void;
  circle(x: number, y: number, r: number, fill: string): void;
  ring(x: number, y: number, r: number, color: string, width: number): void;
  text(x: number, y: number, text: string, color: string, fontPx: number): void;
  /** End world drawing. */
  endWorld(): void;
}

/** Minimum scale at which labels are drawn (avoids clutter when zoomed out). */
const LABEL_SCALE_THRESHOLD = 0.7;
const BASE_RADIUS = 4;
const RADIUS_K = 2.2;

/** Node radius from its weight: 4 + 2.2 * sqrt(weight). */
export function nodeRadius(n: NetNode): number {
  return BASE_RADIUS + RADIUS_K * Math.sqrt(Math.max(0, n.weight));
}

/** Build a concrete drawing style from the theme palette. */
export function styleFromTheme(theme: ThemeInfo): SceneStyle {
  const series = theme.series && theme.series.length ? theme.series : [theme.accent];
  const pick = (i: number) => series[i % series.length] || theme.accent;
  const dark = theme.mode === "dark";
  return {
    bg: theme.bg,
    edge: dark ? "rgba(200,205,215,0.30)" : "rgba(80,80,90,0.35)",
    edgeDim: dark ? "rgba(200,205,215,0.07)" : "rgba(80,80,90,0.08)",
    label: theme.fg,
    labelDim: theme.muted,
    selectionRing: theme.accent,
    hoverGlow: dark ? "rgba(138,180,248,0.40)" : "rgba(26,115,232,0.35)",
    // item / author / tag distinguished via the categorical series.
    kindColors: { item: pick(0), author: pick(1), tag: pick(2) },
    nodeDim: theme.muted,
  };
}

export interface SceneState {
  /** Highlighted node ids (rest dimmed); empty = no highlight. */
  highlight: Set<string>;
  /** Currently hovered node id, or null. */
  hover: string | null;
  /** Draw node labels (suppressed when zoomed far out). */
  showLabels: boolean;
  /** CSS pixel viewport size (for the background fill). */
  cssW: number;
  cssH: number;
}

function nodeColor(style: SceneStyle, n: NetNode): string {
  return style.kindColors[n.kind] || style.kindColors.item;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Walk the model and emit primitives to the backend. Identical for live canvas,
 * PNG, and SVG so the three outputs always agree.
 */
export function drawScene(
  model: NetModel,
  view: ViewTransform,
  style: SceneStyle,
  state: SceneState,
  backend: SceneBackend,
): void {
  backend.background(style.bg, state.cssW, state.cssH);
  backend.beginWorld(view);

  const hasHi = state.highlight.size > 0;
  const byId = new Map<string, NetNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  // --- Edges ---
  for (const e of model.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const incident = !hasHi || state.highlight.has(e.source) || state.highlight.has(e.target);
    const color = incident ? style.edge : style.edgeDim;
    const width =
      ((incident ? 1 : 0.5) * (0.6 + Math.min(3, Math.log2(1 + e.weight)))) /
      view.scale;
    backend.line(s.x, s.y, t.x, t.y, color, width);
  }

  // --- Nodes ---
  for (const n of model.nodes) {
    const r = nodeRadius(n);
    const isHi = state.highlight.has(n.id);
    const isHover = state.hover === n.id;
    const dim = hasHi && !isHi;

    if (isHover) {
      backend.circle(n.x, n.y, r + 5 / view.scale, style.hoverGlow);
    }
    backend.circle(n.x, n.y, r, dim ? style.nodeDim : nodeColor(style, n));
    if (isHi) {
      backend.ring(n.x, n.y, r + 2.5 / view.scale, style.selectionRing, 2 / view.scale);
    }
  }

  // --- Labels ---
  if (state.showLabels && view.scale >= LABEL_SCALE_THRESHOLD) {
    const fontPx = 11 / view.scale;
    for (const n of model.nodes) {
      const dim = hasHi && !state.highlight.has(n.id);
      // With a highlight active, only label highlighted/hovered nodes.
      if (hasHi && dim && state.hover !== n.id) continue;
      const r = nodeRadius(n);
      const color = dim ? style.labelDim : style.label;
      backend.text(n.x, n.y + r + 2 / view.scale, truncate(n.label, 28), color, fontPx);
    }
  }

  backend.endWorld();
}

/* ----------------------------------------------------------------------------
 * CanvasBackend - draws to a CanvasRenderingContext2D.
 * ------------------------------------------------------------------------- */

export class CanvasBackend implements SceneBackend {
  private ctx: CanvasRenderingContext2D;
  /** Device pixel ratio baked into the base transform. */
  private dpr: number;

  constructor(ctx: CanvasRenderingContext2D, dpr = 1) {
    this.ctx = ctx;
    this.dpr = dpr;
  }

  background(color: string, cssW: number, cssH: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, cssW, cssH);
  }

  beginWorld(view: ViewTransform): void {
    const ctx = this.ctx;
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  circle(x: number, y: number, r: number, fill: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ring(x: number, y: number, r: number, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  text(x: number, y: number, text: string, color: string, fontPx: number): void {
    const ctx = this.ctx;
    ctx.font = `${fontPx}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  endWorld(): void {
    this.ctx.restore();
  }
}

/* ----------------------------------------------------------------------------
 * SvgBackend - accumulates primitives into one <svg> string.
 *
 * World coordinates are emitted directly; the SVG viewBox is set to the fit
 * bounds so the whole graph is visible without needing the live view transform.
 * ------------------------------------------------------------------------- */

export interface SvgBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export class SvgBackend implements SceneBackend {
  private parts: string[] = [];
  private bg = "#ffffff";
  private bounds: SvgBounds;

  constructor(bounds: SvgBounds) {
    this.bounds = bounds;
  }

  background(color: string): void {
    this.bg = color;
  }

  // The SVG uses an absolute viewBox; pan/zoom from the live view is ignored.
  beginWorld(): void {
    /* no-op: world coords are emitted directly */
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void {
    this.parts.push(
      `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ` +
        `stroke="${esc(color)}" stroke-width="${f(Math.max(0.1, width))}" />`,
    );
  }

  circle(x: number, y: number, r: number, fill: string): void {
    this.parts.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${esc(fill)}" />`,
    );
  }

  ring(x: number, y: number, r: number, color: string, width: number): void {
    this.parts.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="none" ` +
        `stroke="${esc(color)}" stroke-width="${f(Math.max(0.1, width))}" />`,
    );
  }

  text(x: number, y: number, text: string, color: string, fontPx: number): void {
    this.parts.push(
      `<text x="${f(x)}" y="${f(y)}" fill="${esc(color)}" ` +
        `font-family="sans-serif" font-size="${f(fontPx)}" ` +
        `text-anchor="middle" dominant-baseline="hanging">${esc(text)}</text>`,
    );
  }

  endWorld(): void {
    /* no-op */
  }

  /** Serialize the accumulated primitives into one standalone SVG document. */
  serialize(): string {
    const b = this.bounds;
    const w = Math.max(1, b.width);
    const h = Math.max(1, b.height);
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `viewBox="${f(b.minX)} ${f(b.minY)} ${f(w)} ${f(h)}" ` +
      `width="${f(w)}" height="${f(h)}">\n` +
      `<rect x="${f(b.minX)}" y="${f(b.minY)}" width="${f(w)}" height="${f(h)}" ` +
      `fill="${esc(this.bg)}" />\n` +
      this.parts.join("\n") +
      `\n</svg>\n`
    );
  }
}

function f(n: number): string {
  if (!isFinite(n)) return "0";
  return (Math.round(n * 100) / 100).toString();
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Hit-test slack added to a node radius, in WORLD units (caller divides). */
export function hitRadius(n: NetNode): number {
  return nodeRadius(n);
}
