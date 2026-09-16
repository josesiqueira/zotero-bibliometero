import { assert } from "chai";
import { buildComposition } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Composition drill-down invariant (regression guard for the "nothing happens"
 * bug on the Composition donut's item-TYPE ring).
 *
 * THE BUG (now fixed): the "Composition" donut has two rings: item-TYPE slices
 * and COLLECTION slices, plus an aggregated "Other" collection segment and an
 * "Uncategorized" wedge. Clicking an item-TYPE slice used to silently do nothing
 * (a timing bug in the reveal path). THE FIX
 * (src/modules/insights/charts/compositionChart.ts -> onArcClick): item-type
 * slices now resolve the EXACT item set by matching live items whose `itemType`
 * equals the slice key, then filtering the library to exactly those items
 * (revealItems). Collection slices (key "c:<id>") navigate to that collection
 * (openCollection). The "Other" aggregate (key "__other") matches no live type,
 * so it is an intentional NO-OP. The "Uncategorized" wedge (key "__uncategorized",
 * added only in the chart layer) is likewise not a real type and never reveals.
 *
 * CORE INVARIANT under test: the item-TYPE drill-down set for type T equals
 * EXACTLY the set of items the aggregation counted into the byType segment for T
 * (buildComposition). buildComposition byType segments carry { key, label, count }
 * where `key` is the RAW item type (e.g. "journalArticle"), which is exactly what
 * onArcClick compares each live item's `it.itemType` against.
 *
 * Because buildComposition returns only { key, label, count } per segment (no
 * ids), we assert the invariant at the RECORD level. A pure local helper
 * `idsForType` mirrors the resolver predicate exactly:
 *   idsForType(records, T) = ids of records whose (itemType || "document") === T.
 * The "|| document" default is REPLICATED from buildComposition (which counts a
 * record under `rec.itemType || "document"`), so a record with a missing / blank
 * itemType still satisfies the invariant.
 *
 * The COLLECTION ring is a navigation (openCollection), not an id-set, so for the
 * collection side we assert the COUNT semantics that drive it: an item in
 * collections [1,2] is counted in BOTH collection 1 and collection 2 (overlap);
 * duplicate ids within one item are de-duplicated (the `seen` set) so an item
 * listed in collection 1 twice counts once; items in zero collections feed
 * `uncategorized`; and the long-tail "__other" aggregate (past `topCollections`)
 * is the SUM of the tail counts and is a drill-down NO-OP.
 *
 * NOTE: the live reveal / openCollection behavior (actually selecting rows or
 * navigating the pane) is exercised by the live harness; this pure file asserts
 * the COUNTS and the resolver ROUTING logic conceptually.
 *
 * typeLabel / collName are injected (Zotero-free); we pass identity-ish stubs
 * matching test/composition.test.ts:
 *   typeLabel = (t)  => t
 *   collName  = (id) => "C" + id
 *
 * SCENARIO MATRIX
 *  1. byType basics: count == drill-down id-set length for many types; single
 *     type; empty set; the regression (a real type never drills down to empty).
 *  2. Type-key EXACTNESS: "journalArticle" must not match "journalArticleX" or
 *     "conferencePaper"; raw keys are case-sensitive ("Book" != "book").
 *  3. Disjoint partition: each item has exactly one itemType, so type id-sets are
 *     pairwise disjoint and partition the whole record set.
 *  4. Default-to-"document": a record with missing / blank itemType is counted
 *     under "document" (replicated in idsForType), and that segment drills down
 *     exactly.
 *  5. byCollection overlap: an item in [1,2] counts in BOTH; uncategorized counts
 *     items in zero collections; duplicate ids within one item de-duplicated.
 *  6. topCollections slicing: head segments keep exact counts; the long tail
 *     collapses to "__other" = tail sum; "__other" appears ONLY past the
 *     threshold and is a no-op key.
 *  7. Ordering / determinism: byType is count desc then label tie-break;
 *     byCollection is count desc then id; identical inputs -> identical output.
 *  8. Empty record set: empty byType / byCollection, uncategorized 0, total 0
 *     (no divide-by-zero downstream).
 */

let nextId = 1;
/**
 * Inline ItemRecord fixture. `itemType` is the raw type the byType segment keys
 * on; `collections` are the raw collection ids (may repeat, may be empty).
 */
function rec(itemType: string, collections: number[] = []): ItemRecord {
  return {
    id: nextId++,
    title: "P",
    itemType,
    creators: [],
    year: 2020,
    source: "",
    collections,
  };
}

const typeLabel = (t: string) => t;
const collName = (id: number) => "C" + id;

/** Sentinel key for the aggregated long tail; mirror of aggregate.ts. */
const OTHER_KEY = "__other";

/**
 * Pure mirror of the item-TYPE drill-down resolver predicate in
 * compositionChart.ts -> onArcClick. For a live item the resolver matches
 * `it.itemType === key`. buildComposition counts each record under
 * `rec.itemType || "document"`, so to keep the record-level invariant exact we
 * replicate that SAME default here. (onArcClick only ever sees keys that came
 * from byType, so a blank-typed record reaches the chart as type "document" on
 * both sides.)
 */
function idsForType(records: ItemRecord[], typeKey: string): number[] {
  return records
    .filter((r) => (r.itemType || "document") === typeKey)
    .map((r) => r.id);
}

/** True when an array of numbers has no duplicate values. */
function noDuplicates(ids: number[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * Assert the full byType partition invariant for a record set: every byType
 * segment's exact id-set length equals its count, id-sets are duplicate-free and
 * pairwise disjoint, and the union of all segment id-sets covers every record
 * exactly once (every record has exactly one type, so there is no "missing"
 * bucket on the type ring).
 */
function assertTypePartition(records: ItemRecord[]): void {
  const data = buildComposition(records, typeLabel, collName);
  const seen = new Set<number>();

  for (const seg of data.byType) {
    const ids = idsForType(records, seg.key);
    // Invariant 1: aggregation count equals exact drill-down id-set size.
    assert.strictEqual(
      ids.length,
      seg.count,
      `count mismatch for type "${seg.key}" (the "nothing happens" bug class)`,
    );
    // Regression: a real type must never resolve to an empty selection.
    if (seg.count > 0) {
      assert.isAbove(
        ids.length,
        0,
        `type "${seg.key}" had items but drilled down to nothing`,
      );
    }
    // Invariant 2: no duplicate ids inside a single type's selection.
    assert.isTrue(noDuplicates(ids), `duplicate ids for "${seg.key}"`);
    // Invariant 3: disjointness across distinct types.
    for (const id of ids) {
      assert.isFalse(seen.has(id), `id ${id} claimed by two types`);
      seen.add(id);
    }
  }

  // Invariant 4: every record is claimed by exactly one type segment.
  assert.strictEqual(
    seen.size,
    records.length,
    "byType segments must partition every record exactly once",
  );
  assert.strictEqual(data.total, records.length, "total equals record count");
}

describe("composition item-type drill-down invariant (idsForType matches buildComposition.byType)", function () {
  it("1a. basic: count equals drill-down id-set length for many types", function () {
    const records = [
      rec("journalArticle"),
      rec("journalArticle"),
      rec("journalArticle"),
      rec("book"),
      rec("book"),
      rec("conferencePaper"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    for (const seg of data.byType) {
      assert.strictEqual(idsForType(records, seg.key).length, seg.count);
    }
    assert.strictEqual(idsForType(records, "journalArticle").length, 3);
    assert.strictEqual(idsForType(records, "book").length, 2);
    assert.strictEqual(idsForType(records, "conferencePaper").length, 1);
    assertTypePartition(records);
  });

  it("1b. single type: every item drills down through the one segment", function () {
    const records = [rec("book"), rec("book"), rec("book")];
    const data = buildComposition(records, typeLabel, collName);
    assert.lengthOf(data.byType, 1);
    assert.strictEqual(data.byType[0].key, "book");
    assert.strictEqual(data.byType[0].count, 3);
    assert.strictEqual(idsForType(records, "book").length, 3);
    assertTypePartition(records);
  });

  it("1c. regression: a type with real items never drills down to empty", function () {
    // The original bug made the click a no-op even though the slice had items.
    const records = [rec("thesis"), rec("thesis")];
    const data = buildComposition(records, typeLabel, collName);
    const seg = data.byType.find((s) => s.key === "thesis")!;
    assert.strictEqual(seg.count, 2);
    assert.isAbove(
      idsForType(records, "thesis").length,
      0,
      "thesis slice must resolve to its 2 items, not nothing",
    );
    assert.strictEqual(idsForType(records, "thesis").length, seg.count);
  });

  it("2a. exactness: 'journalArticle' does not match 'journalArticleX'", function () {
    const records = [
      rec("journalArticle"),
      rec("journalArticle"),
      rec("journalArticleX"), // a different (super-string) type
    ];
    const ids = idsForType(records, "journalArticle");
    assert.lengthOf(ids, 2, "only exact-type items, never the super-string type");
    const data = buildComposition(records, typeLabel, collName);
    assert.strictEqual(
      data.byType.find((s) => s.key === "journalArticle")!.count,
      2,
      "slice count and drill-down agree; no over-match",
    );
    assert.strictEqual(idsForType(records, "journalArticleX").length, 1);
    assertTypePartition(records);
  });

  it("2b. exactness: distinct types never bleed into each other", function () {
    const records = [
      rec("journalArticle"),
      rec("conferencePaper"),
      rec("conferencePaper"),
    ];
    const ja = idsForType(records, "journalArticle");
    const cp = idsForType(records, "conferencePaper");
    assert.lengthOf(ja, 1);
    assert.lengthOf(cp, 2);
    assert.lengthOf(
      ja.filter((id) => cp.includes(id)),
      0,
      "journalArticle and conferencePaper share no ids",
    );
    assertTypePartition(records);
  });

  it("2c. case sensitivity: raw keys are case-sensitive ('Book' != 'book')", function () {
    const records = [rec("book"), rec("book"), rec("Book")];
    const data = buildComposition(records, typeLabel, collName);
    const keys = data.byType.map((s) => s.key).sort();
    assert.deepEqual(keys, ["Book", "book"], "case makes distinct type keys");
    assert.strictEqual(idsForType(records, "book").length, 2);
    assert.strictEqual(idsForType(records, "Book").length, 1);
    // Cross-case must not leak.
    const lower = idsForType(records, "book");
    const upper = idsForType(records, "Book");
    assert.lengthOf(
      lower.filter((id) => upper.includes(id)),
      0,
      "case-distinct types share no ids",
    );
    assertTypePartition(records);
  });

  it("3. disjoint partition: each item has exactly one type, sets partition the whole", function () {
    const records = [
      rec("journalArticle"),
      rec("journalArticle"),
      rec("book"),
      rec("conferencePaper"),
      rec("thesis"),
      rec("report"),
      rec("report"),
      rec("report"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    const allSelected: number[] = [];
    for (const seg of data.byType) {
      const ids = idsForType(records, seg.key);
      assert.isTrue(noDuplicates(ids), `dupes in ${seg.key}`);
      allSelected.push(...ids);
    }
    assert.isTrue(noDuplicates(allSelected), "no id selected by two types");
    assert.strictEqual(
      allSelected.length,
      records.length,
      "exact partition: every record claimed once",
    );
    assertTypePartition(records);
  });

  it("4a. default-to-document: a record with blank itemType counts under 'document'", function () {
    // buildComposition counts under (rec.itemType || "document").
    const records = [
      rec(""), // blank type -> "document"
      rec("journalArticle"),
      rec("journalArticle"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    const doc = data.byType.find((s) => s.key === "document");
    assert.ok(doc, "blank-typed record produces a 'document' segment");
    assert.strictEqual(doc!.count, 1);
    // The replicated default makes the record-level invariant hold.
    assert.strictEqual(idsForType(records, "document").length, 1);
    assertTypePartition(records);
  });

  it("4b. default-to-document: blank-typed records aggregate with real 'document' items", function () {
    const records = [
      rec(""), // -> "document"
      rec("document"), // already "document"
      rec("book"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    const doc = data.byType.find((s) => s.key === "document")!;
    assert.strictEqual(doc.count, 2, "blank and explicit 'document' merge");
    assert.strictEqual(idsForType(records, "document").length, 2);
    assertTypePartition(records);
  });

  it("5a. byCollection overlap: an item in [1,2] is counted in BOTH collections", function () {
    const data = buildComposition(
      [rec("journalArticle", [1, 2])],
      typeLabel,
      collName,
    );
    const c1 = data.byCollection.find((s) => s.key === "c:1");
    const c2 = data.byCollection.find((s) => s.key === "c:2");
    assert.ok(c1 && c2, "both collections present");
    assert.strictEqual(c1!.count, 1, "counted in collection 1");
    assert.strictEqual(c2!.count, 1, "counted in collection 2 as well");
    assert.strictEqual(c1!.label, "C1", "label via collName stub");
    assert.strictEqual(data.uncategorized, 0);
  });

  it("5b. uncategorized: items in zero collections feed `uncategorized`, not a segment", function () {
    const data = buildComposition(
      [rec("journalArticle", []), rec("book", []), rec("book", [7])],
      typeLabel,
      collName,
    );
    assert.strictEqual(data.uncategorized, 2, "two items have no collections");
    assert.lengthOf(data.byCollection, 1, "only collection 7 produces a segment");
    assert.strictEqual(data.byCollection[0].key, "c:7");
    assert.strictEqual(data.byCollection[0].count, 1);
  });

  it("5c. de-dup: an item listed in collection 1 twice counts once (the `seen` set)", function () {
    const data = buildComposition(
      [rec("journalArticle", [1, 1, 1])],
      typeLabel,
      collName,
    );
    const c1 = data.byCollection.find((s) => s.key === "c:1")!;
    assert.strictEqual(c1.count, 1, "duplicate ids within one item are de-duplicated");
    assert.lengthOf(data.byCollection, 1);
    assert.strictEqual(data.uncategorized, 0);
  });

  it("5d. de-dup with overlap: [1,1,2] counts collection 1 once and collection 2 once", function () {
    const data = buildComposition(
      [rec("journalArticle", [1, 1, 2]), rec("book", [1])],
      typeLabel,
      collName,
    );
    const c1 = data.byCollection.find((s) => s.key === "c:1")!;
    const c2 = data.byCollection.find((s) => s.key === "c:2")!;
    assert.strictEqual(c1.count, 2, "two distinct items in collection 1");
    assert.strictEqual(c2.count, 1, "one item in collection 2 (dup id ignored)");
  });

  it("5e. collection routing is conceptual: keys carry 'c:<id>' for openCollection", function () {
    // The resolver routes a "c:<id>" key to openCollection(id); it is a
    // navigation, not an id-set. We assert the key SHAPE the resolver parses,
    // and that parseInt(key.slice(2)) recovers the collection id.
    const data = buildComposition(
      [rec("journalArticle", [42])],
      typeLabel,
      collName,
    );
    const seg = data.byCollection[0];
    assert.strictEqual(seg.key, "c:42");
    assert.isTrue(seg.key.startsWith("c:"), "collection keys are routed by 'c:' prefix");
    assert.strictEqual(parseInt(seg.key.slice(2), 10), 42, "id recoverable from key");
  });

  it("6a. topCollections slicing: long tail collapses to '__other' = tail sum", function () {
    // topCollections=2: keep the two highest, fold the rest into "__other".
    // Counts by collection: 1->4, 2->3, 3->2, 4->1 (long tail = {3,4} = 3).
    const records: ItemRecord[] = [];
    for (let i = 0; i < 4; i++) records.push(rec("journalArticle", [1]));
    for (let i = 0; i < 3; i++) records.push(rec("journalArticle", [2]));
    for (let i = 0; i < 2; i++) records.push(rec("journalArticle", [3]));
    records.push(rec("journalArticle", [4]));

    const data = buildComposition(records, typeLabel, collName, 2);
    const head = data.byCollection.filter((s) => s.key !== OTHER_KEY);
    assert.deepEqual(
      head.map((s) => [s.key, s.count]),
      [
        ["c:1", 4],
        ["c:2", 3],
      ],
      "head keeps the two highest collections with exact counts",
    );
    const other = data.byCollection.find((s) => s.key === OTHER_KEY)!;
    assert.ok(other, "'__other' segment is produced past the threshold");
    assert.strictEqual(other.label, "Other");
    assert.strictEqual(other.count, 3, "'__other' equals the tail sum (2 + 1)");
  });

  it("6b. '__other' appears ONLY past the topCollections threshold", function () {
    // Exactly topCollections distinct collections: no tail, no "__other".
    const records = [
      rec("journalArticle", [1]),
      rec("journalArticle", [2]),
    ];
    const data = buildComposition(records, typeLabel, collName, 2);
    assert.isUndefined(
      data.byCollection.find((s) => s.key === OTHER_KEY),
      "no '__other' when distinct collections <= topCollections",
    );
    assert.lengthOf(data.byCollection, 2);
  });

  it("6c. '__other' is a drill-down NO-OP (matches no real type, has no 'c:' prefix)", function () {
    const records: ItemRecord[] = [];
    for (let i = 0; i < 3; i++) records.push(rec("journalArticle", [1]));
    records.push(rec("journalArticle", [2]));
    records.push(rec("journalArticle", [3]));
    const data = buildComposition(records, typeLabel, collName, 1);
    const other = data.byCollection.find((s) => s.key === OTHER_KEY)!;
    assert.ok(other);
    // Routing model: onArcClick treats "c:"-prefixed keys as openCollection and
    // any other non-type key as an itemType match. "__other" is neither a real
    // itemType nor "c:"-prefixed, so the reveal selection is empty: a no-op.
    assert.isFalse(other.key.startsWith("c:"), "'__other' is not a collection route");
    assert.lengthOf(
      idsForType(records, other.key),
      0,
      "'__other' matches no live item type, so reveal selects nothing",
    );
  });

  it("6d. topCollections=0 (or large): never slices, no '__other'", function () {
    const records = [
      rec("journalArticle", [1]),
      rec("journalArticle", [2]),
      rec("journalArticle", [3]),
    ];
    const data = buildComposition(records, typeLabel, collName, 0);
    assert.isUndefined(
      data.byCollection.find((s) => s.key === OTHER_KEY),
      "topCollections=0 means no head slice and no '__other' aggregate",
    );
    assert.lengthOf(data.byCollection, 3, "all collections kept");
  });

  it("7a. byType ordering: count desc, then label tie-break", function () {
    // book and report both count 2; "book" < "report" so book comes first.
    const records = [
      rec("journalArticle"),
      rec("journalArticle"),
      rec("journalArticle"),
      rec("report"),
      rec("report"),
      rec("book"),
      rec("book"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    assert.deepEqual(
      data.byType.map((s) => [s.key, s.count]),
      [
        ["journalArticle", 3],
        ["book", 2],
        ["report", 2],
      ],
      "count desc, then alphabetical label tie-break",
    );
  });

  it("7b. byCollection ordering: count desc, then id ascending", function () {
    // collections 5 and 9 both count 1; lower id (5) comes first.
    const records = [
      rec("journalArticle", [3]),
      rec("journalArticle", [3]),
      rec("journalArticle", [9]),
      rec("journalArticle", [5]),
    ];
    const data = buildComposition(records, typeLabel, collName);
    assert.deepEqual(
      data.byCollection.map((s) => [s.key, s.count]),
      [
        ["c:3", 2],
        ["c:5", 1],
        ["c:9", 1],
      ],
      "count desc, then id ascending tie-break",
    );
  });

  it("7c. determinism: identical inputs yield identical output", function () {
    const make = (): ItemRecord[] => [
      rec("journalArticle", [1, 2]),
      rec("book", [2]),
      rec("book", []),
      rec("conferencePaper", [3, 3]),
    ];
    const a = buildComposition(make(), typeLabel, collName);
    const b = buildComposition(make(), typeLabel, collName);
    assert.deepEqual(
      a.byType.map((s) => [s.key, s.count]),
      b.byType.map((s) => [s.key, s.count]),
      "byType is deterministic",
    );
    assert.deepEqual(
      a.byCollection.map((s) => [s.key, s.count]),
      b.byCollection.map((s) => [s.key, s.count]),
      "byCollection is deterministic",
    );
    assert.strictEqual(a.uncategorized, b.uncategorized);
    assert.strictEqual(a.total, b.total);
  });

  it("8a. empty input: empty byType / byCollection, uncategorized 0, total 0", function () {
    const data = buildComposition([], typeLabel, collName);
    assert.lengthOf(data.byType, 0);
    assert.lengthOf(data.byCollection, 0);
    assert.strictEqual(data.uncategorized, 0);
    assert.strictEqual(data.total, 0);
    // No divide-by-zero downstream: a consumer guards on total before dividing.
    const safePct = data.total === 0 ? 0 : 100 / data.total;
    assert.strictEqual(safePct, 0);
    assertTypePartition([]);
  });

  it("8b. percentage math against a non-zero total stays well-defined", function () {
    const records = [
      rec("journalArticle"),
      rec("journalArticle"),
      rec("journalArticle"),
      rec("book"),
    ];
    const data = buildComposition(records, typeLabel, collName);
    assert.strictEqual(data.total, 4);
    const ja = data.byType.find((s) => s.key === "journalArticle")!;
    assert.strictEqual((ja.count / data.total) * 100, 75);
    assert.strictEqual(idsForType(records, "journalArticle").length, ja.count);
  });
});
