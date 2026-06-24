/**
 * chartkit/axis.ts - axis + gridline rendering for cartesian charts.
 *
 * Produces a single <g> group of ticks, labels and (optionally) gridlines using
 * theme tokens for colour. Pure-ish: only touches the SVG nodes it creates.
 */

import type { ThemeInfo } from "../../types";
import { svgEl, svgText } from "./svg";
import type { LinearScale, BandScale } from "./scale";

export interface PlotArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Render a value (Y) axis with nice ticks, labels and horizontal gridlines.
 * `scale` maps value -> pixel Y. `ticks` are value positions (see niceTicks).
 */
export function renderValueAxis(
  doc: Document,
  area: PlotArea,
  scale: LinearScale,
  ticks: number[],
  theme: ThemeInfo,
  opts?: { grid?: boolean; format?: (v: number) => string },
): SVGGElement {
  const g = svgEl(doc, "g", { class: "bm-axis bm-axis-y" }) as SVGGElement;
  const grid = opts?.grid !== false;
  const fmt = opts?.format ?? ((v: number) => String(v));
  const x0 = area.left;
  const x1 = area.left + area.width;
  for (const t of ticks) {
    const y = scale(t);
    if (grid) {
      g.appendChild(
        svgEl(doc, "line", {
          x1: x0,
          y1: y,
          x2: x1,
          y2: y,
          stroke: theme.grid,
          "stroke-width": 1,
          "shape-rendering": "crispEdges",
        }),
      );
    }
    g.appendChild(
      svgText(doc, fmt(t), {
        x: x0 - 6,
        y: y + 3,
        "text-anchor": "end",
        "font-size": 10,
        fill: theme.muted,
      }),
    );
  }
  // Axis baseline.
  g.appendChild(
    svgEl(doc, "line", {
      x1: x0,
      y1: area.top,
      x2: x0,
      y2: area.top + area.height,
      stroke: theme.muted,
      "stroke-width": 1,
    }),
  );
  return g;
}

/**
 * Render a categorical (X) axis: one label per band, centred under the band.
 * When `rotate` is set, labels are rotated (-40deg) and anchored at the end so
 * dense year axes stay legible.
 */
export function renderBandAxis(
  doc: Document,
  area: PlotArea,
  scale: BandScale,
  labelFor: (key: string) => string,
  theme: ThemeInfo,
  opts?: { rotate?: boolean; everyNth?: number },
): SVGGElement {
  const g = svgEl(doc, "g", { class: "bm-axis bm-axis-x" }) as SVGGElement;
  const yBase = area.top + area.height;
  const rotate = opts?.rotate === true;
  const everyNth = Math.max(1, opts?.everyNth ?? 1);
  // Baseline.
  g.appendChild(
    svgEl(doc, "line", {
      x1: area.left,
      y1: yBase,
      x2: area.left + area.width,
      y2: yBase,
      stroke: theme.muted,
      "stroke-width": 1,
    }),
  );
  scale.keys.forEach((key, i) => {
    if (i % everyNth !== 0) return;
    const band = scale(key);
    if (!band) return;
    const label = labelFor(key);
    if (rotate) {
      const tx = band.center;
      const ty = yBase + 8;
      g.appendChild(
        svgText(doc, label, {
          x: tx,
          y: ty,
          "text-anchor": "end",
          "font-size": 10,
          fill: theme.muted,
          transform: `rotate(-40 ${tx} ${ty})`,
        }),
      );
    } else {
      g.appendChild(
        svgText(doc, label, {
          x: band.center,
          y: yBase + 13,
          "text-anchor": "middle",
          "font-size": 10,
          fill: theme.muted,
        }),
      );
    }
  });
  return g;
}
