/**
 * insights/data/aggregate.ts — PURE aggregation over ItemRecord[].
 *
 * NO Zotero imports. Every function here is a deterministic transform from
 * plain records to one of the frozen dataset shapes in ../types.ts, so the
 * whole file is unit-testable without a Zotero binary.
 *
 * The author-normalization heuristic (single-field/institutional vs.
 * last+initial) is shared by views 1, 2 and 5 via normalizeCreators() so they
 * always agree on identity. Anything that needs a Zotero call (localized type
 * labels, collection names) is INJECTED as a function argument to keep this
 * file dependency-free.
 *
 * Clean-room original implementation.
 */

import type {
  AuthorKey,
  CoAuthorshipData,
  CoAuthorNode,
  CoAuthorEdge,
  CoAuthorGroup,
  BipartiteData,
  BipartitePaperNode,
  BipartiteAuthorNode,
  BipartiteEdge,
  PublicationsPerYearData,
  YearBucket,
  TopSourcesData,
  SourceEntry,
  TopAuthorsData,
  AuthorCountEntry,
  CompositionData,
  CompositionSegment,
} from "../types";
import type { ItemRecord } from "./extract";
import { louvain } from "./cluster";

/**
 * Guard against pathological author lists: an item with N authors yields
 * N*(N-1)/2 co-author edges, so we skip pairing past this many authors.
 */
const MAX_AUTHORS_PER_PAPER = 50;

/** Sentinel collection key for the aggregated long tail in composition. */
const OTHER_COLLECTION_KEY = "__other";

/* ----------------------------------------------------------------------------
 * Author normalization
 * ------------------------------------------------------------------------- */

/**
 * Normalize one creator to a canonical AuthorKey, or null when it carries no
 * usable name.
 *
 * - Single-field / institutional (name present, lastName absent) -> key
 *   "n:<lower name>", label = the name verbatim.
 * - Otherwise last + first-initial -> key "<lower last>|<first initial>",
 *   label "Last, F." (or just "Last" when no first name).
 */
function creatorToKey(creator: {
  firstName?: string;
  lastName?: string;
  name?: string;
}): AuthorKey | null {
  const name = (creator.name || "").trim();
  const last = (creator.lastName || "").trim();
  const first = (creator.firstName || "").trim();

  // Single-field / institutional: name set and no structured lastName.
  if (name && !last) {
    return { key: `n:${foldName(name)}`, label: name };
  }

  if (!last && !first) {
    // Only a name fragment in an unexpected slot; fall back to name if any.
    if (name) return { key: `n:${foldName(name)}`, label: name };
    return null;
  }

  const initial = first ? foldText(first)[0] || "" : "";
  const key = `${foldName(last)}|${initial}`;
  const label = first ? `${last}, ${first[0]!.toUpperCase()}.` : last;
  return { key, label };
}

/** Matching form of a name: accents, case and punctuation folded. */
function foldName(s: string): string {
  return foldText(s)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalized, de-duplicated author keys for one record.
 *
 * @param authorOnly When true, only "author" creators are considered. Records
 *   carry no creatorType today, so this is reserved for future use and is a
 *   no-op (all creators are included); kept on the signature for the contract.
 */
export function normalizeCreators(
  rec: ItemRecord,
  authorOnly?: boolean,
): AuthorKey[] {
  void authorOnly; // reserved; records currently lack creatorType.
  const out: AuthorKey[] = [];
  const seen = new Set<string>();
  for (const c of rec.creators || []) {
    const k = creatorToKey(c);
    if (!k) continue;
    if (seen.has(k.key)) continue;
    seen.add(k.key);
    out.push(k);
  }
  return out;
}

/** First given-name token, accent-folded, or "" when it is only an initial. */
function fullGiven(first: string): string {
  const tok =
    foldText(first)
      .replace(/[^a-z\s-]/g, " ")
      .trim()
      .split(/\s+/)[0] || "";
  return tok.length > 1 ? tok : "";
}

interface Resolved {
  key: string;
  label: string;
}

/**
 * Library-wide author identity, in two passes over all records.
 *
 * Base key = accent-folded surname + first initial, the bibliometric default
 * (bibliometrix; Milojevic 2013 finds it about 97% accurate, its errors being
 * merges of different people). Two refinements use the rest of the library:
 * - when one surname+initial covers several different full given names
 *   ("Zhang, Yi" and "Zhang, Yu"), each full name stays a separate author;
 * - an initials-only form ("Floridi, L.") joins the full name when exactly one
 *   full name exists for it, and otherwise stays its own "Surname, I." entry.
 * Labels show the most common full spelling ("Floridi, Luciano").
 */
function makeAuthorResolver(
  records: ItemRecord[],
): (rec: ItemRecord) => Resolved[] {
  const givenByBase = new Map<string, Map<string, number>>();
  const spellingByKey = new Map<string, Map<string, number>>();

  // Compound surnames are written in many ways ("Siqueira De Cerqueira,
  // José Antonio", "Cerqueira, Jose Antonio Siqueira De", "De Cerqueira, José
  // Siqueira"), which give different base keys for one person. Compare the
  // name words instead, ignoring particles (de, da, van, von, ...):
  // - spellings with the same words (3 or more, none an initial) are one
  //   person;
  // - a spelling whose words all appear in exactly one longer spelling joins
  //   it (the same rule as initials joining a unique full name); when several
  //   longer spellings contain it, it stays apart.
  // Two-word names are left alone, so "Lee, Kim" and "Kim, Lee" stay two.
  const wordsOf = (c: { firstName?: string; lastName?: string }) => {
    const words = foldName(`${c.lastName || ""} ${c.firstName || ""}`)
      .split(/[\s-]+/)
      .filter((w) => w && !NAME_PARTICLES.has(w));
    if (words.length < 3 || words.some((w) => w.length < 2)) return "";
    return Array.from(new Set(words)).sort().join(" ");
  };
  const basesByWords = new Map<string, Map<string, number>>();
  for (const rec of records) {
    for (const c of rec.creators || []) {
      const k = creatorToKey(c);
      const w = k && !k.key.startsWith("n:") ? wordsOf(c) : "";
      if (!w) continue;
      let m = basesByWords.get(w);
      if (!m) basesByWords.set(w, (m = new Map()));
      m.set(k!.key, (m.get(k!.key) || 0) + 1);
    }
  }
  const joinedBase = joinNameForms(basesByWords);

  const baseOf = (c: {
    firstName?: string;
    lastName?: string;
    name?: string;
  }) => {
    const k = creatorToKey(c);
    if (!k) return null;
    if (k.key.startsWith("n:") || !joinedBase.size) return k.key;
    return joinedBase.get(wordsOf(c)) ?? k.key;
  };
  for (const rec of records) {
    for (const c of rec.creators || []) {
      const base = baseOf(c);
      if (!base || base.startsWith("n:")) continue;
      const g = fullGiven(c.firstName || "");
      if (!g) continue;
      let m = givenByBase.get(base);
      if (!m) givenByBase.set(base, (m = new Map()));
      m.set(g, (m.get(g) || 0) + 1);
    }
  }

  const resolveOne = (c: {
    firstName?: string;
    lastName?: string;
    name?: string;
  }): Resolved | null => {
    const k = creatorToKey(c);
    if (!k) return null;
    if (k.key.startsWith("n:")) return k;
    const base = baseOf(c)!;
    const given = givenByBase.get(base);
    const g = fullGiven(c.firstName || "");
    let key = base;
    if (given && given.size > 1) {
      // Several people share this surname+initial: keep full names apart and
      // leave ambiguous initials-only forms under the base key.
      if (g) key = `${base}|${g}`;
    }
    return { key, label: k.label };
  };

  const display = (c: { firstName?: string; lastName?: string }) => {
    const last = (c.lastName || "").trim();
    const first = (c.firstName || "").trim().replace(/\s+/g, " ");
    return first ? `${last}, ${first}` : last;
  };
  for (const rec of records) {
    for (const c of rec.creators || []) {
      const r = resolveOne(c);
      if (!r || r.key.startsWith("n:")) continue;
      if (!fullGiven(c.firstName || "")) continue;
      let m = spellingByKey.get(r.key);
      if (!m) spellingByKey.set(r.key, (m = new Map()));
      const d = display(c);
      m.set(d, (m.get(d) || 0) + 1);
    }
  }

  return (rec: ItemRecord) => {
    const out: Resolved[] = [];
    const seen = new Set<string>();
    for (const c of rec.creators || []) {
      const r = resolveOne(c);
      if (!r || seen.has(r.key)) continue;
      seen.add(r.key);
      const spellings = spellingByKey.get(r.key);
      out.push({
        key: r.key,
        label: spellings ? mostFrequent(spellings) : r.label,
      });
    }
    return out;
  };
}

/**
 * Map every record to its resolved author keys, building a global label table,
 * a per-author paper count and the item ids per author. Shared by every author
 * view so identity and counts always match.
 */
function buildAuthorIndex(records: ItemRecord[]): {
  perRecord: AuthorKey[][];
  paperCount: Map<string, number>;
  labelByKey: Map<string, string>;
  idsByKey: Map<string, number[]>;
} {
  const resolve = makeAuthorResolver(records);
  const perRecord: AuthorKey[][] = [];
  const paperCount = new Map<string, number>();
  const labelByKey = new Map<string, string>();
  const idsByKey = new Map<string, number[]>();

  for (const rec of records) {
    const keys = resolve(rec);
    perRecord.push(keys);
    for (const k of keys) {
      paperCount.set(k.key, (paperCount.get(k.key) || 0) + 1);
      if (!labelByKey.has(k.key)) labelByKey.set(k.key, k.label);
      pushTo(idsByKey, k.key, rec.id);
    }
  }
  return { perRecord, paperCount, labelByKey, idsByKey };
}

/* ----------------------------------------------------------------------------
 * 1. Co-authorship network
 * ------------------------------------------------------------------------- */

/**
 * Add an undirected edge between two author keys, summing weight on duplicates.
 * Keys are ordered so (a,b) and (b,a) collapse to one entry.
 */
function addAuthorEdge(
  map: Map<string, CoAuthorEdge>,
  a: string,
  b: string,
  weight: number,
): void {
  if (a === b) return;
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const k = `${lo}\u0000${hi}`;
  const existing = map.get(k);
  if (existing) {
    existing.weight += weight;
  } else {
    map.set(k, { source: lo, target: hi, weight });
  }
}

/** Most repeat authors drawn on the author/paper map. */
const MAX_BIPARTITE_AUTHORS = 50;

/** Papers with more authors than this add no links (they still count). */
export const MAX_LINKED_AUTHORS = 25;
/** Most links drawn; the weakest are dropped first (VOSviewer "Max. lines"). */
const MAX_EDGES = 500;
/** Groups smaller than this are drawn in the neutral colour. */
const MIN_GROUP = 3;
/** Groups beyond this many get the neutral colour (palette size). */
const MAX_GROUPS = 8;

/**
 * The smallest "at least N items" threshold that keeps at most `cap` authors,
 * starting at 2 (an author on a single item says nothing about recurring
 * collaboration) and dropping to 1 only when 2 would leave almost nobody,
 * as in a small curated set.
 */
export function minPapersFor(counts: number[], cap: number): number {
  const atLeast = (m: number) => counts.filter((c) => c >= m).length;
  let m = atLeast(2) >= 5 ? 2 : 1;
  while (cap > 0 && atLeast(m) > cap) m++;
  return m;
}

/**
 * Build the co-authorship network the way bibliometric mapping tools do
 * (VOSviewer, bibliometrix): keep the authors with at least `minPapers` items
 * (raised until at most `cap` remain), link two authors once per shared item
 * (items with more than MAX_LINKED_AUTHORS authors add no links), drop authors
 * left without links, find research groups with Louvain, and keep the
 * MAX_EDGES strongest links.
 */
export function buildCoAuthorship(
  records: ItemRecord[],
  cap: number,
): CoAuthorshipData {
  const { perRecord, paperCount, labelByKey, idsByKey } =
    buildAuthorIndex(records);
  const totalAuthors = paperCount.size;
  const minPapers = minPapersFor(
    Array.from(paperCount.values()),
    cap > 0 ? cap : 150,
  );
  const kept = new Set<string>();
  for (const [key, c] of paperCount) if (c >= minPapers) kept.add(key);

  const edgeMap = new Map<string, CoAuthorEdge>();
  let largeTeamPapers = 0;
  for (const keys of perRecord) {
    if (keys.length > MAX_LINKED_AUTHORS) {
      largeTeamPapers++;
      continue;
    }
    const ks = keys.filter((k) => kept.has(k.key));
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        addAuthorEdge(edgeMap, ks[i]!.key, ks[j]!.key, 1);
      }
    }
  }
  let edges = Array.from(edgeMap.values());

  // Authors without any link among the kept authors say nothing about
  // collaboration here; Top authors still lists them.
  const linked = new Set<string>();
  for (const e of edges) {
    linked.add(e.source);
    linked.add(e.target);
  }
  let nodes: CoAuthorNode[] = Array.from(linked)
    .sort()
    .map((key) => ({
      id: key,
      label: labelByKey.get(key) || key,
      paperCount: paperCount.get(key) || 0,
      degree: 0,
      group: -1,
      itemIds: idsByKey.get(key) || [],
    }));

  // Groups.
  const comm = louvain(
    nodes.map((n) => n.id),
    edges.map((e) => ({ a: e.source, b: e.target, w: e.weight })),
  );
  const members = new Map<number, CoAuthorNode[]>();
  for (const n of nodes) {
    const c = comm.get(n.id) ?? -1;
    const list = members.get(c);
    if (list) list.push(n);
    else members.set(c, [n]);
  }
  const ranked = Array.from(members.values())
    .filter((list) => list.length >= MIN_GROUP)
    .map((list) =>
      list.sort(
        (a, b) => b.paperCount - a.paperCount || (a.label < b.label ? -1 : 1),
      ),
    )
    .sort((a, b) => b.length - a.length || (a[0]!.label < b[0]!.label ? -1 : 1))
    .slice(0, MAX_GROUPS);
  const groups: CoAuthorGroup[] = ranked.map((list, index) => {
    for (const n of list) n.group = index;
    return { index, label: list[0]!.label, size: list.length };
  });

  // Draw only the strongest links.
  if (edges.length > MAX_EDGES) {
    edges = edges
      .slice()
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          (a.source + a.target < b.source + b.target ? -1 : 1),
      )
      .slice(0, MAX_EDGES);
  }
  computeDegree(nodes, edges);
  nodes = nodes.filter((n) => n.degree > 0);

  return {
    nodes,
    edges,
    groups,
    minPapers,
    totalAuthors,
    largeTeamPapers,
    truncated: nodes.length < totalAuthors,
  };
}

/** Recompute each node's degree (incident edge count) in place. */
function computeDegree(nodes: CoAuthorNode[], edges: CoAuthorEdge[]): void {
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;
}

/* ----------------------------------------------------------------------------
 * 2. Author-to-paper bipartite
 * ------------------------------------------------------------------------- */

/**
 * Build the author/paper network for the question "which of my items come from
 * the same people?". Authors with at least `minPapers` items (2, or 1 in a
 * small scope) are added in order of item count, each with their items, until
 * the node budget `cap` is spent. Items appear only through a shown author;
 * authors on a single item would be dead ends, so they are left out.
 */
export function buildBipartite(
  records: ItemRecord[],
  cap: number,
): BipartiteData {
  const { perRecord, paperCount, labelByKey, idsByKey } =
    buildAuthorIndex(records);
  const totalPapers = records.length;
  const budget = cap > 0 ? cap : Number.POSITIVE_INFINITY;
  // Same rule as the co-authorship map: 2+ items (1 in a small scope), raised
  // until at most MAX_BIPARTITE_AUTHORS remain, so the map stays readable.
  const minPapers = minPapersFor(
    Array.from(paperCount.values()),
    MAX_BIPARTITE_AUTHORS,
  );

  const byId = new Map<number, number>();
  records.forEach((r, i) => byId.set(r.id, i));

  const candidates = Array.from(paperCount.entries())
    .filter(([, c]) => c >= minPapers)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  const authors: BipartiteAuthorNode[] = [];
  const shownPapers = new Set<number>();
  let used = 0;
  let truncated = false;
  for (const [key, c] of candidates) {
    const ids = idsByKey.get(key) || [];
    const fresh = ids.filter((id) => !shownPapers.has(id));
    const cost = 1 + fresh.length;
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    used += cost;
    authors.push({
      id: `author:${key}`,
      label: labelByKey.get(key) || key,
      paperCount: c,
      itemIds: ids,
    });
    for (const id of fresh) shownPapers.add(id);
  }

  const shownAuthors = new Set(authors.map((a) => a.id));
  const papers: BipartitePaperNode[] = [];
  const edges: BipartiteEdge[] = [];
  for (const id of shownPapers) {
    const idx = byId.get(id);
    if (idx === undefined) continue;
    const rec = records[idx]!;
    const first = (
      rec.creators[0]?.lastName ||
      rec.creators[0]?.name ||
      ""
    ).trim();
    papers.push({
      id: rec.id,
      key: `paper:${rec.id}`,
      label:
        [first, rec.year ?? ""].filter(Boolean).join(" ") ||
        rec.title.slice(0, 24),
      title: rec.title,
      itemType: rec.itemType,
      year: rec.year,
    });
    for (const k of perRecord[idx]!) {
      const aid = `author:${k.key}`;
      if (shownAuthors.has(aid)) edges.push({ paperId: rec.id, authorId: aid });
    }
  }
  papers.sort((a, b) => a.id - b.id);

  return { papers, authors, edges, minPapers, truncated, totalPapers };
}

/* ----------------------------------------------------------------------------
 * 3. Publications per year
 * ------------------------------------------------------------------------- */

/**
 * Tally publications by year. The null (unparseable / missing) bucket is placed
 * last. When `fillGaps` is true, every integer year between min and max gets a
 * bucket (zero-filled) so the histogram has no holes.
 */
export function buildPerYear(
  records: ItemRecord[],
  fillGaps = true,
): PublicationsPerYearData {
  const ids = new Map<number, number[]>();
  const missingIds: number[] = [];
  const total = records.length;

  for (const rec of records) {
    if (rec.year === null || rec.year === undefined) {
      missingIds.push(rec.id);
    } else {
      pushTo(ids, rec.year, rec.id);
    }
  }
  const missing = missingIds.length;
  const counts = new Map<number, number>();
  for (const [y, list] of ids) counts.set(y, list.length);

  const years = Array.from(counts.keys()).sort((a, b) => a - b);
  const minYear = years.length ? years[0]! : null;
  const maxYear = years.length ? years[years.length - 1]! : null;

  const buckets: YearBucket[] = [];
  if (minYear !== null && maxYear !== null) {
    if (fillGaps) {
      for (let y = minYear; y <= maxYear; y++) {
        buckets.push({
          year: y,
          count: counts.get(y) || 0,
          itemIds: ids.get(y) || [],
        });
      }
    } else {
      for (const y of years) {
        buckets.push({ year: y, count: counts.get(y)!, itemIds: ids.get(y)! });
      }
    }
  }
  if (missing > 0)
    buckets.push({ year: null, count: missing, itemIds: missingIds });

  return { buckets, minYear, maxYear, missing, total };
}

/* ----------------------------------------------------------------------------
 * 4. Top sources
 * ------------------------------------------------------------------------- */

/**
 * Count items by source (container title). Source matching is case-sensitive;
 * an empty source counts toward `missing`. Entries are ranked by count desc,
 * tie-broken alphabetically by name (deterministic), then sliced to topN.
 * `total` is the number of distinct non-empty sources before truncation.
 */
export function buildTopSources(
  records: ItemRecord[],
  topN: number,
): TopSourcesData {
  // Group spelling variants ("Nature" / "NATURE" / "Nature."), then label each
  // group with its most frequent spelling.
  const groups = new Map<
    string,
    { ids: number[]; spellings: Map<string, number> }
  >();
  let missing = 0;

  for (const rec of records) {
    const src = (rec.source || "").replace(/\s+/g, " ").trim();
    if (!src) {
      missing++;
      continue;
    }
    const key = sourceKey(src);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ids: [], spellings: new Map() }));
    g.ids.push(rec.id);
    g.spellings.set(src, (g.spellings.get(src) || 0) + 1);
  }

  const all: SourceEntry[] = Array.from(groups.values()).map((g) => ({
    name: mostFrequent(g.spellings),
    count: g.ids.length,
    itemIds: g.ids,
  }));
  all.sort(
    (a, b) =>
      b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const total = all.length;
  const entries = topN > 0 ? all.slice(0, topN) : all;
  return { entries, total, missing };
}

/** Matching key for a source title: case, accents, "&"/"and", punctuation folded. */
export function sourceKey(src: string): string {
  return foldText(src)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ----------------------------------------------------------------------------
 * 5. Top authors by item count
 * ------------------------------------------------------------------------- */

/**
 * Rank authors by number of items they appear on (using the same normalization
 * / paperCount logic as the co-authorship network), tie-broken by label then
 * key for determinism, then slice to topN.
 */
export function buildTopAuthors(
  records: ItemRecord[],
  topN: number,
): TopAuthorsData {
  const { paperCount, labelByKey, idsByKey } = buildAuthorIndex(records);

  const all: AuthorCountEntry[] = Array.from(paperCount.entries()).map(
    ([key, count]) => ({
      key,
      label: labelByKey.get(key) || key,
      count,
      itemIds: idsByKey.get(key) || [],
    }),
  );
  all.sort(
    (a, b) =>
      b.count - a.count ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const totalAuthors = all.length;
  const entries = topN > 0 ? all.slice(0, topN) : all;
  return { entries, totalAuthors };
}

/* ----------------------------------------------------------------------------
 * 6. Item-type & collection composition
 * ------------------------------------------------------------------------- */

/**
 * Build the composition dataset: items grouped by item type (localized via the
 * injected `typeLabel` fn) and by collection (named via the injected `collName`
 * fn). Collections beyond the top `topCollections` are aggregated into a single
 * "__other" segment. `uncategorized` counts items in zero collections.
 *
 * typeLabel / collName are injected so this function (and the whole file) has no
 * Zotero dependency.
 */
export function buildComposition(
  records: ItemRecord[],
  typeLabel: (t: string) => string,
  collName: (id: number) => string,
  topCollections = 8,
): CompositionData {
  const typeIds = new Map<string, number[]>();
  const collIds = new Map<number, number[]>();
  const uncategorizedIds: number[] = [];
  const total = records.length;

  for (const rec of records) {
    pushTo(typeIds, rec.itemType || "document", rec.id);

    const cols = rec.collections || [];
    if (cols.length === 0) {
      uncategorizedIds.push(rec.id);
    } else {
      for (const id of new Set(cols)) pushTo(collIds, id, rec.id);
    }
  }

  const byType: CompositionSegment[] = Array.from(typeIds.entries())
    .map(([key, list]) => ({
      key,
      label: safeLabel(typeLabel, key, key),
      count: list.length,
      itemIds: list,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );

  const rankedColls = Array.from(collIds.entries())
    .map(([id, list]) => ({ id, count: list.length, ids: list }))
    .sort((a, b) => b.count - a.count || a.id - b.id);

  const byCollection: CompositionSegment[] = [];
  const head =
    topCollections > 0 ? rankedColls.slice(0, topCollections) : rankedColls;
  for (const { id, count, ids } of head) {
    byCollection.push({
      key: `c:${id}`,
      label: safeLabel(collName, id, `Collection ${id}`),
      count,
      itemIds: ids,
    });
  }
  if (topCollections > 0 && rankedColls.length > topCollections) {
    // Items, not memberships: an item in two tail collections counts once.
    const tailIds = new Set<number>();
    for (const c of rankedColls.slice(topCollections)) {
      for (const id of c.ids) tailIds.add(id);
    }
    if (tailIds.size > 0) {
      byCollection.push({
        key: OTHER_COLLECTION_KEY,
        label: "Other collections",
        count: tailIds.size,
        itemIds: Array.from(tailIds),
      });
    }
  }

  return {
    byType,
    byCollection,
    uncategorized: uncategorizedIds.length,
    uncategorizedIds,
    total,
  };
}

/** Call an injected label fn defensively, falling back on error / empty. */
function safeLabel<T>(
  fn: (v: T) => string,
  value: T,
  fallback: string,
): string {
  try {
    const out = fn(value);
    if (out) return String(out);
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Append `value` to the list at `key`, creating the list on first use. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The most frequent key of a tally (first seen wins ties). */
/** Name particles ignored when comparing compound names. */
const NAME_PARTICLES = new Set([
  "de",
  "da",
  "das",
  "do",
  "dos",
  "di",
  "del",
  "della",
  "der",
  "den",
  "van",
  "von",
  "la",
  "le",
  "du",
  "e",
  "y",
  "bin",
  "al",
]);

/**
 * Group name-word sets that belong to one person (see makeAuthorResolver) and
 * map each word set to the base key used for the whole group: the base key
 * seen most often across its spellings.
 */
function joinNameForms(
  basesByWords: Map<string, Map<string, number>>,
): Map<string, string> {
  const keys = Array.from(basesByWords.keys());
  const sets = new Map(keys.map((k) => [k, new Set(k.split(" "))]));
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  // Index by word so only spellings sharing a word are compared.
  const byWord = new Map<string, string[]>();
  for (const k of keys) for (const w of sets.get(k)!) pushTo(byWord, w, k);
  for (const k of keys) {
    const mine = sets.get(k)!;
    const first = Array.from(mine).sort(
      (a, b) => byWord.get(a)!.length - byWord.get(b)!.length,
    )[0]!;
    const supersets = byWord
      .get(first)!
      .filter((o) => o !== k && sets.get(o)!.size > mine.size)
      .filter((o) => Array.from(mine).every((w) => sets.get(o)!.has(w)));
    if (!supersets.length) continue;
    // Join only when the longer spellings are one chain (each contained in
    // the longest), i.e. they describe one person.
    const longest = supersets.reduce((a, b) =>
      sets.get(a)!.size >= sets.get(b)!.size ? a : b,
    );
    const L = sets.get(longest)!;
    if (
      !supersets.every((o) => Array.from(sets.get(o)!).every((w) => L.has(w)))
    )
      continue;
    parent.set(find(k), find(longest));
  }
  const tallyByRoot = new Map<string, Map<string, number>>();
  for (const k of keys) {
    const root = find(k);
    let t = tallyByRoot.get(root);
    if (!t) tallyByRoot.set(root, (t = new Map()));
    for (const [base, n] of basesByWords.get(k)!)
      t.set(base, (t.get(base) || 0) + n);
  }
  const out = new Map<string, string>();
  for (const k of keys) {
    const t = tallyByRoot.get(find(k))!;
    if (t.size > 1) out.set(k, mostFrequent(t));
  }
  return out;
}

function mostFrequent(tally: Map<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [k, n] of tally) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** Lower-case and strip accents ("Müller" -> "muller"), for matching only. */
export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
