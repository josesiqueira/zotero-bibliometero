/**
 * save.ts - export download for Insights views.
 *
 * Given an ExportResult (PNG bytes as a Blob, or SVG markup as text), shows
 * Zotero's native save dialog and writes the file the user chooses.
 *
 * IMPORTANT (Zotero 9 / Firefox 140): the file dialog MUST go through Zotero's
 * own wrapped FilePicker module:
 *   ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs")
 * Raw `nsIFilePicker` no longer works the old way (its `init` now needs a
 * BrowsingContext, not a window, and `show()` is async via `open(callback)`).
 * The wrapper handles both: `init(win, title, mode)` uses `win.browsingContext`
 * internally and `show()` returns a Promise. `fp.file` is the chosen path string.
 */

import type { ExportResult } from "./types";

function extFor(result: ExportResult): string {
  return result.format === "png" ? "png" : "svg";
}

function suggestedFileName(result: ExportResult): string {
  const base = result.suggestedName || "bibliometero-export";
  return `${base}.${extFor(result)}`;
}

/** Bytes to write: PNG -> Uint8Array from the blob; SVG -> the markup string. */
async function payload(result: ExportResult): Promise<Uint8Array | string> {
  if (result.format === "png") {
    if (!result.blob) throw new Error("PNG export missing blob");
    return new Uint8Array(await result.blob.arrayBuffer());
  }
  if (typeof result.text !== "string") {
    throw new Error("SVG export missing text");
  }
  return result.text;
}

/**
 * Show the native save dialog via Zotero's FilePicker module.
 * Returns the chosen path, `null` if the user cancelled, or `undefined` if the
 * picker module could not be loaded (so the caller can fall back).
 */
async function pickPath(
  win: _ZoteroTypes.MainWindow,
  result: ExportResult,
): Promise<string | null | undefined> {
  const CU: any =
    (globalThis as any).ChromeUtils ?? (win as any).ChromeUtils ?? null;
  let FilePicker: any;
  try {
    ({ FilePicker } = CU.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    ));
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] FilePicker module unavailable", e);
    return undefined;
  }

  try {
    const fp = new FilePicker();
    const ext = extFor(result);
    const title =
      result.format === "png" ? "Export chart as PNG" : "Export chart as SVG";
    fp.init(win, title, fp.modeSave);
    fp.appendFilter(`${ext.toUpperCase()} file`, `*.${ext}`);
    fp.appendFilters(fp.filterAll);
    fp.defaultString = suggestedFileName(result);
    fp.defaultExtension = ext;
    const rv = await fp.show();
    if (rv === fp.returnCancel) return null;
    return (fp.file as string) || null;
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] file picker failed", e);
    return undefined;
  }
}

/** Brief success toast so the export is not silent. */
function notifySaved(path: string): void {
  try {
    new ztoolkit.ProgressWindow("Bibliometero", { closeTime: 4000 })
      .createLine({ text: `Saved ${path}`, type: "success" })
      .show();
  } catch {
    /* toast is best-effort */
  }
}

/** Write `result` to disk via the native save dialog. */
export async function saveExport(
  win: _ZoteroTypes.MainWindow,
  result: ExportResult,
): Promise<void> {
  let data: Uint8Array | string;
  try {
    data = await payload(result);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] export payload error", e);
    return;
  }

  let path = await pickPath(win, result);
  if (path === null) return; // user cancelled: write nothing

  if (path === undefined) {
    // Picker genuinely unavailable: write into the data dir so the export is
    // not lost, and tell the user where it went.
    const dir = (Zotero as any).DataDirectory?.dir;
    if (!dir) {
      ztoolkit.log("[Bibliometero Insights] no writable directory for export");
      return;
    }
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    path = `${dir}${sep}${suggestedFileName(result)}`;
  }

  try {
    await Zotero.File.putContentsAsync(path, data as any);
    ztoolkit.log("[Bibliometero Insights] export written:", path);
    notifySaved(path);
  } catch (e) {
    ztoolkit.log("[Bibliometero Insights] saveExport write failed", e);
  }
}
