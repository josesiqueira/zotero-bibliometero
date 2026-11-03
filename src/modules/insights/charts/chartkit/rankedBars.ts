/**
 * chartkit/rankedBars.ts - shared horizontal ranked-bar builder.
 *
 * Used by Top sources and Top authors (and the collections half of
 * Composition). Labels sit in a left column sized to the actual labels (up to
 * 42% of the width), values at the bar ends, a value axis on top. Rows never
 * shrink below a readable height: when they do not all fit, the first rows that
 * fit are drawn and the caller is told how many. Interaction (hover tooltip,
 * click) is optional so the same code draws exported figures.
 */

import type { ThemeInfo } from "../../types";
import { svgEl, svgText } from "./svg";
import { linearScale, niceMax, niceTicks } from "./scale";
import type { Tooltip } from "./tooltip";

export interface RankedEntry {
  label: string;
  value: number;
  key: string;
  /** Items behind this bar, for the click-through. */
  itemIds?: number[];
  /** Draw this bar in the muted colour (e.g. "Unfiled"). */
  muted?: boolean;
}

export interface RankedBarsOptions {
  entries: RankedEntry[];
  width: number;
  height: number;
  theme: ThemeInfo;
  /** Optional hover tooltip; omit for static (export) drawing. */
  tooltip?: Tooltip;
  /** Local-pixel pointer position for tooltip placement. */
  toHostXY?: (clientX: number, clientY: number) => { x: number; y: number };
  onBarClick?: (entry: RankedEntry) => void;
  /** Extra tooltip line, e.g. "12% of items". */
  detail?: (entry: RankedEntry) => string;
  /** Tooltip hint for clickable bars. */
  clickHint?: string;
}

const LABEL_FONT = 12;
const CHAR_W = 6.6; // average glyph width at 12px, for column sizing
const MIN_ROW = 18;
const MAX_ROW = 28;
const LABEL_GUTTER = 8;

/** Truncate to `max` chars with an ellipsis. */
function truncate(s: string, max: number): string {
  if (max <= 1 || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

/**
 * Draw ranked bars into `root` (appends one <g>). Returns how many rows were
 * drawn, which is less than entries.length when the height cannot fit them all.
 */
export function renderRankedBars(
  doc: Document,
  root: SVGElement,
  opts: RankedBarsOptions,
): number {
  const { entries, width, height, theme, tooltip } = opts;
  const g = svgEl(doc, "g", { class: "bm-ranked" }) as SVGGElement;
  root.appendChild(g);
  if (!entries.length) return 0;

  const marginTop = 20;
  const marginBottom = 4;
  const plotH = Math.max(1, height - marginTop - marginBottom);
  const fit = Math.max(1, Math.floor(plotH / MIN_ROW));
  const rows = entries.slice(0, Math.min(entries.length, fit));

  const longest = rows.reduce((m, e) => Math.max(m, e.label.length), 0);
  const maxCol = Math.floor(width * 0.42);
  const marginLeft = Math.max(
    60,
    Math.min(maxCol, Math.ceil(longest * CHAR_W) + LABEL_GUTTER),
  );
  const maxChars = Math.max(
    4,
    Math.floor((marginLeft - LABEL_GUTTER) / CHAR_W),
  );
  const valueChars = String(rows[0]?.value ?? 0).length;
  const marginRight = 14 + valueChars * 7;
  const plotW = Math.max(1, width - marginLeft - marginRight);

  const maxVal = rows.reduce((m, e) => Math.max(m, e.value), 0);
  const top = niceMax(maxVal);
  const xScale = linearScale([0, top], [marginLeft, marginLeft + plotW]);
  const rowH = Math.min(MAX_ROW, plotH / rows.length);
  const barH = Math.max(8, rowH * 0.7);
  const plotBottom = marginTop + rowH * rows.length;

  for (const t of niceTicks(maxVal, 5)) {
    const x = xScale(t);
    g.appendChild(
      svgEl(doc, "line", {
        x1: x,
        y1: marginTop,
        x2: x,
        y2: plotBottom,
        stroke: theme.grid,
        "stroke-width": 1,
        "shape-rendering": "crispEdges",
      }),
    );
    g.appendChild(
      svgText(doc, String(t), {
        x,
        y: marginTop - 6,
        "text-anchor": "middle",
        "font-size": 10,
        fill: theme.muted,
      }),
    );
  }

  const x0 = xScale(0);
  rows.forEach((e, i) => {
    const cy = marginTop + i * rowH + rowH / 2;
    const barW = Math.max(0, xScale(e.value) - x0);
    const fill = e.muted ? theme.muted : theme.accent;

    const labelEl = svgText(doc, truncate(e.label, maxChars), {
      x: marginLeft - LABEL_GUTTER,
      y: cy + 4,
      "text-anchor": "end",
      "font-size": LABEL_FONT,
      fill: theme.fg,
    });
    const title = svgEl(doc, "title");
    title.textContent = e.label;
    labelEl.appendChild(title);
    g.appendChild(labelEl);

    const rect = svgEl(doc, "rect", {
      x: x0,
      y: cy - barH / 2,
      width: barW,
      height: barH,
      rx: 2,
      fill,
      class: "bm-bar",
    });
    const rTitle = svgEl(doc, "title");
    rTitle.textContent = `${e.label}: ${e.value}`;
    rect.appendChild(rTitle);
    g.appendChild(rect);

    g.appendChild(
      svgText(doc, String(e.value), {
        x: x0 + barW + 5,
        y: cy + 4,
        "text-anchor": "start",
        "font-size": 11,
        fill: theme.muted,
      }),
    );

    if (!tooltip) return;
    const lines = () => {
      const out: Array<{ text: string; variant?: "strong" }> = [
        { text: e.label, variant: "strong" },
        { text: `${e.value} item${e.value === 1 ? "" : "s"}` },
      ];
      const extra = opts.detail?.(e);
      if (extra) out.push({ text: extra });
      if (opts.onBarClick && opts.clickHint) out.push({ text: opts.clickHint });
      return out;
    };
    const show = (ev: Event) => {
      for (const sib of g.querySelectorAll(".bm-bar")) {
        (sib as SVGElement).setAttribute(
          "opacity",
          sib === rect ? "1" : "0.35",
        );
      }
      const pe = ev as PointerEvent;
      const xy = opts.toHostXY
        ? opts.toHostXY(pe.clientX, pe.clientY)
        : { x: pe.clientX, y: pe.clientY };
      tooltip.show(lines(), xy.x, xy.y);
    };
    const leave = () => {
      for (const sib of g.querySelectorAll(".bm-bar")) {
        (sib as SVGElement).setAttribute("opacity", "1");
      }
      tooltip.hide();
    };
    for (const target of [rect, labelEl]) {
      target.addEventListener("pointerenter", show);
      target.addEventListener("pointermove", show);
      target.addEventListener("pointerleave", leave);
    }
    if (opts.onBarClick) {
      const click = () => opts.onBarClick!(e);
      for (const target of [rect, labelEl]) {
        (target as SVGElement).style.cursor = "pointer";
        target.addEventListener("click", click);
      }
    }
  });
  return rows.length;
}
