/**
 * chartkit/svg.ts - dependency-free SVG element helpers.
 *
 * CRITICAL: every SVG node MUST be created with createElementNS in the SVG
 * namespace, never doc.createElement, or it will not render inside Zotero's
 * XHTML documents. svgEl() is the single factory all chart code uses.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Attribute values we accept; numbers are coerced to strings. */
export type AttrValue = string | number | null | undefined;

/**
 * Create an SVG element of `tag`, apply `attrs` (skipping null/undefined), and
 * optionally set textContent. Children are appended in order.
 */
export function svgEl(
  doc: Document,
  tag: string,
  attrs?: Record<string, AttrValue>,
  children?: (SVGElement | null)[],
): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag) as unknown as SVGElement;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined) continue;
      el.setAttribute(k, String(v));
    }
  }
  if (children) {
    for (const c of children) {
      if (c) el.appendChild(c);
    }
  }
  return el;
}

/** Convenience: set textContent on an SVG element (user data -> textContent). */
export function svgText(
  doc: Document,
  text: string,
  attrs?: Record<string, AttrValue>,
): SVGElement {
  const el = svgEl(doc, "text", attrs);
  el.textContent = text;
  return el;
}

/**
 * Create the root <svg> filling its container. The viewBox matches the pixel
 * box so geometry math stays in CSS pixels; preserveAspectRatio is disabled so
 * onResize can re-lay-out instead of stretching a fixed drawing.
 */
export function createPlot(
  doc: Document,
  width: number,
  height: number,
): SVGSVGElement {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const svg = svgEl(doc, "svg", {
    xmlns: SVG_NS,
    width: "100%",
    height: "100%",
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: "xMinYMin meet",
  }) as SVGSVGElement;
  svg.style.display = "block";
  return svg;
}

/** Remove every child of an SVG element (used by onResize/onThemeChange). */
export function clearSvg(el: SVGElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * SVG path "d" for an annular sector (donut slice) centred at (cx, cy).
 * Angles are in radians, clockwise, starting at 12 o'clock (-PI/2 offset is
 * applied by the caller). innerR may be 0 for a full pie wedge. Guards against
 * a full 360 sweep (which an arc cannot express) by clamping just under 2*PI.
 */
export function arcPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngle: number,
  endAngle: number,
): string {
  let a0 = startAngle;
  let a1 = endAngle;
  const full = Math.PI * 2;
  if (a1 - a0 >= full) a1 = a0 + full - 1e-4;
  if (!isFinite(a0) || !isFinite(a1) || outerR <= 0) return "";
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const ox0 = cx + outerR * Math.cos(a0);
  const oy0 = cy + outerR * Math.sin(a0);
  const ox1 = cx + outerR * Math.cos(a1);
  const oy1 = cy + outerR * Math.sin(a1);
  if (innerR <= 0) {
    // Pie wedge: outer arc back to centre.
    return (
      `M ${cx} ${cy} L ${ox0} ${oy0} ` +
      `A ${outerR} ${outerR} 0 ${large} 1 ${ox1} ${oy1} Z`
    );
  }
  const ix1 = cx + innerR * Math.cos(a1);
  const iy1 = cy + innerR * Math.sin(a1);
  const ix0 = cx + innerR * Math.cos(a0);
  const iy0 = cy + innerR * Math.sin(a0);
  return (
    `M ${ox0} ${oy0} ` +
    `A ${outerR} ${outerR} 0 ${large} 1 ${ox1} ${oy1} ` +
    `L ${ix1} ${iy1} ` +
    `A ${innerR} ${innerR} 0 ${large} 0 ${ix0} ${iy0} Z`
  );
}
