/**
 * save.ts - export download for Insights views.
 *
 * Given an ExportResult (PNG bytes as a Blob, or SVG markup as text), prompts
 * the user with a native file picker seeded with a sensible filename, then
 * writes the bytes via Zotero.File.putContentsAsync. If the picker API is
 * unavailable (or the user is on a build where it shifted), it falls back to
 * writing into the Zotero data directory and logs the path.
 */

import type { ExportResult } from "./types";

function extFor(result: ExportResult): string {
  return result.format === "png" ? "png" : "svg";
}

function suggestedFileName(result: ExportResult): string {
  const base = result.suggestedName || "bibliometero-export";
  return `${base}.${extFor(result)}`;
}

/** Bytes to write: PNG -> ArrayBuffer from blob; SVG -> string. */
async function payload(result: ExportResult): Promise<ArrayBuffer | string> {
  if (result.format === "png") {
    if (!result.blob) throw new Error("PNG export missing blob");
    return await result.blob.arrayBuffer();
  }
  if (typeof result.text !== "string") {
    throw new Error("SVG export missing text");
  }
  return result.text;
}

/** Resolve a FilePicker constructor across the APIs Zotero exposes. */
function getFilePicker(win: _ZoteroTypes.MainWindow): any | null {
  // Preferred: Zotero's wrapped FilePicker helper.
  try {
    const ZFP = (Zotero as any).FilePicker;
    if (ZFP) return new ZFP();
  } catch {
    /* fall through */
  }
  // Fallback: raw XPCOM nsIFilePicker.
  try {
    const C = (win as any).Components || (globalThis as any).Components;
    if (C?.classes && C?.interfaces) {
      const fp = C.classes["@mozilla.org/filepicker;1"].createInstance(
        C.interfaces.nsIFilePicker,
      );
      return fp;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function pickPath(
  win: _ZoteroTypes.MainWindow,
  result: ExportResult,
): Promise<string | null> {
  const fp = getFilePicker(win);
  if (!fp) return null;

  const ext = extFor(result);
  const title = result.format === "png" ? "Export PNG" : "Export SVG";
  try {
    const C = (win as any).Components || (globalThis as any).Components;
    const modeSave = C?.interfaces?.nsIFilePicker?.modeSave ?? 1;
    const returnCancel = C?.interfaces?.nsIFilePicker?.returnCancel ?? 1;

    // Zotero's FilePicker.init takes (window, title, mode); raw nsIFilePicker
    // uses a docShell-bound window. Both accept the same shape here.
    fp.init(win, title, modeSave);
    fp.appendFilter(
      `${ext.toUpperCase()} image`,
      `*.${ext}`,
    );
    fp.defaultString = suggestedFileName(result);
    fp.defaultExtension = ext;

    // Zotero.FilePicker.show() returns a Promise; nsIFilePicker.show() is sync.
    const rv = await fp.show();
    if (rv === returnCancel) return null;
    // Zotero.FilePicker exposes `.file` (path string); nsIFilePicker `.file.path`.
    const file = fp.file;
    if (!file) return null;
    return typeof file === "string" ? file : file.path;
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] file picker failed", e);
    return null;
  }
}

/** Write `result` to disk via a picker, or fall back to the data directory. */
export async function saveExport(
  win: _ZoteroTypes.MainWindow,
  result: ExportResult,
): Promise<void> {
  let data: ArrayBuffer | string;
  try {
    data = await payload(result);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] export payload error", e);
    return;
  }

  try {
    let path = await pickPath(win, result);
    if (!path) {
      // Fallback: write into the Zotero data dir so the export is never lost.
      const dir = Zotero.DataDirectory?.dir || (Zotero as any).getZoteroDirectory?.()?.path;
      if (!dir) {
        ztoolkit.log("[Bibliometero Insights] no writable directory for export");
        return;
      }
      const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
      path = `${dir}${sep}${suggestedFileName(result)}`;
      ztoolkit.log(
        "[Bibliometero Insights] picker unavailable, writing to data dir:",
        path,
      );
    }

    // putContentsAsync accepts a string or a typed-array/ArrayBuffer.
    const toWrite =
      typeof data === "string" ? data : new Uint8Array(data);
    await Zotero.File.putContentsAsync(path, toWrite as any);
    ztoolkit.log("[Bibliometero Insights] export written:", path);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] saveExport failed", e);
  }
}
