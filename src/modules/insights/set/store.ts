/**
 * insights/set/store.ts — the dual-mode SCOPE STORE (pref-backed singleton).
 *
 * Implements `InsightsSetStore` (the FROZEN CONTRACT in ./types.ts). Each
 * library has a SCOPE made of a `mode` plus TWO id-lists that always coexist:
 *
 *   - mode "exclude": analyse the whole library MINUS the `exclude` list
 *     (a blocklist; an empty list means the whole library).
 *   - mode "include": analyse ONLY the `include` list (an allowlist; an empty
 *     list means nothing is analysed yet).
 *
 * Both lists persist regardless of the active mode, so flipping modes never
 * loses the user's curation (it is a single field write). Nothing is written to
 * the user's items (no tags); the only persistence is the plugin pref
 * `insights.excluded`, a JSON string (see persistence section for the shape).
 *
 * ACTIVE-LIST SEMANTICS (important): the historical methods has / count / list /
 * add / remove / toggle / clear all act on the ACTIVE list for the library, i.e.
 * the `exclude` list in exclude mode and the `include` list in include mode. So
 * `add` excludes in exclude mode and includes in include mode; `has` means "is
 * in the active list". This is what lets the context menus, the management view,
 * and the data layer keep their existing calls and have semantics follow the
 * mode. Use getMode/setMode to read/flip the mode.
 *
 * Design:
 *  - In-memory cache: `Map<number, LibScope>` loaded lazily from the pref.
 *  - Writes are debounced (~250ms) but a synchronous flush guarantees a reopen
 *    sees the latest state.
 *  - One Zotero.Notifier observer (on ["item"]) prunes PERMANENTLY-deleted items
 *    from BOTH lists so they cannot resurrect in the inactive list on a later
 *    mode switch. Trashed-but-not-deleted items still resolve via
 *    Zotero.Items.get, so they intentionally stay curated (restore keeps them).
 *
 * Dependency-free, defensive: every Zotero / JSON / pref touch is guarded.
 */

import type { InsightsSetStore, InsightsScopeMode } from "./types";
import { getPrefRaw, setPrefRaw } from "../../../utils/prefs";
import {
  type LibScope,
  parsePref,
  serialize,
  needsMigration,
  defaultScope,
  pruneScope,
  isValidId,
} from "./scope";

const PREF_KEY = "insights.excluded";
const WRITE_DEBOUNCE_MS = 250;
const PRUNE_DEBOUNCE_MS = 250;

/** Lazily-loaded per-library scope. `null` until first load. */
let cache: Map<number, LibScope> | null = null;

/** Change subscribers. Called (best-effort) on any membership / mode change. */
const subscribers = new Set<() => void>();

/** Debounced-write handle and the notifier-prune handle. */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

/** The registered Zotero.Notifier id (null when not registered). */
let notifierID: string | null = null;

// ---- persistence ----------------------------------------------------------
//
// Parsing / serialization / migration detection live in ./scope.ts (pure). The
// store only owns the cache, the side-effecting load, and the write-back.

/** Load the cache from the pref the first time it is needed. */
function ensureCache(): Map<number, LibScope> {
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
  // Write the v2 shape back once (synchronously) after a legacy lift so later
  // loads skip detection. Idempotent: re-running on an already-v2 pref is a
  // no-op write.
  try {
    if (needsMigration(raw)) flush();
  } catch {
    /* best-effort migration write-back */
  }
  return cache;
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

/** Persist (debounced) and notify after a membership / mode change. */
function changed(): void {
  persist();
  notify();
}

/** The scope for a library, creating a default one in the cache if needed. */
function scopeFor(libraryID: number): LibScope {
  const map = ensureCache();
  let s = map.get(libraryID);
  if (!s) {
    s = defaultScope();
    map.set(libraryID, s);
  }
  return s;
}

/** The ACTIVE list for a library without creating cache state (read path). */
function activeSetRead(libraryID: number): Set<number> | null {
  const s = ensureCache().get(libraryID);
  if (!s) return null;
  return s.mode === "include" ? s.include : s.exclude;
}

/** The ACTIVE list for a library, creating default state if needed (write path). */
function activeSetWrite(libraryID: number): Set<number> {
  const s = scopeFor(libraryID);
  return s.mode === "include" ? s.include : s.exclude;
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
  getMode(libraryID: number): InsightsScopeMode {
    return ensureCache().get(libraryID)?.mode ?? "exclude";
  },

  setMode(libraryID: number, mode: InsightsScopeMode): void {
    const next: InsightsScopeMode = mode === "include" ? "include" : "exclude";
    const s = scopeFor(libraryID);
    if (s.mode === next) return;
    s.mode = next;
    changed();
  },

  has(libraryID: number, itemID: number): boolean {
    const set = activeSetRead(libraryID);
    return set ? set.has(itemID) : false;
  },

  count(libraryID: number): number {
    const set = activeSetRead(libraryID);
    return set ? set.size : 0;
  },

  list(libraryID: number): number[] {
    const set = activeSetRead(libraryID);
    return set ? Array.from(set) : [];
  },

  add(libraryID: number, itemIDs: number[]): void {
    if (!itemIDs || itemIDs.length === 0) return;
    const set = activeSetWrite(libraryID);
    let mutated = false;
    for (const id of itemIDs) {
      if (!isValidId(id) || set.has(id)) continue;
      set.add(id);
      mutated = true;
    }
    if (mutated) changed();
  },

  remove(libraryID: number, itemIDs: number[]): void {
    if (!itemIDs || itemIDs.length === 0) return;
    const set = activeSetRead(libraryID);
    if (!set) return;
    let mutated = false;
    for (const id of itemIDs) {
      if (set.delete(id)) mutated = true;
    }
    if (mutated) changed();
  },

  toggle(libraryID: number, itemIDs: number[]): "added" | "removed" {
    const ids = (itemIDs || []).filter((id) => isValidId(id));
    const set = activeSetWrite(libraryID);
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
    const set = activeSetRead(libraryID);
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
      for (const [libraryID, scope] of map) {
        // Only prune a library whose items are actually loaded. A delete in ANY
        // library schedules a prune across ALL of them, and Zotero.Items.get()
        // returns falsy for items in a transiently-unloaded (e.g. group)
        // library, so without this guard we would silently and permanently wipe
        // still-valid curated ids. Skipping leaves those lists untouched.
        if (!isLibraryItemsLoaded(libraryID)) continue;
        // Prune BOTH lists, not just the active one, so a deleted item cannot
        // resurrect in the inactive list after a later mode switch.
        if (pruneScope(scope, idExists)) mutated = true;
      }
      if (mutated) changed();
    } catch {
      /* ignore: prune is best-effort */
    }
  },
};

/** True when a library exists and its items are loaded (safe to prune against). */
function isLibraryItemsLoaded(libraryID: number): boolean {
  try {
    const lib = (Zotero.Libraries as any)?.get?.(libraryID);
    if (!lib) return false;
    // getDataLoaded may be absent on some library types; treat present-lib as
    // loaded in that case rather than risk wiping valid ids.
    if (typeof lib.getDataLoaded === "function") {
      return !!lib.getDataLoaded("item");
    }
    return true;
  } catch {
    return false;
  }
}

/** Zotero.Items.get(id) truthiness, guarded. */
function idExists(id: number): boolean {
  try {
    return !!Zotero.Items.get(id);
  } catch {
    return false;
  }
}
