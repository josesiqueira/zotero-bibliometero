/**
 * chartkit/rankedBars.ts - shared horizontal ranked-bar builder.
 *
 * One implementation reused by topSourcesChart and topAuthorsChart. Draws a
 * column of left-anchored horizontal bars (longest = highest value), with a
 * truncated label inside/next to each bar, a value at the bar end, a value axis
 * with gridlines on top, hover tooltips (full label + count), and an optional
 * per-bar click (used by topAuthors -> focusAuthor). Pure geometry, defensive
 * against empty input and a single category.
 */

import type { ThemeInfo } from "../../types";
import { svgEl, svgText } from "./svg";
import { linearScale, niceMax, niceTicks } from "./scale";
import type { Tooltip } from "./tooltip";

export interface RankedEntry {
  label: string;
  value: number;
  key: string;
}

export interface RankedBarsOptions {
  entries: RankedEntry[];
  width: number;
  height: number;
  theme: ThemeInfo;
  maxLabelChars: number;
  tooltip: Tooltip;
  /** Local-pixel pointer position for tooltip placement. */
  toHostXY?: (clientX: number, clientY: number) => { x: number; y: number };
  onBarClick?: (entry: RankedEntry) => void;
  /** Optional formatter for the full label shown in the tooltip + <title>. */
  fullLabel?: (entry: RankedEntry) => string;
}

const ROW_HEIGHT = 24; // px per bar row (incl. gap)
const BAR_PAD = 5; // vertical gap between bars
const LABEL_GUTTER = 8;

/** Truncate to `max` chars with an ellipsis; never returns NaN-y geometry. */
function truncate(s: string, max: number): string {
  if (max <= 1 || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

/**
 * Build ranked bars into `svg`. Clears nothing (caller owns the svg); appends a
 * single <g>. Returns void per the contract.
 */
export function renderRankedBars(
  doc: Document,
  svg: SVGSVGElement,
  opts: RankedBarsOptions,
): void {
  const { entries, width, height, theme, maxLabelChars, tooltip } = opts;
  const g = svgEl(doc, "g", { class: "bm-ranked" }) as SVGGElement;
  svg.appendChild(g);

  if (!entries.length) {
    g.appendChild(
      svgText(doc, "No data to display.", {
        x: width / 2,
        y: height / 2,
        "text-anchor": "middle",
        "font-size": 12,
        fill: theme.muted,
      }),
    );
    return;
  }

  // Layout: reserve a left label column and a small right margin for values.
  const marginTop = 18;
  const marginBottom = 8;
  const marginLeft = Math.min(
    Math.max(80, maxLabelChars * 6.2),
    Math.floor(width * 0.42),
  );
  const marginRight = 36;
  const plotW = Math.max(1, width - marginLeft - marginRight);
  const plotH = Math.max(1, height - marginTop - marginBottom);

  const maxVal = entries.reduce((m, e) => Math.max(m, e.value), 0);
  const top = niceMax(maxVal);
  const xScale = linearScale([0, top], [marginLeft, marginLeft + plotW]);

  // Value gridlines (vertical) + tick labels along the top.
  const ticks = niceTicks(maxVal, 5);
  for (const t of ticks) {
    const x = xScale(t);
    g.appendChild(
      svgEl(doc, "line", {
        x1: x,
        y1: marginTop,
        x2: x,
        y2: marginTop + plotH,
        stroke: theme.grid,
        "stroke-width": 1,
        "shape-rendering": "crispEdges",
      }),
    );
    g.appendChild(
      svgText(doc, String(t), {
        x,
        y: marginTop - 5,
        "text-anchor": "middle",
        "font-size": 9,
        fill: theme.muted,
      }),
    );
  }

  // Each row: bar height derived from available space, capped to ROW_HEIGHT.
  const rowH = Math.min(ROW_HEIGHT, plotH / entries.length);
  const barH = Math.max(4, rowH - BAR_PAD);
  const x0 = xScale(0);

  entries.forEach((e, i) => {
    const rowTop = marginTop + i * rowH;
    const cy = rowTop + rowH / 2;
    const barW = Math.max(0, xScale(e.value) - x0);
    const full = opts.fullLabel ? opts.fullLabel(e) : e.label;

    // Left-column label (truncated), full text in <title> + tooltip.
    const labelEl = svgText(doc, truncate(e.label, maxLabelChars), {
      x: marginLeft - LABEL_GUTTER,
      y: cy + 3,
      "text-anchor": "end",
      "font-size": 11,
      fill: theme.fg,
    });
    const title = svgEl(doc, "title");
    title.textContent = full; // user data
    labelEl.appendChild(title);
    g.appendChild(labelEl);

    // The bar.
    const rect = svgEl(doc, "rect", {
      x: x0,
      y: cy - barH / 2,
      width: barW,
      height: barH,
      rx: 2,
      fill: theme.accent,
      class: "bm-bar",
    });
    const rTitle = svgEl(doc, "title");
    rTitle.textContent = full;
    rect.appendChild(rTitle);
    g.appendChild(rect);

    // Value at the bar end.
    g.appendChild(
      svgText(doc, String(e.value), {
        x: x0 + barW + 4,
        y: cy + 3,
        "text-anchor": "start",
        "font-size": 10,
        fill: theme.muted,
      }),
    );

    // Interaction: hover dims siblings + shows tooltip; optional click.
    const onEnter = (ev: Event) => {
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
      tooltip.show(
        [
          { text: full, variant: "strong" },
          { text: `${e.value} item${e.value === 1 ? "" : "s"}` },
        ],
        xy.x,
        xy.y,
      );
    };
    const onMove = (ev: Event) => {
      const pe = ev as PointerEvent;
      const xy = opts.toHostXY
        ? opts.toHostXY(pe.clientX, pe.clientY)
        : { x: pe.clientX, y: pe.clientY };
      tooltip.show(
        [
          { text: full, variant: "strong" },
          { text: `${e.value} item${e.value === 1 ? "" : "s"}` },
        ],
        xy.x,
        xy.y,
      );
    };
    const onLeave = () => {
      for (const sib of g.querySelectorAll(".bm-bar")) {
        (sib as SVGElement).setAttribute("opacity", "1");
      }
      tooltip.hide();
    };
    rect.addEventListener("pointerenter", onEnter);
    rect.addEventListener("pointermove", onMove);
    rect.addEventListener("pointerleave", onLeave);

    if (opts.onBarClick) {
      rect.style.cursor = "pointer";
      labelEl.style.cursor = "pointer";
      const click = () => opts.onBarClick!(e);
      rect.addEventListener("click", click);
      labelEl.addEventListener("click", click);
    }
  });
}
