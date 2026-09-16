import { assert } from "chai";
import { buildTopSources } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Source drill-down invariant (regression guard for the "4 vs 2" bug).
 *
 * THE BUG (now fixed): the "Top sources" chart ranks sources by an EXACT
 * container-title field. Clicking a bar used to run a FUZZY Zotero quick-search
 * on the source NAME, which over/under-matched: e.g. clicking "IEEE Access"
 * (whose bar showed 2) selected 4 items because the term also matched titles and
 * other fields. THE FIX (src/modules/insights/charts/topSourcesChart.ts ->
 * onBarClick): clicking now resolves the EXACT item set by re-matching each live
 * item with the SAME extractSource() the aggregation uses, then filtering the
 * library to exactly those items.
 *
 * CORE INVARIANT under test: the set of items the drill-down selects for a
 * source S equals EXACTLY the set of items the aggregation counted into S.
 *
 * Because buildTopSources returns only { name, count } per entry (no ids), we
 * assert the invariant at the RECORD level. `rec.source` is the ALREADY-extracted
 * container title (a plain string), so a pure local helper `idsForSource` mirrors
 * the drill-down resolver predicate exactly:
 *   idsForSource(records, S) = ids of records whose (source||"").trim() === S.
 * buildTopSources groups by the SAME (source||"").trim(), case-SENSITIVE, blanks
 * to `missing`. So for every entry returned, idsForSource(name).length must equal
 * entry.count, and the union of all entry id-sets plus `missing` must partition
 * the whole record set (no overlaps, no leftovers).
 *
 * SCENARIO MATRIX
 *  1. Basic: aggregation count == drill-down id-set length for several sources.
 *  2. Case sensitivity: "IEEE Access" vs "ieee access" stay distinct (no merge).
 *  3. Whitespace: leading/trailing trimmed; internal whitespace preserved, so
 *     "IEEE  Access" (double space) is its OWN group, not merged with single.
 *  4. Substring traps (heart of the bug): a source never pulls in items whose
 *     source is a different (super/sub)string, nor items whose TITLE contains the
 *     term. Only exact `source` equality matches.
 *  5. Blank / whitespace-only -> `missing`, never selectable by any bar.
 *  6. Punctuation / unicode names (ampersands, accents), and names that are
 *     substrings of others ("Computer" vs "IEEE Computer").
 *  7. topN slicing: a long-tail source past the slice still has a correct exact
 *     id-set (drill-down works for any entry, not just visible rows).
 *  8. Duplicate / disjointness guards: each id-set has no duplicates; sets for
 *     distinct sources are disjoint; the partition is exact.
 *  9. Edge cases: empty record set, single record, all-blank records.
 * 10. Determinism: same inputs -> identical entries and order.
 * 11. Field-priority notes: extractSource() per-type field priority is documented
 *     conceptually below (it is Zotero-coupled and exercised by the live harness);
 *     this pure file does NOT call extractSource with a live item.
 *
 * FIELD-PRIORITY NOTES (from src/modules/insights/data/extract.ts SOURCE_FIELDS,
 * documented here as scenario notes only, NOT executed in this pure file because
 * extractSource() needs a live Zotero.Item):
 *   journalArticle  -> ["publicationTitle"]
 *   conferencePaper -> ["proceedingsTitle", "conferenceName", "publicationTitle"]
 *   bookSection     -> ["bookTitle", "publicationTitle"]
 *   book            -> ["publisher", "series"]
 *   report          -> ["institution", "publisher"]
 *   thesis          -> ["university", "publisher"]
 *   preprint        -> ["repository", "publicationTitle"]
 *   webpage/blogPost-> ["websiteTitle", "publicationTitle", "blogTitle"]
 *   default         -> ["publicationTitle", "publisher"]
 * The first non-empty field wins; the chosen value (trimmed) becomes rec.source.
 * Since the drill-down re-runs the SAME extractSource() over live items, the
 * record-level invariant proved here is exactly the property the fix relies on.
 */

let nextId = 1;
/**
 * Inline ItemRecord fixture. `source` is the already-extracted container title;
 * `title` is included so substring-trap tests can prove the drill-down never
 * matches on title text.
 */
function rec(source: string, title = "P", itemType = "journalArticle"): ItemRecord {
  return {
    id: nextId++,
    title,
    itemType,
    creators: [],
    year: 2020,
    source,
    collections: [],
  };
}

/**
 * Pure mirror of the drill-down resolver predicate in
 * topSourcesChart.ts -> onBarClick. For a live item the resolver computes
 * extractSource(it).trim() === target; here rec.source is the pre-extracted
 * value, so the equivalent is (r.source||"").trim() === name. This is the SAME
 * key buildTopSources groups by, which is exactly why the counts must agree.
 */
function idsForSource(records: ItemRecord[], name: string): number[] {
  return records
    .filter((r) => (r.source || "").trim() === name)
    .map((r) => r.id);
}

/** True when an array of numbers has no duplicate values. */
function noDuplicates(ids: number[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * Assert the full partition invariant for a record set: every entry's exact
 * id-set length equals its count, id-sets are duplicate-free and pairwise
 * disjoint, and the union of all entry id-sets plus the `missing` items covers
 * every record exactly once.
 */
function assertPartition(records: ItemRecord[]): void {
  const data = buildTopSources(records, 0); // topN=0 => all entries, no slicing
  const seen = new Set<number>();

  for (const entry of data.entries) {
    const ids = idsForSource(records, entry.name);
    // Invariant 1: aggregation count equals exact drill-down id-set size.
    assert.strictEqual(
      ids.length,
      entry.count,
      `count mismatch for source "${entry.name}" (the "4 vs 2" bug class)`,
    );
    // Invariant 2: no duplicate ids inside a single source's selection.
    assert.isTrue(noDuplicates(ids), `duplicate ids for "${entry.name}"`);
    // Invariant 3: disjointness across distinct sources.
    for (const id of ids) {
      assert.isFalse(seen.has(id), `id ${id} claimed by two sources`);
      seen.add(id);
    }
  }

  // Invariant 4: the union of all entry id-sets plus `missing` partitions the
  // whole record set with no overlaps and no leftovers.
  const blankCount = records.filter((r) => !(r.source || "").trim()).length;
  assert.strictEqual(data.missing, blankCount, "missing equals blank-source count");
  assert.strictEqual(
    seen.size + data.missing,
    records.length,
    "entries + missing must cover every record exactly once",
  );
}

describe("source drill-down invariant (idsForSource matches buildTopSources)", function () {
  it("1. basic: count equals drill-down id-set length for several sources", function () {
    const records = [
      rec("Nature"),
      rec("Nature"),
      rec("Nature"),
      rec("Science"),
      rec("Science"),
      rec("Cell"),
    ];
    const data = buildTopSources(records, 0);
    for (const entry of data.entries) {
      assert.strictEqual(idsForSource(records, entry.name).length, entry.count);
    }
    assert.strictEqual(idsForSource(records, "Nature").length, 3);
    assert.strictEqual(idsForSource(records, "Science").length, 2);
    assert.strictEqual(idsForSource(records, "Cell").length, 1);
    assertPartition(records);
  });

  it("2. case sensitivity: 'IEEE Access' and 'ieee access' are distinct, not merged", function () {
    const records = [
      rec("IEEE Access"),
      rec("IEEE Access"),
      rec("ieee access"),
    ];
    const data = buildTopSources(records, 0);
    const names = data.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["IEEE Access", "ieee access"]);
    assert.strictEqual(idsForSource(records, "IEEE Access").length, 2);
    assert.strictEqual(idsForSource(records, "ieee access").length, 1);
    // Cross-case must not leak.
    const upperIds = idsForSource(records, "IEEE Access");
    const lowerIds = idsForSource(records, "ieee access");
    assert.lengthOf(
      upperIds.filter((id) => lowerIds.includes(id)),
      0,
      "case-distinct sources share no ids",
    );
    assertPartition(records);
  });

  it("3a. whitespace: leading/trailing spaces are trimmed before grouping", function () {
    const records = [rec("  Nature  "), rec("Nature"), rec("Nature ")];
    const data = buildTopSources(records, 0);
    assert.lengthOf(data.entries, 1, "all three trim to the same source");
    assert.strictEqual(data.entries[0].name, "Nature");
    assert.strictEqual(idsForSource(records, "Nature").length, 3);
    assertPartition(records);
  });

  it("3b. whitespace: internal double space is its OWN group, not merged with single", function () {
    const records = [
      rec("IEEE  Access"), // double internal space
      rec("IEEE  Access"),
      rec("IEEE Access"), // single internal space
    ];
    const data = buildTopSources(records, 0);
    const byName = new Map(data.entries.map((e) => [e.name, e.count]));
    assert.strictEqual(byName.get("IEEE  Access"), 2, "double-space group kept distinct");
    assert.strictEqual(byName.get("IEEE Access"), 1, "single-space group kept distinct");
    assert.strictEqual(idsForSource(records, "IEEE  Access").length, 2);
    assert.strictEqual(idsForSource(records, "IEEE Access").length, 1);
    assertPartition(records);
  });

  it("4a. substring trap: 'IEEE Access' does not pull in 'IEEE/CAA Journal of Automatica Sinica'", function () {
    const records = [
      rec("IEEE Access"),
      rec("IEEE Access"),
      rec("IEEE/CAA Journal of Automatica Sinica"),
      rec("IEEE/CAA Journal of Automatica Sinica"),
    ];
    const ids = idsForSource(records, "IEEE Access");
    assert.lengthOf(ids, 2, "only exact-source items, never the other IEEE journal");
    const data = buildTopSources(records, 0);
    assert.strictEqual(
      data.entries.find((e) => e.name === "IEEE Access")!.count,
      2,
      "bar count and drill-down agree (the original failure was 4 vs 2)",
    );
    assertPartition(records);
  });

  it("4b. substring trap: a source never matches items whose TITLE contains the term", function () {
    const records = [
      rec("IEEE Access", "Deep learning"),
      rec("IEEE Access", "Graph theory"),
      // Different source, but the term "IEEE Access" appears in the TITLE.
      rec("Some Other Journal", "A survey published in IEEE Access proceedings"),
      rec("Some Other Journal", "IEEE Access: a retrospective"),
    ];
    const ids = idsForSource(records, "IEEE Access");
    assert.lengthOf(ids, 2, "title text must never be matched by source drill-down");
    // The title-only items belong to their actual source, not to "IEEE Access".
    assert.lengthOf(idsForSource(records, "Some Other Journal"), 2);
    assertPartition(records);
  });

  it("4c. substring trap: shorter source is not a prefix-match for a longer one", function () {
    const records = [
      rec("Computer"),
      rec("Computer"),
      rec("IEEE Computer"),
      rec("Computer Networks"),
    ];
    assert.strictEqual(idsForSource(records, "Computer").length, 2);
    assert.strictEqual(idsForSource(records, "IEEE Computer").length, 1);
    assert.strictEqual(idsForSource(records, "Computer Networks").length, 1);
    // "Computer" must not absorb "IEEE Computer" or "Computer Networks".
    const computerIds = idsForSource(records, "Computer");
    assert.notInclude(computerIds, idsForSource(records, "IEEE Computer")[0]);
    assert.notInclude(computerIds, idsForSource(records, "Computer Networks")[0]);
    assertPartition(records);
  });

  it("5. blank / whitespace-only sources go to `missing` and no bar can select them", function () {
    const records = [
      rec("Nature"),
      rec(""),
      rec("   "),
      rec("\t  \n"),
    ];
    const data = buildTopSources(records, 0);
    assert.strictEqual(data.missing, 3);
    assert.lengthOf(data.entries, 1);
    assert.strictEqual(data.entries[0].name, "Nature");
    // No entry name is blank, so the resolver is never invoked with "": a blank
    // source can only ever be a `missing` item, never a clickable bar.
    assert.isTrue(
      data.entries.every((e) => e.name.trim() !== ""),
      "no chart entry has a blank name (blanks are missing, not bars)",
    );
    assertPartition(records);
  });

  it("6a. punctuation / unicode: ampersand and accented names group exactly", function () {
    const records = [
      rec("AI & SOCIETY"),
      rec("AI & SOCIETY"),
      rec("Crítica"),
      rec("Crítica"),
      rec("Critica"), // unaccented is a DIFFERENT source
    ];
    const data = buildTopSources(records, 0);
    const byName = new Map(data.entries.map((e) => [e.name, e.count]));
    assert.strictEqual(byName.get("AI & SOCIETY"), 2);
    assert.strictEqual(byName.get("Crítica"), 2);
    assert.strictEqual(byName.get("Critica"), 1, "accent makes a distinct group");
    assert.strictEqual(idsForSource(records, "AI & SOCIETY").length, 2);
    assert.strictEqual(idsForSource(records, "Crítica").length, 2);
    assert.strictEqual(idsForSource(records, "Critica").length, 1);
    assertPartition(records);
  });

  it("6b. names that are substrings of others stay disjoint", function () {
    const records = [
      rec("Cell"),
      rec("Cell"),
      rec("Cell Reports"),
      rec("Molecular Cell"),
    ];
    const cellIds = idsForSource(records, "Cell");
    assert.lengthOf(cellIds, 2);
    assert.lengthOf(idsForSource(records, "Cell Reports"), 1);
    assert.lengthOf(idsForSource(records, "Molecular Cell"), 1);
    assertPartition(records);
  });

  it("7. topN slicing: a long-tail source past the slice still drills down exactly", function () {
    // Build many sources with descending counts so a clear long tail exists.
    const records: ItemRecord[] = [];
    // Head sources (high counts).
    for (let i = 0; i < 5; i++) records.push(rec("Head A"));
    for (let i = 0; i < 4; i++) records.push(rec("Head B"));
    for (let i = 0; i < 3; i++) records.push(rec("Head C"));
    // Long-tail source with count 2, well past a topN=2 slice.
    records.push(rec("Tail Journal"));
    records.push(rec("Tail Journal"));

    const sliced = buildTopSources(records, 2);
    assert.lengthOf(sliced.entries, 2, "only top 2 entries are visible");
    assert.deepEqual(
      sliced.entries.map((e) => e.name),
      ["Head A", "Head B"],
    );
    assert.isAbove(sliced.total, sliced.entries.length, "footer would show '+N more'");
    // The hidden long-tail source is NOT a visible bar...
    assert.isUndefined(sliced.entries.find((e) => e.name === "Tail Journal"));
    // ...yet the drill-down resolver still resolves it exactly (count 2).
    assert.strictEqual(
      idsForSource(records, "Tail Journal").length,
      2,
      "drill-down works for any source, not just visible rows",
    );
    // And the full (unsliced) aggregation agrees with the drill-down everywhere.
    assertPartition(records);
  });

  it("8. disjointness & dedupe: across many sources every id is claimed exactly once", function () {
    const records = [
      rec("Nature"),
      rec("Nature"),
      rec("Science"),
      rec("Cell"),
      rec("Cell"),
      rec("Cell"),
      rec(""),
      rec("   "),
      rec("PNAS"),
    ];
    const data = buildTopSources(records, 0);
    const allSelected: number[] = [];
    for (const entry of data.entries) {
      const ids = idsForSource(records, entry.name);
      assert.isTrue(noDuplicates(ids), `dupes in ${entry.name}`);
      allSelected.push(...ids);
    }
    assert.isTrue(noDuplicates(allSelected), "no id selected by two sources");
    assert.strictEqual(
      allSelected.length + data.missing,
      records.length,
      "exact partition: selected + missing == total",
    );
    assertPartition(records);
  });

  it("9a. empty record set: no entries, nothing to drill down", function () {
    const records: ItemRecord[] = [];
    const data = buildTopSources(records, 0);
    assert.lengthOf(data.entries, 0);
    assert.strictEqual(data.total, 0);
    assert.strictEqual(data.missing, 0);
    assertPartition(records);
  });

  it("9b. single record: one source, exact single-item selection", function () {
    const records = [rec("Solo Journal")];
    const data = buildTopSources(records, 0);
    assert.lengthOf(data.entries, 1);
    assert.strictEqual(data.entries[0].count, 1);
    assert.lengthOf(idsForSource(records, "Solo Journal"), 1);
    assertPartition(records);
  });

  it("9c. all-blank records: zero entries, all counted as missing", function () {
    const records = [rec(""), rec("   "), rec("\t\n")];
    const data = buildTopSources(records, 0);
    assert.lengthOf(data.entries, 0);
    assert.strictEqual(data.missing, 3);
    assert.strictEqual(data.total, 0);
    assertPartition(records);
  });

  it("10. determinism: identical inputs yield identical entries and order", function () {
    const make = (): ItemRecord[] => {
      // Reset id counter region irrelevant; structure/order is what matters.
      return [
        rec("Zeta"),
        rec("Alpha"),
        rec("Alpha"),
        rec("Mu"),
        rec("Mu"),
      ];
    };
    const a = buildTopSources(make(), 0);
    const b = buildTopSources(make(), 0);
    assert.deepEqual(
      a.entries.map((e) => [e.name, e.count]),
      b.entries.map((e) => [e.name, e.count]),
      "same shape -> same ranked entries and order",
    );
    // Count-then-alphabetical: Alpha(2), Mu(2) before Zeta(1); Alpha before Mu.
    assert.deepEqual(
      a.entries.map((e) => e.name),
      ["Alpha", "Mu", "Zeta"],
    );
  });

  it("11. field-priority is mirrored by the same extractSource on both sides (conceptual)", function () {
    // extractSource() is Zotero-coupled and exercised by the live harness, so we
    // do not call it here. Conceptually: aggregation and drill-down BOTH compute
    // rec.source via the SAME extractSource(), so whatever field priority picks
    // (e.g. conferencePaper -> proceedingsTitle before publicationTitle), the two
    // sides resolve the identical container title for a given item. We model that
    // shared resolution by using a single pre-extracted rec.source value and
    // proving both sides agree on it.
    const records = [
      // Pretend extractSource already resolved a conferencePaper to its
      // proceedingsTitle for both the bar and the drill-down.
      rec("Proc. of NeurIPS", "A paper", "conferencePaper"),
      rec("Proc. of NeurIPS", "Another paper", "conferencePaper"),
      // A journalArticle resolved to its publicationTitle.
      rec("Proc. of NeurIPS", "Journal piece that mentions NeurIPS", "journalArticle"),
    ];
    // All three share the SAME extracted source string, regardless of itemType,
    // so they group together and the drill-down selects all three.
    const data = buildTopSources(records, 0);
    assert.lengthOf(data.entries, 1);
    assert.strictEqual(data.entries[0].name, "Proc. of NeurIPS");
    assert.strictEqual(data.entries[0].count, 3);
    assert.strictEqual(idsForSource(records, "Proc. of NeurIPS").length, 3);
    assertPartition(records);
  });
});
