/**
 * chartkit/exporter.ts - SVG serialization + SVG->PNG rasterization.
 *
 * Charts set their colours as concrete attribute values pulled from ThemeInfo
 * (never CSS vars), so serialization is mostly: clone, guarantee xmlns/viewBox,
 * prepend an opaque background rect (so transparent areas are not black in the
 * PNG and the SVG opens cleanly outside Zotero), and emit a standalone string.
 */

import { SVG_NS } from "./svg";
import type { ThemeInfo } from "../../types";

/**
 * Clone `svg`, inline the theme background as a full-bleed rect, ensure the
 * standalone attributes are present, and return XML text. Width/height are read
 * from the live element (clientWidth) or the viewBox as a fallback.
 */
export function serializeSVG(svg: SVGSVGElement, theme: ThemeInfo): string {
  const doc = svg.ownerDocument as Document;
  const { w, h } = svgPixelSize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  // Opaque background as the first child so it sits behind everything.
  const bg = doc.createElementNS(SVG_NS, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(w));
  bg.setAttribute("height", String(h));
  bg.setAttribute("fill", theme.bg);
  clone.insertBefore(bg, clone.firstChild);

  const serializer = new (doc.defaultView as any).XMLSerializer();
  const body = serializer.serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${body}`;
}

/** Determine the chart's pixel size from the element or its viewBox. */
function svgPixelSize(svg: SVGSVGElement): { w: number; h: number } {
  let w = svg.clientWidth || 0;
  let h = svg.clientHeight || 0;
  if ((!w || !h) && svg.getAttribute("viewBox")) {
    const parts = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
    if (parts.length === 4) {
      w = w || parts[2];
      h = h || parts[3];
    }
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/**
 * Rasterize a serialized SVG string to a PNG Blob via an offscreen canvas at
 * `scale` device pixels. Fills the theme background first so transparency does
 * not become black. The object URL is always revoked in finally.
 */
export function svgToPng(
  doc: Document,
  svgString: string,
  width: number,
  height: number,
  scale = 2,
  bg?: string,
): Promise<Blob> {
  const win = doc.defaultView as any;
  return new Promise<Blob>((resolve, reject) => {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = (win.URL || win.webkitURL).createObjectURL(blob);
    const img = new win.Image();
    let settled = false;
    const cleanup = () => {
      try {
        (win.URL || win.webkitURL).revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
    img.onload = () => {
      try {
        const canvas = doc.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const cx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
        if (!cx) {
          reject(new Error("2D canvas context unavailable"));
          return;
        }
        if (bg) {
          cx.fillStyle = bg;
          cx.fillRect(0, 0, canvas.width, canvas.height);
        }
        cx.setTransform(scale, 0, 0, scale, 0, 0);
        cx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((out: Blob | null) => {
          settled = true;
          if (out) resolve(out);
          else reject(new Error("canvas.toBlob returned null"));
        }, "image/png");
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        cleanup();
      }
    };
    img.onerror = () => {
      if (!settled) reject(new Error("SVG image failed to load for PNG export"));
      cleanup();
    };
    img.src = url;
  });
}
