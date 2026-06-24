/**
 * Curated set - FROZEN CONTRACT.
 *
 * The "Insights set" is a plugin-private, per-library list of item ids (no tags,
 * nothing written to the user's items). `insightsSet` (the singleton implementing
 * InsightsSetStore, exported from ./store) is the single source of truth used by
 * the context menus, the Set management view, and the data layer.
 */

/** What feeds the six visualizations. */
export type InsightsSource = "library" | "set";

export interface InsightsSetStore {
  /** Is this item in the set for its library? */
  has(libraryID: number, itemID: number): boolean;
  /** How many items are in the set for a library. */
  count(libraryID: number): number;
  /** The item ids in the set for a library (order not guaranteed). */
  list(libraryID: number): number[];

  /** Add items (idempotent). */
  add(libraryID: number, itemIDs: number[]): void;
  /** Remove items (idempotent). */
  remove(libraryID: number, itemIDs: number[]): void;
  /**
   * Toggle a selection. If any of the items are NOT in the set, all are added;
   * otherwise all are removed. Returns the action taken so a menu can label
   * itself. (Mixed selections add, so a second click removes.)
   */
  toggle(libraryID: number, itemIDs: number[]): "added" | "removed";
  /** Empty the set for a library. */
  clear(libraryID: number): void;

  /** Subscribe to any membership change; returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;

  /** Drop ids whose items no longer exist (called from the notifier on delete). */
  prune(): void;
}
