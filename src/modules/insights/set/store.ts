/**
 * insights/set/store.ts — the curated-set STORE (pref-backed singleton).
 *
 * Implements `InsightsSetStore` (the FROZEN CONTRACT in ./types.ts). The
 * "Insights set" is a plugin-private, per-library list of item ids. Nothing is
 * written to the user's items (no tags); the only persistence is the plugin
 * pref `insights.set`, a JSON string of `{ [libraryID: number]: number[] }`.
 *
 * Design:
 *  - In-memory cache: `Map<number, Set<number>>` loaded lazily from the pref.
 *  - Writes are debounced (~250ms) but a synchronous flush guarantees a reopen
 *    sees the latest state.
 *  - One Zotero.Notifier observer (on ["item"]) prunes deleted/trashed items so
 *    they leave the set automatically. Registration is idempotent.
 *
 * Dependency-free, defensive: every Zotero / JSON / pref touch is guarded.
 */

import type { InsightsSetStore } from "./types";
import { getPrefRaw, setPrefRaw } from "../../../utils/prefs";

const PREF_KEY = "insights.set";
const WRITE_DEBOUNCE_MS = 250;
const PRUNE_DEBOUNCE_MS = 250;

/** Lazily-loaded per-library membership. `null` until first load. */
let cache: Map<number, Set<number>> | null = null;

/** Change subscribers. Called (best-effort) on any membership change. */
const subscribers = new Set<() => void>();

/** Debounced-write handle and the notifier-prune handle. */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** The registered Zotero.Notifier id (null when not registered). */
let notifierID: string | null = null;

// ---- persistence ----------------------------------------------------------

/** Parse the pref JSON defensively into the cache shape. Corrupt -> empty. */
function parsePref(raw: unknown): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  if (typeof raw !== "string" || raw.length === 0) return map;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return map;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const libraryID = Number(key);
    if (!Number.isFinite(libraryID)) continue;
    const value = (obj as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    const set = new Set<number>();
    for (const raw2 of value) {
      const id = Number(raw2);
      if (Number.isFinite(id)) set.add(id);
    }
    map.set(libraryID, set);
  }
  return map;
}

/** Load the cache from the pref the first time it is needed. */
function ensureCache(): Map<number, Set<number>> {
  if (cache) return cache;
  // Registering on first use keeps the orchestrator from having to call init().
  init();
  let raw: unknown;
  try {
    raw = getPrefRaw(PREF_KEY);
  } catch {
    raw = undefined;
  }
  cache = parsePref(raw);
  return cache;
}

/** Serialize the cache to the `{ [libraryID]: number[] }` JSON shape. */
function serialize(map: Map<number, Set<number>>): string {
  const obj: Record<string, number[]> = {};
  for (const [libraryID, set] of map) {
    // Skip empty libraries so the stored JSON stays compact.
    if (set.size === 0) continue;
    obj[String(libraryID)] = Array.from(set);
  }
  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

/** Write the cache to the pref now (synchronous). Cancels any pending write. */
function flush(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cache) return;
  try {
    setPrefRaw(PREF_KEY, serialize(cache));
  } catch {
    /* ignore: persistence is best-effort */
  }
}

/** Persist (debounced) so bursts of edits coalesce into one write. */
function persist(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, WRITE_DEBOUNCE_MS);
}

/** Notify all subscribers (each guarded so one throw cannot block the rest). */
function notify(): void {
  for (const cb of Array.from(subscribers)) {
    try {
      cb();
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/** Persist (debounced) and notify after a membership change. */
function changed(): void {
  persist();
  notify();
}

/** The Set for a library, creating an empty one in the cache if needed. */
function setFor(libraryID: number): Set<number> {
  const map = ensureCache();
  let set = map.get(libraryID);
  if (!set) {
    set = new Set<number>();
    map.set(libraryID, set);
  }
  return set;
}

// ---- notifier (auto-prune) ------------------------------------------------

/**
 * Idempotent observer registration. Safe to call repeatedly and from first
 * use; guarded by `addon?.data.alive` so it is a no-op during teardown.
 */
export function init(): void {
  if (notifierID) return;
  try {
    if (!(addon as any)?.data?.alive) return;
  } catch {
    return;
  }
  try {
    const callback = {
      notify: (event: string, type: string) => {
        if (type !== "item") return;
        if (event === "delete" || event === "trash") schedulePrune();
      },
    };
    notifierID = Zotero.Notifier.registerObserver(
      callback as any,
      ["item"],
      "bibliometero-insights-set",
    );
  } catch {
    notifierID = null;
  }
}

/** Drop the observer (orchestrator teardown). Flushes any pending write. */
export function unregister(): void {
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch {
      /* ignore */
    }
    notifierID = null;
  }
  if (pruneTimer) {
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }
  flush();
}

/** Debounce prune across a burst of delete/trash events. */
function schedulePrune(): void {
  if (pruneTimer) clearTimeout(pruneTimer);
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    insightsSet.prune();
  }, PRUNE_DEBOUNCE_MS);
}

// ---- the singleton --------------------------------------------------------

export const insightsSet: InsightsSetStore = {
  has(libraryID: number, itemID: number): boolean {
    const set = ensureCache().get(libraryID);
    return set ? set.has(itemID) : false;
  },

  count(libraryID: number): number {
    const set = ensureCache().get(libraryID);
    return set ? set.size : 0;
  },

  list(libraryID: number): number[] {
    const set = ensureCache().get(libraryID);
    return set ? Array.from(set) : [];
  },

  add(libraryID: number, itemIDs: number[]): void {
    if (!itemIDs || itemIDs.length === 0) return;
    const set = setFor(libraryID);
    let mutated = false;
    for (const id of itemIDs) {
      if (!Number.isFinite(id) || set.has(id)) continue;
      set.add(id);
      mutated = true;
    }
    if (mutated) changed();
  },

  remove(libraryID: number, itemIDs: number[]): void {
    if (!itemIDs || itemIDs.length === 0) return;
    const set = ensureCache().get(libraryID);
    if (!set) return;
    let mutated = false;
    for (const id of itemIDs) {
      if (set.delete(id)) mutated = true;
    }
    if (mutated) changed();
  },

  toggle(libraryID: number, itemIDs: number[]): "added" | "removed" {
    const ids = (itemIDs || []).filter((id) => Number.isFinite(id));
    const set = setFor(libraryID);
    // If ANY id is missing, add all (so a mixed selection adds); else remove all.
    const anyMissing = ids.length === 0 || ids.some((id) => !set.has(id));
    if (anyMissing) {
      let mutated = false;
      for (const id of ids) {
        if (!set.has(id)) {
          set.add(id);
          mutated = true;
        }
      }
      if (mutated) changed();
      return "added";
    }
    let mutated = false;
    for (const id of ids) {
      if (set.delete(id)) mutated = true;
    }
    if (mutated) changed();
    return "removed";
  },

  clear(libraryID: number): void {
    const set = ensureCache().get(libraryID);
    if (!set || set.size === 0) return;
    set.clear();
    changed();
  },

  subscribe(cb: () => void): () => void {
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },

  prune(): void {
    try {
      const map = ensureCache();
      let mutated = false;
      for (const set of map.values()) {
        for (const id of Array.from(set)) {
          let exists = false;
          try {
            // Zotero.Items.get returns false when the item is gone.
            exists = !!Zotero.Items.get(id);
          } catch {
            exists = false;
          }
          if (!exists) {
            set.delete(id);
            mutated = true;
          }
        }
      }
      if (mutated) changed();
    } catch {
      /* ignore: prune is best-effort */
    }
  },
};
