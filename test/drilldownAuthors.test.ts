import { assert } from "chai";
import {
  normalizeCreators,
  buildTopAuthors,
} from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Top-authors drill-down invariant (regression for the blank-list bug).
 *
 * THE BUG (now fixed): clicking a "Top authors" bar used to run a fuzzy Zotero
 * quick-search on the DISPLAY LABEL ("Pan, S."). Zotero's creator search does
 * not understand the "Last, F." rendering, so the drill-down returned a BLANK
 * list even though the bar had a real count.
 *
 * THE FIX: clicking now resolves the EXACT item set by re-deriving each live
 * item's normalized author keys with the SAME normalizeCreators() the
 * aggregation uses (topAuthorsChart.ts -> onBarClick -> normalizeCreators(
 * toRecord(it)).some(k => k.key === authorKey)). The list shown is therefore in
 * lock-step with the bar's count.
 *
 * CORE INVARIANT under test: for every author key K, the set of items the
 * drill-down selects equals exactly the set of items the aggregation counted
 * into K. We mirror the resolver predicate at the RECORD level (buildTopAuthors
 * returns counts but no ids) with idsForAuthor() below, then assert across many
 * fixtures that idsForAuthor(records, K).length === buildTopAuthors count for K.
 *
 * Everything here is PURE: each fixture is a plain ItemRecord built inline, no
 * Zotero binary is involved (toRecord is the identity for our purposes since the
 * resolver normalizes the same record the aggregation does).
 *
 * SCENARIO MATRIX:
 *  1. Regression: a "Last, F." style author yields a NON-empty exact set.
 *  2. Merge: "John Smith" + "J. Smith" -> one key, drill-down returns BOTH.
 *  3. Distinct initials: "John" vs "Jane" share key; "Adam" splits.
 *  4. Last-only vs initialed: "Smith" (smith|) vs "Smith, J." (smith|j) split.
 *  5. Institutional / single-field: keyed on whole name, case-insensitive key,
 *     label verbatim, exact match.
 *  6. Co-authorship overlap: a 3-author paper sits in all 3 author sets; counts
 *     stay exact and id-sets OVERLAP (no disjointness asserted).
 *  7. Intra-item duplicate author counted once (id appears once, not twice).
 *  8. Long-tail authors beyond the topN slice still resolve exactly.
 *  9. Whitespace trimming; nameless creators skipped (item belongs to no set).
 * 10. Unicode / accented / hyphenated / multi-word surnames.
 * 11. Edge inputs: empty set, single record, record with zero creators.
 * 12. Determinism (two runs over the same fixtures agree).
 *
 * The whole-corpus invariant (every buildTopAuthors entry's count equals its
 * idsForAuthor set size, and a real author never resolves to an empty set) is
 * asserted in one sweep over a large mixed fixture and re-asserted per scenario.
 */

let nextId = 1;
function rec(
  creators: Array<{ firstName?: string; lastName?: string; name?: string }>,
): ItemRecord {
  return {
    id: nextId++,
    title: "P",
    itemType: "journalArticle",
    creators,
    year: 2020,
    source: "",
    collections: [],
  };
}

/** Author with structured first / last name. */
function A(last: string, first: string) {
  return { firstName: first, lastName: last };
}

/**
 * Mirror of the chart's onBarClick resolver predicate, at the record level. The
 * chart filters live items by `normalizeCreators(toRecord(it)).some(k => k.key
 * === authorKey)`; our records already are the normalized-input shape, so we run
 * the very same normalizeCreators() against them.
 */
function idsForAuthor(records: ItemRecord[], key: string): number[] {
  return records
    .filter((r) => normalizeCreators(r).some((k) => k.key === key))
    .map((r) => r.id);
}

/**
 * Sweep the CORE INVARIANT over a record set: every author key the aggregation
 * counts resolves (via the drill-down predicate) to a set of exactly that size,
 * and any author the aggregation counted at all yields a NON-empty set (the
 * direct regression for the blank-list bug).
 */
function assertDrilldownInvariant(records: ItemRecord[]): void {
  const data = buildTopAuthors(records, 0);
  for (const entry of data.entries) {
    const ids = idsForAuthor(records, entry.key);
    assert.strictEqual(
      ids.length,
      entry.count,
      `drill-down set size for "${entry.label}" (${entry.key}) must equal its bar count`,
    );
    assert.isAbove(
      ids.length,
      0,
      `author "${entry.label}" (${entry.key}) with a real count must never resolve to an empty set`,
    );
    // No id should appear twice within one author's resolved set.
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      `drill-down set for "${entry.key}" must have unique ids`,
    );
  }
}

describe("top-authors drill-down (exact item resolution)", function () {
  it("regression: a 'Last, F.' style author yields a non-empty exact set", function () {
    // "Pan, S." is exactly the label shape that broke the old quick-search.
    const records = [
      rec([A("Pan", "Shirley"), A("Doe", "Jane")]),
      rec([A("Pan", "Sam")]),
      rec([A("Roe", "Rita")]),
    ];
    const data = buildTopAuthors(records, 0);
    const pan = data.entries.find((e) => e.key === "pan|s");
    assert.ok(pan, "expected a pan|s entry");
    assert.strictEqual(pan!.label, "Pan, S.");
    assert.strictEqual(pan!.count, 2, "two papers carry a Pan with initial S");

    const ids = idsForAuthor(records, "pan|s");
    assert.lengthOf(ids, 2, "drill-down resolves a NON-empty exact set");
    assert.strictEqual(ids.length, pan!.count, "set size equals bar count");
  });

  it("merge: 'John Smith' and 'J. Smith' collapse to one key, drill-down returns BOTH items", function () {
    const full = rec([A("Smith", "John")]);
    const initialed = rec([{ firstName: "J.", lastName: "Smith" }]);
    const records = [full, initialed];

    const data = buildTopAuthors(records, 0);
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 2, "the two forms merge to one author of 2 papers");

    const ids = idsForAuthor(records, "smith|j").sort((a, b) => a - b);
    assert.deepEqual(ids, [full.id, initialed.id], "both items resolve under the merged key");
  });

  it("distinct initials: 'John' vs 'Adam' Smith resolve to different sets", function () {
    const john = rec([A("Smith", "John")]);
    const adam = rec([A("Smith", "Adam")]);
    const records = [john, adam];

    assert.deepEqual(idsForAuthor(records, "smith|j"), [john.id]);
    assert.deepEqual(idsForAuthor(records, "smith|a"), [adam.id]);
    assertDrilldownInvariant(records);
  });

  it("documented merge: 'John' and 'Jane' Smith share key smith|j (same initial)", function () {
    const john = rec([A("Smith", "John")]);
    const jane = rec([A("Smith", "Jane")]);
    const records = [john, jane];

    const data = buildTopAuthors(records, 0);
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 2, "only the first initial discriminates");
    assert.deepEqual(
      idsForAuthor(records, "smith|j").sort((a, b) => a - b),
      [john.id, jane.id].sort((a, b) => a - b),
    );
  });

  it("last-name-only vs initialed are DISTINCT keys (smith| vs smith|j)", function () {
    const bare = rec([{ lastName: "Smith" }]);
    const initialed = rec([A("Smith", "Jane")]);
    const records = [bare, initialed];

    const data = buildTopAuthors(records, 0);
    const bareEntry = data.entries.find((e) => e.key === "smith|");
    const initEntry = data.entries.find((e) => e.key === "smith|j");
    assert.ok(bareEntry, "expected a smith| (no first name) entry");
    assert.ok(initEntry, "expected a smith|j entry");
    assert.strictEqual(bareEntry!.label, "Smith");
    assert.strictEqual(initEntry!.label, "Smith, J.");

    assert.deepEqual(idsForAuthor(records, "smith|"), [bare.id]);
    assert.deepEqual(idsForAuthor(records, "smith|j"), [initialed.id]);
    assertDrilldownInvariant(records);
  });

  it("institutional / single-field creator: exact match, case-insensitive key, label verbatim", function () {
    const a = rec([{ name: "World Health Organization" }]);
    const b = rec([{ name: "World Health Organization" }]);
    const other = rec([A("Doe", "Jane")]);
    const records = [a, b, other];

    const data = buildTopAuthors(records, 0);
    const who = data.entries.find((e) => e.key === "n:world health organization");
    assert.ok(who);
    assert.strictEqual(who!.label, "World Health Organization", "label kept verbatim");
    assert.strictEqual(who!.count, 2);

    const ids = idsForAuthor(records, "n:world health organization").sort((x, y) => x - y);
    assert.deepEqual(ids, [a.id, b.id], "exact institutional match, no fuzzy spill");
    assert.notInclude(ids, other.id);
    assertDrilldownInvariant(records);
  });

  it("institutional key is case-insensitive but only matches the same normalized name", function () {
    const upper = rec([{ name: "NASA" }]);
    const lower = rec([{ name: "nasa" }]);
    const records = [upper, lower];

    const data = buildTopAuthors(records, 0);
    const nasa = data.entries.find((e) => e.key === "n:nasa");
    assert.ok(nasa);
    assert.strictEqual(nasa!.count, 2, "case folds in the key");
    assert.deepEqual(
      idsForAuthor(records, "n:nasa").sort((a, b) => a - b),
      [upper.id, lower.id].sort((a, b) => a - b),
    );
  });

  it("co-authorship overlap: a 3-author paper appears in all 3 author sets, counts exact", function () {
    const shared = rec([A("Smith", "John"), A("Doe", "Jane"), A("Roe", "Rita")]);
    const solo = rec([A("Smith", "John")]);
    const records = [shared, solo];

    const data = buildTopAuthors(records, 0);
    const smith = data.entries.find((e) => e.key === "smith|j");
    const doe = data.entries.find((e) => e.key === "doe|j");
    const roe = data.entries.find((e) => e.key === "roe|r");
    assert.strictEqual(smith!.count, 2);
    assert.strictEqual(doe!.count, 1);
    assert.strictEqual(roe!.count, 1);

    // The shared paper id is present in ALL three author sets (overlap, NOT disjoint).
    assert.include(idsForAuthor(records, "smith|j"), shared.id);
    assert.include(idsForAuthor(records, "doe|j"), shared.id);
    assert.include(idsForAuthor(records, "roe|r"), shared.id);

    assert.deepEqual(
      idsForAuthor(records, "smith|j").sort((a, b) => a - b),
      [shared.id, solo.id].sort((a, b) => a - b),
    );
    assertDrilldownInvariant(records);
  });

  it("intra-item duplicate author is counted once: id appears once in the set, not twice", function () {
    // Same author listed twice in two equivalent forms within one item.
    const dup = rec([A("Smith", "John"), { firstName: "J.", lastName: "Smith" }]);
    const records = [dup];

    const data = buildTopAuthors(records, 0);
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 1, "intra-item dedup -> counted once");

    const ids = idsForAuthor(records, "smith|j");
    assert.deepEqual(ids, [dup.id], "the item id appears exactly once");
    assertDrilldownInvariant(records);
  });

  it("long-tail authors beyond the topN slice still resolve exactly", function () {
    // One prolific author plus several single-paper long-tail authors.
    const records: ItemRecord[] = [];
    const prolific1 = rec([A("Alpha", "Al")]);
    const prolific2 = rec([A("Alpha", "Al")]);
    const prolific3 = rec([A("Alpha", "Al")]);
    records.push(prolific1, prolific2, prolific3);
    const tail: { rec: ItemRecord; key: string }[] = [];
    const surnames = ["Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
    for (const s of surnames) {
      const r = rec([A(s, "X")]);
      records.push(r);
      tail.push({ rec: r, key: `${s.toLowerCase()}|x` });
    }

    // topN = 1: only "Alpha, A." is in the sliced entries.
    const sliced = buildTopAuthors(records, 1);
    assert.lengthOf(sliced.entries, 1);
    assert.strictEqual(sliced.entries[0].key, "alpha|a");
    assert.strictEqual(sliced.totalAuthors, 8, "totalAuthors counts pre-slice");

    // A long-tail author NOT in the slice still resolves to its exact item.
    const golf = tail.find((t) => t.key === "golf|x")!;
    assert.deepEqual(idsForAuthor(records, "golf|x"), [golf.rec.id]);

    // And the full invariant holds across every author (sliced or not).
    assertDrilldownInvariant(records);
  });

  it("trims surrounding whitespace so padded and clean names resolve to one set", function () {
    const padded = rec([{ firstName: "  John  ", lastName: "  Smith  " }]);
    const clean = rec([A("Smith", "John")]);
    const records = [padded, clean];

    const data = buildTopAuthors(records, 0);
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 2, "trimmed and clean forms merge");
    assert.deepEqual(
      idsForAuthor(records, "smith|j").sort((a, b) => a - b),
      [padded.id, clean.id].sort((a, b) => a - b),
    );
  });

  it("an item with only nameless creators belongs to NO author set", function () {
    const empty = rec([{}, { firstName: "", lastName: "" }, { name: "   " }]);
    const real = rec([A("Lovelace", "Ada")]);
    const records = [empty, real];

    const data = buildTopAuthors(records, 0);
    assert.lengthOf(data.entries, 1, "only Lovelace is a counted author");
    assert.strictEqual(data.entries[0].key, "lovelace|a");

    // The nameless item id never appears in any author's drill-down set.
    assert.notInclude(idsForAuthor(records, "lovelace|a"), empty.id);
    assert.deepEqual(idsForAuthor(records, "lovelace|a"), [real.id]);
    assertDrilldownInvariant(records);
  });

  it("unicode / accented surname resolves exactly (no ascii fold)", function () {
    const a = rec([A("Müller", "Hans")]);
    const b = rec([A("Müller", "Heidi")]); // same initial -> same key
    const ascii = rec([A("Muller", "Hank")]); // different surname spelling
    const records = [a, b, ascii];

    const data = buildTopAuthors(records, 0);
    const accented = data.entries.find((e) => e.key === "müller|h");
    const plain = data.entries.find((e) => e.key === "muller|h");
    assert.ok(accented, "accented surname keeps its own key");
    assert.ok(plain, "ascii spelling is a distinct key");
    assert.strictEqual(accented!.count, 2);
    assert.strictEqual(plain!.count, 1);

    assert.deepEqual(
      idsForAuthor(records, "müller|h").sort((x, y) => x - y),
      [a.id, b.id].sort((x, y) => x - y),
    );
    assert.deepEqual(idsForAuthor(records, "muller|h"), [ascii.id]);
    assertDrilldownInvariant(records);
  });

  it("hyphenated and multi-word surnames resolve exactly", function () {
    const hyphen = rec([A("Smith-Jones", "Mary")]);
    const multiWord = rec([A("van der Berg", "Otto")]);
    const records = [hyphen, multiWord];

    const data = buildTopAuthors(records, 0);
    const sj = data.entries.find((e) => e.key === "smith-jones|m");
    const vdb = data.entries.find((e) => e.key === "van der berg|o");
    assert.ok(sj, "hyphenated surname preserved in key");
    assert.ok(vdb, "multi-word surname preserved (and lowercased) in key");
    assert.strictEqual(sj!.label, "Smith-Jones, M.");
    assert.strictEqual(vdb!.label, "van der Berg, O.");

    assert.deepEqual(idsForAuthor(records, "smith-jones|m"), [hyphen.id]);
    assert.deepEqual(idsForAuthor(records, "van der berg|o"), [multiWord.id]);
    assertDrilldownInvariant(records);
  });

  it("empty record set: no entries, drill-down of any key is empty", function () {
    const records: ItemRecord[] = [];
    const data = buildTopAuthors(records, 0);
    assert.lengthOf(data.entries, 0);
    assert.lengthOf(idsForAuthor(records, "smith|j"), 0);
    assertDrilldownInvariant(records); // vacuously true, must not throw
  });

  it("single record resolves to a singleton set", function () {
    const only = rec([A("Curie", "Marie")]);
    const records = [only];
    assert.deepEqual(idsForAuthor(records, "curie|m"), [only.id]);
    assertDrilldownInvariant(records);
  });

  it("a record with zero creators contributes to no author set", function () {
    const noAuthors = rec([]);
    const withAuthor = rec([A("Doe", "Jane")]);
    const records = [noAuthors, withAuthor];

    const data = buildTopAuthors(records, 0);
    assert.lengthOf(data.entries, 1);
    assert.notInclude(idsForAuthor(records, "doe|j"), noAuthors.id);
    assert.deepEqual(idsForAuthor(records, "doe|j"), [withAuthor.id]);
    assertDrilldownInvariant(records);
  });

  it("drill-down of a key that no item carries is empty", function () {
    const records = [rec([A("Smith", "John")])];
    assert.lengthOf(idsForAuthor(records, "nobody|z"), 0);
    assert.lengthOf(idsForAuthor(records, "n:ghost institute"), 0);
  });

  it("large mixed corpus: every bar count equals its drill-down set size", function () {
    const records: ItemRecord[] = [
      rec([A("Pan", "Shirley"), A("Doe", "Jane"), A("Roe", "Rita")]),
      rec([A("Pan", "Sam"), { name: "World Health Organization" }]),
      rec([A("Smith", "John"), { firstName: "J.", lastName: "Smith" }]), // intra-item dup
      rec([{ lastName: "Smith" }]), // smith| distinct from smith|j
      rec([A("Müller", "Hans"), A("Smith-Jones", "Mary")]),
      rec([{ name: "World Health Organization" }]),
      rec([{}, { firstName: "", lastName: "" }]), // nameless -> no author
      rec([A("Doe", "Jane")]),
      rec([A("van der Berg", "Otto"), A("Pan", "Shawn")]),
      rec([A("Alpha", "Al")]),
      rec([A("Alpha", "Al")]),
    ];
    assertDrilldownInvariant(records);

    // Spot-check a few specific overlaps and counts.
    const data = buildTopAuthors(records, 0);
    const pan = data.entries.find((e) => e.key === "pan|s");
    assert.strictEqual(pan!.count, idsForAuthor(records, "pan|s").length);
    assert.isAbove(pan!.count, 0);
  });

  it("is deterministic: two runs over the same fixtures agree on every set", function () {
    const make = (): ItemRecord[] => {
      // reset id stream so both corpora are id-identical
      nextId = 10000;
      return [
        rec([A("Smith", "John"), A("Doe", "Jane")]),
        rec([A("Smith", "John")]),
        rec([{ name: "CERN" }]),
        rec([{ name: "CERN" }]),
      ];
    };
    const first = make();
    const second = make();

    const keys = ["smith|j", "doe|j", "n:cern"];
    for (const k of keys) {
      assert.deepEqual(
        idsForAuthor(first, k).sort((a, b) => a - b),
        idsForAuthor(second, k).sort((a, b) => a - b),
        `drill-down for ${k} must be stable across runs`,
      );
    }
    assertDrilldownInvariant(first);
    assertDrilldownInvariant(second);
  });
});
