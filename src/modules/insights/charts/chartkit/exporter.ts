/**
 * chartkit/exporter.ts - SVG -> PNG rasterization for exported figures
 * (see figure.ts, which builds and serializes the SVG).
 */

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
      if (!settled)
        reject(new Error("SVG image failed to load for PNG export"));
      cleanup();
    };
    img.src = url;
  });
}
