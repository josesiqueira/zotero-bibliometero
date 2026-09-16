/**
 * insights/set/scope.ts — PURE scope persistence + resolution.
 *
 * No Zotero / pref / DOM imports: every function here is a deterministic
 * transform, so the whole file is unit-testable without a Zotero binary. The
 * store (./store.ts) owns the in-memory cache, the notifier, and persistence
 * side effects; it delegates parsing, serialization, and scope resolution here.
 *
 * Persisted JSON shapes:
 *   v2 (current): { "v": 2, "libs": { [libraryID]: { mode, exclude[], include[] } } }
 *   legacy:       { [libraryID]: number[] }   (the old exclusion-only blob)
 *
 * Clean-room original implementation.
 */

import type { InsightsScopeMode } from "./types";

export const SCHEMA_VERSION = 2;

/** Per-library scope: a mode plus both id-lists (only one is active at a time). */
export interface LibScope {
  mode: InsightsScopeMode;
  exclude: Set<number>;
  include: Set<number>;
}

/**
 * A valid Zotero item id is a positive integer. Single gate shared by the parse
 * path (toIdSet) and the write path (store add/toggle) so the two never disagree
 * about what counts as a storable id.
 */
export function isValidId(value: unknown): boolean {
  const id = Number(value);
  return Number.isFinite(id) && id > 0;
}

/**
 * Coerce an arbitrary value into a Set of valid item ids. Zotero item ids are
 * positive integers, so we require id > 0; this also drops the surprising
 * `Number(null)` / `Number("")` === 0 coercions.
 */
export function toIdSet(value: unknown): Set<number> {
  const set = new Set<number>();
  if (!Array.isArray(value)) return set;
  for (const raw of value) {
    if (isValidId(raw)) set.add(Number(raw));
  }
  return set;
}

/** A fresh default scope (exclude mode, both lists empty). */
export function defaultScope(): LibScope {
  return { mode: "exclude", exclude: new Set<number>(), include: new Set<number>() };
}

/** The ACTIVE set for a scope (exclude list in exclude mode, include otherwise). */
export function activeSetOf(scope: LibScope): Set<number> {
  return scope.mode === "include" ? scope.include : scope.exclude;
}

/** Parse one v2 per-library entry defensively into a LibScope. */
export function parseLibScope(value: unknown): LibScope {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const mode: InsightsScopeMode = v.mode === "include" ? "include" : "exclude";
  return { mode, exclude: toIdSet(v.exclude), include: toIdSet(v.include) };
}

/**
 * Parse the pref JSON defensively into the cache shape. Strictly gates the v2
 * shape on a numeric `v === 2` so a v2 blob is NEVER misread as legacy (which
 * would silently wipe the include lists). Anything else that looks like the
 * legacy `{ [libraryID]: number[] }` blob is lifted into exclude mode. Corrupt
 * or partial input yields an empty map.
 */
export function parsePref(raw: unknown): Map<number, LibScope> {
  const map = new Map<number, LibScope>();
  if (typeof raw !== "string" || raw.length === 0) return map;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return map;

  const o = obj as Record<string, unknown>;

  // Number() tolerates a stringified version ("2") from a hand-edited pref;
  // Number(undefined) is NaN, so a legacy blob still routes to the legacy branch.
  if (Number(o.v) === SCHEMA_VERSION) {
    const libs =
      o.libs && typeof o.libs === "object" && !Array.isArray(o.libs)
        ? (o.libs as Record<string, unknown>)
        : {};
    for (const key of Object.keys(libs)) {
      const libraryID = Number(key);
      if (!Number.isFinite(libraryID)) continue;
      map.set(libraryID, parseLibScope(libs[key]));
    }
    return map;
  }

  // Legacy shape { [libraryID]: number[] } -> exclude mode (loss-free lift).
  for (const key of Object.keys(o)) {
    const libraryID = Number(key);
    if (!Number.isFinite(libraryID)) continue;
    const value = o[key];
    if (!Array.isArray(value)) continue;
    map.set(libraryID, {
      mode: "exclude",
      exclude: toIdSet(value),
      include: new Set<number>(),
    });
  }
  return map;
}

/** True when a scope is at its default (exclude mode, both lists empty). */
export function isDefaultScope(s: LibScope): boolean {
  return s.mode === "exclude" && s.exclude.size === 0 && s.include.size === 0;
}

/** True when a raw parsed object needs a one-time v2 write-back (legacy/old). */
export function needsMigration(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Number((obj as Record<string, unknown>).v) !== SCHEMA_VERSION;
}

/**
 * Prune ids whose item no longer exists from BOTH lists of a scope (so a deleted
 * item cannot resurrect in the inactive list after a mode switch). `exists` is
 * injected so this stays Zotero-free and unit-testable. Returns true if mutated.
 */
export function pruneScope(
  scope: LibScope,
  exists: (id: number) => boolean,
): boolean {
  let mutated = false;
  for (const set of [scope.exclude, scope.include]) {
    for (const id of Array.from(set)) {
      if (!exists(id)) {
        set.delete(id);
        mutated = true;
      }
    }
  }
  return mutated;
}

/**
 * Is item `id` in scope for a given mode + active list? include => in the list;
 * exclude => not in the list. Naturally handles the empty-active cases (empty
 * include => nothing in scope; empty exclude => everything in scope).
 */
export function isInScope(
  mode: InsightsScopeMode,
  active: Set<number>,
  id: number,
): boolean {
  return mode === "include" ? active.has(id) : !active.has(id);
}

/** Serialize the cache to the versioned JSON shape, omitting default libraries. */
export function serialize(map: Map<number, LibScope>): string {
  const libs: Record<string, unknown> = {};
  for (const [libraryID, s] of map) {
    if (isDefaultScope(s)) continue; // keep stored JSON compact
    libs[String(libraryID)] = {
      mode: s.mode,
      exclude: Array.from(s.exclude),
      include: Array.from(s.include),
    };
  }
  try {
    return JSON.stringify({ v: SCHEMA_VERSION, libs });
  } catch {
    return JSON.stringify({ v: SCHEMA_VERSION, libs: {} });
  }
}

/**
 * Resolve which ids of `universe` are in scope, given the active list. This is
 * the single canonical scope rule shared (in spirit) with the data layer:
 *   - include mode: universe INTERSECT active (empty active => empty scope).
 *   - exclude mode: universe MINUS active (empty active => whole universe).
 */
export function resolveScopeIds(
  mode: InsightsScopeMode,
  active: Iterable<number>,
  universe: Iterable<number>,
): number[] {
  const set = active instanceof Set ? active : new Set(active);
  const out: number[] = [];
  if (mode === "include") {
    if (set.size === 0) return out;
    for (const id of universe) if (set.has(id)) out.push(id);
    return out;
  }
  for (const id of universe) if (!set.has(id)) out.push(id);
  return out;
}
