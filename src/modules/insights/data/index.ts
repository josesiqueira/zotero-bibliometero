/**
 * insights/data/index.ts — caching data-accessor factory.
 *
 * Consumed by the hub's context.ts. Exposes a `VizDataAccessors`
 * implementation that:
 *  - gathers the scope's items once, converts them to ItemRecord[], and runs
 *    the pure aggregate builders a single time per `${scope}:${libraryID}`;
 *  - reuses that bundle across the six accessor calls;
 *  - re-slices top-sources / top-authors from a fully-ranked precompute, and
 *    rebuilds the network datasets when the requested cap changes.
 *
 * The localized item-type labels and collection names that composition needs
 * are looked up here (Zotero calls, wrapped in try/catch) and injected into the
 * pure builder so aggregate.ts stays Zotero-free.
 *
 * This file also re-exports the pure builders and helpers so the unit-test
 * suite can import everything from one place.
 */

import type {
  VizScope,
  VizDataAccessors,
  PublicationsPerYearData,
  TopSourcesData,
  TopAuthorsData,
  CompositionData,
  CoAuthorshipData,
  BipartiteData,
} from "../types";
import type { InsightsSource } from "../set/types";
import { insightsSet } from "../set/store";
import {
  gatherItems,
  toRecord,
  type ItemRecord,
  type GatherSource,
} from "./extract";
import {
  buildCoAuthorship,
  buildBipartite,
  buildPerYear,
  buildTopSources,
  buildTopAuthors,
  buildComposition,
} from "./aggregate";

/* Re-exports for the unit-test suite and downstream consumers. */
export type { ItemRecord } from "./extract";
export {
  gatherItems,
  toRecord,
  parseYear,
  parseYearFromString,
  extractSource,
} from "./extract";
export {
  normalizeCreators,
  buildCoAuthorship,
  buildBipartite,
  buildPerYear,
  buildTopSources,
  buildTopAuthors,
  buildComposition,
} from "./aggregate";

/** A fully-built, reusable bundle for one source:library cache slot. */
interface ScopeBundle {
  libraryID: number;
  records: ItemRecord[];
  perYear: PublicationsPerYearData;
  composition: CompositionData;
  /** Fully-ranked sources (topN = unbounded); accessors slice from this. */
  topSourcesAll: TopSourcesData;
  /** Fully-ranked authors (topN = unbounded); accessors slice from this. */
  topAuthorsAll: TopAuthorsData;
  /** Cached network datasets keyed by the cap they were built with. */
  coauthorshipByCap: Map<number, CoAuthorshipData>;
  bipartiteByCap: Map<number, BipartiteData>;
}

export interface DataAccessorOptions {
  getWin: () => any;
  /**
   * The primary SOURCE control ("library" | "set"), read by the hub from pref
   * `insights.source`. Preferred. When omitted the factory falls back to the
   * legacy `getScope` getter so existing wiring keeps working.
   */
  getSource?: () => InsightsSource;
  /**
   * Legacy scope getter ("library" | "view" | "selection"). Kept so the hub can
   * pass either getter; if both are present `getSource` wins.
   */
  getScope?: () => VizScope;
  getNetworkCap: () => number;
}

export type DataAccessors = VizDataAccessors & {
  /** Drop every cached bundle (e.g. on source change or explicit refresh). */
  invalidate(): void;
  /** Notifier hook: invalidate when items / collections change. */
  onNotify(
    event: string,
    type: string,
    ids: Array<string | number>,
  ): void;
  /**
   * Optional teardown: detach the set-store subscription. Safe to call more than
   * once. Existing callers that never call this simply keep the subscription for
   * the accessor's lifetime.
   */
  dispose?(): void;
};

/** Slice a fully-ranked sources precompute to `limit`. */
function sliceSources(all: TopSourcesData, limit: number): TopSourcesData {
  const entries =
    limit > 0 ? all.entries.slice(0, limit) : all.entries.slice();
  return { entries, total: all.total, missing: all.missing };
}

/** Slice a fully-ranked authors precompute to `limit`. */
function sliceAuthors(all: TopAuthorsData, limit: number): TopAuthorsData {
  const entries =
    limit > 0 ? all.entries.slice(0, limit) : all.entries.slice();
  return { entries, totalAuthors: all.totalAuthors };
}

/** Localized item-type label, resolved defensively. */
function localizedType(t: string): string {
  try {
    const s = (Zotero as any).ItemTypes?.getLocalizedString?.(t);
    if (s) return String(s);
  } catch {
    /* ignore */
  }
  return t;
}

/** Collection display name, resolved defensively. */
function collectionName(id: number): string {
  try {
    const c = (Zotero as any).Collections?.get?.(id);
    if (c && c.name) return String(c.name);
  } catch {
    /* ignore */
  }
  return `Collection ${id}`;
}

/**
 * Build the caching accessor object. The hub passes getters so source / window /
 * network-cap can change between calls without re-creating the accessors.
 *
 * The active SOURCE is read from `getSource` when present, otherwise from the
 * legacy `getScope`. For source "set" the bundle is rebuilt whenever the curated
 * set changes (we subscribe to `insightsSet`).
 */
export function createDataAccessors(
  opts: DataAccessorOptions,
): DataAccessors {
  // Cache slot per `${source}:${libraryID}`. A pending promise is stored while a
  // bundle is being built so concurrent accessor calls share one gather pass.
  const cache = new Map<string, Promise<ScopeBundle>>();

  /**
   * Resolve the active source. Prefer the new `getSource` getter; fall back to
   * the legacy `getScope`; default to "library" so the views always have data.
   */
  function resolveSource(): GatherSource {
    try {
      if (opts.getSource) {
        const s = opts.getSource();
        if (s === "library" || s === "set") return s;
      }
    } catch {
      /* ignore */
    }
    try {
      if (opts.getScope) {
        const s = opts.getScope();
        if (s) return s;
      }
    } catch {
      /* ignore */
    }
    return "library";
  }

  /** Resolve the active library id without re-gathering items. */
  function currentLibraryID(): number {
    try {
      const win = opts.getWin?.();
      const pane = win?.ZoteroPane;
      return (
        pane?.getSelectedLibraryID?.() ??
        Zotero.Libraries.userLibraryID ??
        0
      );
    } catch {
      try {
        return Zotero.Libraries.userLibraryID ?? 0;
      } catch {
        return 0;
      }
    }
  }

  function slotKey(source: GatherSource, libraryID: number): string {
    return `${source}:${libraryID}`;
  }

  /** Build (or reuse) the bundle for the current source. */
  function getBundle(): Promise<ScopeBundle> {
    const source = resolveSource();
    const libraryID = currentLibraryID();
    const key = slotKey(source, libraryID);
    const existing = cache.get(key);
    if (existing) return existing;

    const built = buildBundle(source).catch((err) => {
      // On failure, drop the slot so a later call retries rather than caching
      // a rejected promise forever.
      cache.delete(key);
      throw err;
    });
    cache.set(key, built);
    return built;
  }

  async function buildBundle(source: GatherSource): Promise<ScopeBundle> {
    const win = opts.getWin?.();
    const { items, libraryID } = await gatherItems(source, win);
    const records = items.map((it) => toRecord(it));

    const perYear = buildPerYear(records, true);
    const composition = buildComposition(
      records,
      localizedType,
      collectionName,
      8,
    );
    // topN = 0 means "rank everything"; accessors slice down per request.
    const topSourcesAll = buildTopSources(records, 0);
    const topAuthorsAll = buildTopAuthors(records, 0);

    return {
      libraryID,
      records,
      perYear,
      composition,
      topSourcesAll,
      topAuthorsAll,
      coauthorshipByCap: new Map(),
      bipartiteByCap: new Map(),
    };
  }

  // Rebuild datasets whenever the curated set changes. This keeps source "set"
  // (and the "(N)" counts) live even though library/set share one accessor
  // object. The library bundle is cheap to rebuild, so a blanket clear is fine.
  let unsubscribeSet: (() => void) | null = null;
  try {
    unsubscribeSet = insightsSet.subscribe(() => {
      cache.clear();
    });
  } catch {
    unsubscribeSet = null;
  }

  const api: DataAccessors = {
    async items(): Promise<Zotero.Item[]> {
      // Re-gather live items so callers always get current Zotero objects
      // (the bundle only stores plain records).
      const win = opts.getWin?.();
      const { items } = await gatherItems(resolveSource(), win);
      return items;
    },

    async perYear(): Promise<PublicationsPerYearData> {
      return (await getBundle()).perYear;
    },

    async topSources(limit: number): Promise<TopSourcesData> {
      const b = await getBundle();
      return sliceSources(b.topSourcesAll, limit);
    },

    async topAuthors(limit: number): Promise<TopAuthorsData> {
      const b = await getBundle();
      return sliceAuthors(b.topAuthorsAll, limit);
    },

    async composition(): Promise<CompositionData> {
      return (await getBundle()).composition;
    },

    async coauthorship(cap: number): Promise<CoAuthorshipData> {
      const b = await getBundle();
      const effCap = cap > 0 ? cap : opts.getNetworkCap?.() || 0;
      const cached = b.coauthorshipByCap.get(effCap);
      if (cached) return cached;
      const data = buildCoAuthorship(b.records, effCap);
      b.coauthorshipByCap.set(effCap, data);
      return data;
    },

    async bipartite(cap: number): Promise<BipartiteData> {
      const b = await getBundle();
      const effCap = cap > 0 ? cap : opts.getNetworkCap?.() || 0;
      const cached = b.bipartiteByCap.get(effCap);
      if (cached) return cached;
      const data = buildBipartite(b.records, effCap);
      b.bipartiteByCap.set(effCap, data);
      return data;
    },

    invalidate(): void {
      cache.clear();
    },

    onNotify(
      event: string,
      type: string,
      _ids: Array<string | number>,
    ): void {
      void _ids;
      // Item or collection mutations can change any scope's contents, so the
      // conservative correct move is to drop the whole cache. Membership and
      // metadata edits surface as item/collection/collection-item events.
      const relevant =
        type === "item" ||
        type === "collection" ||
        type === "collection-item";
      const mutating =
        event === "add" ||
        event === "modify" ||
        event === "delete" ||
        event === "trash" ||
        event === "refresh";
      if (relevant && mutating) {
        cache.clear();
      }
    },

    dispose(): void {
      try {
        unsubscribeSet?.();
      } catch {
        /* ignore */
      }
      unsubscribeSet = null;
      cache.clear();
    },
  };

  return api;
}
