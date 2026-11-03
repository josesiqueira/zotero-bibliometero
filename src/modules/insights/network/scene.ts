/**
 * scene.ts - Backend-neutral scene description for the network renderer.
 *
 * `drawScene(model, view, style, state, backend)` walks edges -> nodes ->
 * labels and emits primitives (line / circle / ring / text) to a Backend. The
 * SAME walk drives the live canvas and the exported figure (SvgBackend; the PNG
 * is rasterized from that SVG), so they can never diverge.
 *
 * Readability rules, following VOSviewer: node size grows with items, colour
 * shows the research group (or a fixed colour such as a paper's year), line
 * width grows with shared items, and labels are placed biggest node first and
 * skipped wherever they would overlap a label already placed. Sizes of lines,
 * outlines and text are in screen pixels, so they stay readable at any zoom.
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
  labelHalo: string;
  selectionRing: string;
  hoverGlow: string;
  /** Group colours, in group order (0 = largest group). */
  groups: string[];
  /** Fill for nodes outside any coloured group. */
  neutral: string;
  /** Fill per NodeKind when a node has no group or colour. */
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
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
  ): void;
  circle(x: number, y: number, r: number, fill: string): void;
  ring(x: number, y: number, r: number, color: string, width: number): void;
  /** Centered label with its top at y; `halo` is an outline for legibility. */
  text(
    x: number,
    y: number,
    text: string,
    color: string,
    fontPx: number,
    halo?: string,
  ): void;
  /** End world drawing. */
  endWorld(): void;
}

const LABEL_MAX_CHARS = 26;

/**
 * Node radius in SCREEN pixels from its weight (3.5 to 18 px). Sizes are fixed
 * on screen, as in VOSviewer, so zooming in spreads nodes apart instead of
 * inflating them into overlapping discs.
 */
export function nodeRadius(n: NetNode): number {
  return Math.min(18, 3.5 + 2.4 * Math.sqrt(Math.max(0, n.weight)));
}

/** Build a concrete drawing style from the theme palette. */
export function styleFromTheme(theme: ThemeInfo): SceneStyle {
  const series =
    theme.series && theme.series.length ? theme.series : [theme.accent];
  const dark = theme.mode === "dark";
  // Yellow is hard to see on a light background; keep it last.
  const groups = series.filter((c) => c.toLowerCase() !== "#999999");
  const yellow = groups.findIndex((c) => c.toLowerCase() === "#f0e442");
  if (yellow >= 0) groups.push(...groups.splice(yellow, 1));
  return {
    bg: theme.bg,
    edge: dark ? "rgba(200,205,215,0.28)" : "rgba(70,70,85,0.28)",
    edgeDim: dark ? "rgba(200,205,215,0.06)" : "rgba(70,70,85,0.06)",
    label: theme.fg,
    labelDim: theme.muted,
    labelHalo: theme.bg,
    selectionRing: theme.fg,
    hoverGlow: dark ? "rgba(138,180,248,0.40)" : "rgba(26,115,232,0.30)",
    groups,
    neutral: dark ? "#6f737b" : "#a3a6ad",
    kindColors: {
      item: groups[0] || theme.accent,
      author: groups[1] || theme.accent,
      tag: groups[2] || theme.accent,
    },
    nodeDim: dark ? "#3a3d44" : "#d9dadd",
  };
}

export interface SceneState {
  /** Highlighted node ids (rest dimmed); empty = no highlight. */
  highlight: Set<string>;
  /** Currently hovered node id, or null. */
  hover: string | null;
  /** Draw node labels. */
  showLabels: boolean;
  /** CSS pixel viewport size (for the background fill). */
  cssW: number;
  cssH: number;
}

export function nodeColor(style: SceneStyle, n: NetNode): string {
  if (n.color) return n.color;
  if (typeof n.group === "number") {
    return n.group >= 0
      ? style.groups[n.group % style.groups.length] || style.neutral
      : style.neutral;
  }
  return style.kindColors[n.kind] || style.kindColors.item;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Walk the model and emit primitives to the backend. Identical for the live
 * canvas and the exported figure.
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
  const px = 1 / view.scale; // one screen pixel in world units

  const hasHi = state.highlight.size > 0;
  const byId = new Map<string, NetNode>();
  for (const n of model.nodes) byId.set(n.id, n);

  // --- Edges: width grows with shared items (screen px). ---
  for (const e of model.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const incident =
      !hasHi ||
      (state.highlight.has(e.source) && state.highlight.has(e.target));
    const width = (0.7 + Math.min(3.5, 1.1 * Math.log2(1 + e.weight))) * px;
    backend.line(
      s.x,
      s.y,
      t.x,
      t.y,
      incident ? style.edge : style.edgeDim,
      width,
    );
  }

  // --- Nodes, small first so big ones sit on top. ---
  const ordered = model.nodes.slice().sort((a, b) => a.weight - b.weight);
  for (const n of ordered) {
    const r = nodeRadius(n) * px;
    const isHi = state.highlight.has(n.id);
    const dim = hasHi && !isHi;
    if (state.hover === n.id)
      backend.circle(n.x, n.y, r + 5 * px, style.hoverGlow);
    backend.circle(n.x, n.y, r, dim ? style.nodeDim : nodeColor(style, n));
    backend.ring(n.x, n.y, r, style.bg, 1.2 * px);
    if (
      isHi &&
      hasHi &&
      state.highlight.size > 1 &&
      n.id === firstOf(state.highlight)
    ) {
      backend.ring(n.x, n.y, r + 2.5 * px, style.selectionRing, 2 * px);
    }
  }

  // --- Labels: biggest first, skip any that would overlap (screen space). ---
  if (!state.showLabels) {
    backend.endWorld();
    return;
  }
  const placed: Array<[number, number, number, number]> = [];
  const overlaps = (b: [number, number, number, number]) =>
    placed.some(
      (p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1],
    );
  const maxW = model.nodes.reduce((m, n) => Math.max(m, n.weight), 1);
  const wanted = (n: NetNode) =>
    n.id === state.hover ? 3 : hasHi ? (state.highlight.has(n.id) ? 2 : -1) : 1;
  const order = model.nodes
    .filter((n) => wanted(n) > 0)
    .sort(
      (a, b) =>
        wanted(b) - wanted(a) ||
        b.weight - a.weight ||
        (a.label < b.label ? -1 : 1),
    );
  for (const n of order) {
    const r = nodeRadius(n) * px;
    const fontPx = 10.5 + 3.5 * Math.sqrt(n.weight / maxW); // 10.5 to 14 screen px
    const text = truncate(n.label, LABEL_MAX_CHARS);
    const sx = n.x * view.scale + view.tx;
    const sy = n.y * view.scale + view.ty + r * view.scale + 2;
    const halfW = (text.length * fontPx * 0.56) / 2;
    const box: [number, number, number, number] = [
      sx - halfW - 2,
      sy - 1,
      sx + halfW + 2,
      sy + fontPx + 1,
    ];
    const forced = n.id === state.hover;
    if (!forced) {
      if (
        box[2] < 0 ||
        box[0] > state.cssW ||
        box[3] < 0 ||
        box[1] > state.cssH
      )
        continue;
      if (overlaps(box)) continue;
    }
    placed.push(box);
    const color =
      hasHi && !state.highlight.has(n.id) ? style.labelDim : style.label;
    backend.text(
      n.x,
      n.y + r + 2 * px,
      text,
      color,
      fontPx * px,
      style.labelHalo,
    );
  }

  backend.endWorld();
}

function firstOf(set: Set<string>): string | undefined {
  for (const v of set) return v;
  return undefined;
}

/* ----------------------------------------------------------------------------
 * CanvasBackend - draws to a CanvasRenderingContext2D.
 * ------------------------------------------------------------------------- */

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

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
    ctx.lineJoin = "round";
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
  ): void {
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

  text(
    x: number,
    y: number,
    text: string,
    color: string,
    fontPx: number,
    halo?: string,
  ): void {
    const ctx = this.ctx;
    ctx.font = `${fontPx}px ${FONT}`;
    if (halo) {
      ctx.strokeStyle = halo;
      ctx.lineWidth = fontPx * 0.28;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  endWorld(): void {
    this.ctx.restore();
  }
}

/* ----------------------------------------------------------------------------
 * SvgBackend - accumulates primitives as SVG markup inside a transformed group,
 * for the exported figure (see NetworkView.exportAs).
 * ------------------------------------------------------------------------- */

export class SvgBackend implements SceneBackend {
  private parts: string[] = [];

  background(): void {
    /* the figure draws its own background */
  }

  beginWorld(view: ViewTransform): void {
    this.parts.push(
      `<g transform="translate(${f(view.tx)} ${f(view.ty)}) scale(${f(view.scale)})">`,
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
  ): void {
    this.parts.push(
      `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ` +
        `stroke="${esc(color)}" stroke-width="${f(Math.max(0.01, width))}" />`,
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
        `stroke="${esc(color)}" stroke-width="${f(Math.max(0.01, width))}" />`,
    );
  }

  text(
    x: number,
    y: number,
    text: string,
    color: string,
    fontPx: number,
    halo?: string,
  ): void {
    const outline = halo
      ? ` stroke="${esc(halo)}" stroke-width="${f(fontPx * 0.28)}" paint-order="stroke" stroke-linejoin="round"`
      : "";
    this.parts.push(
      `<text x="${f(x)}" y="${f(y)}" fill="${esc(color)}" font-size="${f(fontPx)}" ` +
        `text-anchor="middle" dominant-baseline="hanging"${outline}>${esc(text)}</text>`,
    );
  }

  endWorld(): void {
    this.parts.push("</g>");
  }

  /** The accumulated markup (one transformed <g>). */
  markup(): string {
    return this.parts.join("\n");
  }
}

function f(n: number): string {
  if (!isFinite(n)) return "0";
  return (Math.round(n * 1000) / 1000).toString();
}

export function esc(s: string): string {
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
