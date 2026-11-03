/**
 * chartkit/figure.ts - export a view as a figure for a paper or a slide.
 *
 * Exports never copy the on-screen panel (its size depends on the dock and its
 * colours on the Zotero theme). Instead the view draws itself again into a
 * fixed-size figure on a light background, with a title above and a caption
 * below naming what the data is, so the image stands on its own.
 */

import type { ExportResult, ThemeInfo } from "../../types";
import { paletteFor } from "../../theme";
import { SVG_NS, svgEl, svgText } from "./svg";
import { svgToPng } from "./exporter";

/** Logical figure size; PNG is rendered at 2x (2400 x 1440 px). */
export const FIGURE_W = 1200;
export const FIGURE_H = 720;
const PNG_SCALE = 2;

export const FONT_FAMILY =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Draws a view's content into `root`, inside a `w` x `h` box, in `theme`. */
export type FigureDraw = (
  root: SVGElement,
  w: number,
  h: number,
  theme: ThemeInfo,
) => void;

export interface FigureText {
  /** e.g. "Publications per year". */
  title: string;
  /** e.g. "My Library, whole library, 484 items. 3 November 2026." */
  caption: string;
  /** File name without extension, e.g. "bibliometero-pubs-per-year". */
  name: string;
}

/** Build the standalone figure SVG (light theme, title, caption). */
export function buildFigure(
  doc: Document,
  text: FigureText,
  draw: FigureDraw,
): SVGSVGElement {
  const theme = exportTheme();
  const svg = svgEl(doc, "svg", {
    xmlns: SVG_NS,
    width: FIGURE_W,
    height: FIGURE_H,
    viewBox: `0 0 ${FIGURE_W} ${FIGURE_H}`,
    "font-family": FONT_FAMILY,
  }) as SVGSVGElement;
  svg.appendChild(
    svgEl(doc, "rect", {
      x: 0,
      y: 0,
      width: FIGURE_W,
      height: FIGURE_H,
      fill: theme.bg,
    }),
  );
  svg.appendChild(
    svgText(doc, text.title, {
      x: 32,
      y: 44,
      "font-size": 22,
      "font-weight": 600,
      fill: theme.fg,
    }),
  );
  svg.appendChild(
    svgText(doc, text.caption, {
      x: 32,
      y: FIGURE_H - 22,
      "font-size": 13,
      fill: theme.muted,
    }),
  );
  const top = 68;
  const bottom = 48;
  const content = svgEl(doc, "g", { transform: `translate(24, ${top})` });
  svg.appendChild(content);
  draw(content, FIGURE_W - 48, FIGURE_H - top - bottom, theme);
  return svg;
}

/** Light palette with a pure white ground, so figures sit cleanly on a page. */
export function exportTheme(): ThemeInfo {
  return { ...paletteFor("light"), bg: "#ffffff" };
}

/** Serialize and, for PNG, rasterize a figure. */
export async function exportFigure(
  doc: Document,
  fmt: "svg" | "png",
  text: FigureText,
  draw: FigureDraw,
): Promise<ExportResult> {
  const svg = buildFigure(doc, text, draw);
  const serializer = new (doc.defaultView as any).XMLSerializer();
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
    serializer.serializeToString(svg);
  const name = `${text.name}-${isoDate()}`;
  if (fmt === "svg") return { text: xml, suggestedName: name, format: "svg" };
  const blob = await svgToPng(
    doc,
    xml,
    FIGURE_W,
    FIGURE_H,
    PNG_SCALE,
    "#ffffff",
  );
  return { blob, suggestedName: name, format: "png" };
}

/** Today's date as YYYY-MM-DD, for file names. */
export function isoDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today's date in words ("3 November 2026"), for captions. */
export function longDate(d = new Date()): string {
  try {
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return isoDate(d);
  }
}
