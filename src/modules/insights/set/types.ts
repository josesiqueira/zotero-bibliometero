/**
 * Insights scope store - FROZEN CONTRACT.
 *
 * Per library, the analysis SCOPE is a `mode` plus two coexisting id-lists:
 *   - mode "exclude": the whole library MINUS the exclude list (a blocklist).
 *   - mode "include": ONLY the include list (an allowlist).
 * Both lists always persist, so switching modes is non-destructive.
 *
 * ACTIVE-LIST SEMANTICS: has / count / list / add / remove / toggle / clear all
 * act on the ACTIVE list (the exclude list in exclude mode, the include list in
 * include mode). So `add` excludes in exclude mode and includes in include mode.
 * Use getMode/setMode to read and flip the mode.
 *
 * `insightsSet` (the singleton implementing InsightsSetStore, exported from
 * ./store) is the single source of truth used by the context menus, the
 * management view, and the data layer. Plugin-private: no tags are written to
 * the user's items.
 */

/** What feeds the six visualizations. */
export type InsightsSource = "library" | "set";

/** Which list is authoritative for a library's analysis scope. */
export type InsightsScopeMode = "exclude" | "include";

export interface InsightsSetStore {
  /** The active scope mode for a library (defaults to "exclude"). */
  getMode(libraryID: number): InsightsScopeMode;
  /** Set the active scope mode for a library (notifies on change). */
  setMode(libraryID: number, mode: InsightsScopeMode): void;

  /** Is this item in the ACTIVE list for its library? */
  has(libraryID: number, itemID: number): boolean;
  /** How many items are in the ACTIVE list for a library. */
  count(libraryID: number): number;
  /** The item ids in the ACTIVE list for a library (order not guaranteed). */
  list(libraryID: number): number[];

  /** Add items to the ACTIVE list (idempotent). */
  add(libraryID: number, itemIDs: number[]): void;
  /** Remove items from the ACTIVE list (idempotent). */
  remove(libraryID: number, itemIDs: number[]): void;
  /**
   * Toggle a selection against the ACTIVE list. If any of the items are NOT in
   * the list, all are added; otherwise all are removed. Returns the action taken
   * so a menu can label itself. (Mixed selections add, so a second click removes.)
   */
  toggle(libraryID: number, itemIDs: number[]): "added" | "removed";
  /** Empty the ACTIVE list for a library. */
  clear(libraryID: number): void;

  /** Subscribe to any membership / mode change; returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;

  /** Drop ids whose items no longer exist, from BOTH lists of every library. */
  prune(): void;
}
