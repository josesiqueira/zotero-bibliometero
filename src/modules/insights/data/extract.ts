/**
 * insights/data/extract.ts — Zotero.Item -> plain records.
 *
 * This is the ONLY data-layer file that touches Zotero item APIs heavily. It
 * turns each regular item into a flat, serialisable `ItemRecord` so that the
 * pure aggregation in aggregate.ts can run with no Zotero binary at all.
 *
 * Every Zotero call is wrapped in try/catch: the data layer must never throw
 * because a single item is malformed, mid-edit, or partially loaded.
 *
 * Clean-room original implementation. The creator-normalization heuristic and
 * the scope-gathering logic mirror the existing graph code by design (so all
 * views agree), but no code is copied verbatim.
 */

import type { VizScope } from "../types";

/**
 * Flat record for one regular Zotero item. Everything aggregate.ts needs lives
 * here so that file can stay free of Zotero imports.
 */
export interface ItemRecord {
  id: number;
  title: string;
  itemType: string;
  /**
   * Creators as returned by getCreatorsJSON(): single-field / institutional
   * creators carry `name` (fieldMode === 1) instead of first/last.
   */
  creators: Array<{ firstName?: string; lastName?: string; name?: string }>;
  /** Four-digit publication year, or null when unparseable / missing. */
  year: number | null;
  /** Container title for this item type (journal, proceedings, ...) or "". */
  source: string;
  /** Collection ids this item belongs to (may be empty). */
  collections: number[];
}

/**
 * Per-item-type source-field priority. The first non-empty field wins. Fields
 * are read with includeBaseMapped so base-mapped types resolve correctly.
 */
const SOURCE_FIELDS: Record<string, string[]> = {
  journalArticle: ["publicationTitle"],
  conferencePaper: ["proceedingsTitle", "conferenceName", "publicationTitle"],
  bookSection: ["bookTitle", "publicationTitle"],
  book: ["publisher", "series"],
  report: ["institution", "publisher"],
  thesis: ["university", "publisher"],
  preprint: ["repository", "publicationTitle"],
  webpage: ["websiteTitle", "publicationTitle", "blogTitle"],
  blogPost: ["websiteTitle", "publicationTitle", "blogTitle"],
};

const DEFAULT_SOURCE_FIELDS = ["publicationTitle", "publisher"];

/** Lowest / highest plausible publication years used when clamping. */
const MIN_YEAR = 1500;
const MAX_YEAR = 2199;

/**
 * Read a safe display title for an item, falling back through several APIs and
 * finally to a bracketed key so the field is never empty.
 */
function safeTitle(item: Zotero.Item): string {
  try {
    const t = (item as any).getDisplayTitle?.();
    if (t) return String(t);
  } catch {
    /* ignore */
  }
  try {
    const f = item.getField?.("title");
    if (f) return String(f);
  } catch {
    /* ignore */
  }
  try {
    return `[${item.key}]`;
  } catch {
    /* ignore */
  }
  return "[item]";
}

/**
 * Extract a four-digit publication year from an item's date field.
 *
 * Prefers the unformatted (ISO-ish) date so we read a stable "YYYY-MM-DD"-style
 * string rather than a localized rendering. Tries a leading four-digit year
 * first, then any plausible 1500..2199 run anywhere in the string. Returns null
 * when nothing plausible is found.
 */
export function parseYear(item: Zotero.Item): number | null {
  let raw = "";
  try {
    const iso = item.getField?.("date", true);
    if (iso) raw = String(iso);
  } catch {
    /* ignore */
  }
  if (!raw) {
    try {
      const formatted = item.getField?.("date");
      if (formatted) raw = String(formatted);
    } catch {
      /* ignore */
    }
  }
  return parseYearFromString(raw);
}

/**
 * Pure year extraction from a date string. Exported so unit tests can exercise
 * it without a Zotero item.
 */
export function parseYearFromString(raw: string): number | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Leading four-digit year (covers "YYYY", "YYYY-MM-DD", "YYYY/MM").
  const lead = /^(\d{4})/.exec(text);
  if (lead) {
    const y = clampYear(Number(lead[1]));
    if (y !== null) return y;
  }

  // Otherwise the first plausible four-digit run anywhere in the string.
  const re = /(\d{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const y = clampYear(Number(m[1]));
    if (y !== null) return y;
  }
  return null;
}

function clampYear(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < MIN_YEAR || n > MAX_YEAR) return null;
  return n;
}

/**
 * Pick the best "source" (container title) for an item based on its type.
 * Returns the first non-empty trimmed field per the type's priority list, or ""
 * when none is populated.
 */
export function extractSource(item: Zotero.Item): string {
  let itemType = "";
  try {
    itemType = item.itemType || "";
  } catch {
    itemType = "";
  }
  const fields = SOURCE_FIELDS[itemType] || DEFAULT_SOURCE_FIELDS;
  for (const field of fields) {
    let val = "";
    try {
      // getField(field, unformatted=false, includeBaseMapped=true)
      const raw = item.getField?.(field, false, true);
      if (raw) val = String(raw).trim();
    } catch {
      val = "";
    }
    if (val) return val;
  }
  return "";
}

/**
 * Read this item's creators as plain objects via getCreatorsJSON(). Unlike
 * getCreators(), the JSON form sets `name` for single-field / institutional
 * creators (fieldMode === 1), which the normalization in aggregate.ts relies on.
 */
function extractCreators(
  item: Zotero.Item,
): Array<{ firstName?: string; lastName?: string; name?: string }> {
  let json: any[] = [];
  try {
    json = (item as any).getCreatorsJSON?.() || [];
  } catch {
    json = [];
  }
  const out: Array<{ firstName?: string; lastName?: string; name?: string }> =
    [];
  for (const c of json) {
    if (!c) continue;
    const rec: { firstName?: string; lastName?: string; name?: string } = {};
    if (typeof c.firstName === "string" && c.firstName) rec.firstName = c.firstName;
    if (typeof c.lastName === "string" && c.lastName) rec.lastName = c.lastName;
    if (typeof c.name === "string" && c.name) rec.name = c.name;
    // Skip wholly empty creators (no usable name component).
    if (!rec.firstName && !rec.lastName && !rec.name) continue;
    out.push(rec);
  }
  return out;
}

/** Read the collection ids this item belongs to (empty on failure). */
function extractCollections(item: Zotero.Item): number[] {
  try {
    const cols = (item as any).getCollections?.();
    if (Array.isArray(cols)) {
      return cols.map((c) => Number(c)).filter((n) => Number.isFinite(n));
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Convert a single Zotero item into a flat ItemRecord. Defensive throughout: a
 * bad item yields a record with safe defaults rather than throwing.
 */
export function toRecord(item: Zotero.Item): ItemRecord {
  let id = 0;
  try {
    id = Number(item.id) || 0;
  } catch {
    id = 0;
  }
  let itemType = "document";
  try {
    if (item.itemType) itemType = item.itemType;
  } catch {
    itemType = "document";
  }
  return {
    id,
    title: safeTitle(item),
    itemType,
    creators: extractCreators(item),
    year: parseYear(item),
    source: extractSource(item),
    collections: extractCollections(item),
  };
}

/**
 * True when an item is a regular (top-level) item and not a feed item. Mirrors
 * the filter used by the graph collector so the two stay consistent.
 */
function isUsableItem(it: any): boolean {
  try {
    if (!it || typeof it.isRegularItem !== "function") return false;
    if (!it.isRegularItem()) return false;
    if (typeof it.isFeedItem === "function" && it.isFeedItem()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather the regular items for a scope from the active window, reusing the same
 * scope semantics as the graph view:
 *  - "library":   every item in the selected library (getAll(libID, true)).
 *  - "view":      the current collection / saved search rows, with a fallback
 *                 to whatever the items view currently holds.
 *  - "selection": the items currently selected in the pane.
 *
 * Returns the filtered items plus the resolved libraryID (used by callers as a
 * cache key). Every Zotero call is wrapped so a transient failure yields [].
 */
export async function gatherItems(
  scope: VizScope,
  win: any,
): Promise<{ items: Zotero.Item[]; libraryID: number }> {
  const ZoteroPane = win?.ZoteroPane;

  let libraryID = 0;
  try {
    libraryID =
      ZoteroPane?.getSelectedLibraryID?.() ??
      Zotero.Libraries.userLibraryID ??
      0;
  } catch {
    try {
      libraryID = Zotero.Libraries.userLibraryID ?? 0;
    } catch {
      libraryID = 0;
    }
  }

  let raw: Zotero.Item[] = [];

  if (scope === "library") {
    try {
      const all = await Zotero.Items.getAll(libraryID, true);
      raw = (all as Zotero.Item[]) || [];
    } catch {
      raw = [];
    }
  } else if (scope === "selection") {
    try {
      raw = (ZoteroPane?.getSelectedItems?.() as Zotero.Item[]) || [];
    } catch {
      raw = [];
    }
  } else {
    // scope === "view": current collection / saved search.
    let got = false;
    try {
      const row = ZoteroPane?.getCollectionTreeRow?.();
      if (row && typeof row.getItems === "function") {
        const items = await row.getItems();
        raw = (items as Zotero.Item[]) || [];
        got = true;
      }
    } catch {
      got = false;
    }
    if (!got) {
      try {
        const itemsView = ZoteroPane?.itemsView;
        if (itemsView && typeof itemsView.getSortedItems === "function") {
          const items = itemsView.getSortedItems();
          raw = (items as Zotero.Item[]) || [];
        }
      } catch {
        raw = [];
      }
    }
  }

  const items = (raw || []).filter(isUsableItem);
  return { items, libraryID };
}
