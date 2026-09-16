import { assert } from "chai";
import { buildPerYear } from "../src/modules/insights/data/aggregate.ts";
import { parseYearFromString } from "../src/modules/insights/data/extract.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Year drill-down regression suite (the "2024 bar must not surface a 2025 item"
 * bug).
 *
 * BACKGROUND
 * The "Publications per year" chart histograms items by an exact parsed year
 * (buildPerYear groups by rec.year). Clicking a year bar USED to run a fuzzy
 * Zotero quick-search on the year STRING (e.g. "2024"), which also matched the
 * digits in titles, access dates, DOIs, etc., so clicking 2024 could surface a
 * 2025-published item. The fix (pubYearsChart.ts -> onBarClick) re-parses each
 * live item with the SAME parseYear() the aggregation uses and keeps only items
 * whose parsed year equals the clicked year exactly.
 *
 * CORE INVARIANT
 * For year Y the drill-down selects EXACTLY the items the aggregation counted
 * into the Y bucket. Clicking Y must NEVER include an item whose parsed year is
 * not exactly Y.
 *
 * TWO TEST LAYERS
 *   1. INVARIANT layer (record-level): buildPerYear buckets carry {year, count}
 *      but no ids. A local idsForYear() mirrors the drill-down predicate
 *      (r.year === year). We assert, across many fixtures, that for every
 *      NON-null bucket the selected id set size equals the bucket count; that
 *      zero-count gap-filled buckets select the EMPTY set; that null/missing
 *      items are never selected by any numeric year; and that the per-year sets
 *      are pairwise DISJOINT and (all years + missing) partition every record.
 *   2. PARSER layer (string-level, the real leak source): the pure
 *      parseYearFromString proves a 2025 item parses to 2025 and so can never
 *      fall into the 2024 drill-down.
 *
 * SCENARIO MATRIX
 *   parseYearFromString:
 *     - ISO / slashed / bare:  "2024-03-14", "2024/03", "2024" -> 2024.
 *     - Leading-year preference for ranges: "2024-2025" -> 2024 (leading wins),
 *       so a range item lands in exactly one bucket.
 *     - Embedded year: "Accessed 2024, published 1999" -> 2024 (no leading
 *       4-digit run, so the FIRST plausible run wins, which is 2024 here).
 *     - Clamp bounds: 1500 and 2199 valid; 1499 and 2200 rejected; "0999",
 *       "2200", "12345" -> null per the clamp + first-plausible-run rule.
 *     - Junk / empty: "", "   ", "n.d.", "forthcoming" -> null.
 *     - Two-item leak: one record parses 2024, one 2025; neither leaks into the
 *       other's drill-down.
 *   buildPerYear / drill-down:
 *     - Mixed years with gaps: gap-filled zero buckets select an empty set.
 *     - All-missing: no numeric buckets; missing count correct; no numeric year
 *       selects anything.
 *     - Single year; single record; empty record set.
 *     - Determinism; min/max year reporting.
 *     - Disjointness + full partition across a large mixed fixture.
 *
 * WRITING STYLE: no em dashes or en dashes anywhere (ranges use "to").
 */

/* ----------------------------------------------------------------------------
 * Fixtures + helpers
 * ------------------------------------------------------------------------- */

/** Build an ItemRecord whose year is the ALREADY-parsed value (number|null). */
function rec(id: number, year: number | null, title = "P" + id): ItemRecord {
  return {
    id,
    title,
    itemType: "journalArticle",
    creators: [],
    year,
    source: "",
    collections: [],
  };
}

/**
 * Mirror of the drill-down predicate in pubYearsChart.onBarClick: the items the
 * year bar resolves are exactly those whose parsed year equals the clicked year.
 * In records, rec.year is already the parsed year, so the predicate is equality.
 */
function idsForYear(records: ItemRecord[], year: number): number[] {
  return records.filter((r) => r.year === year).map((r) => r.id);
}

/** All NON-null bucket years from a buildPerYear result. */
function numericBucketYears(
  data: ReturnType<typeof buildPerYear>,
): number[] {
  return data.buckets
    .filter((b) => b.year !== null)
    .map((b) => b.year as number);
}

/* ----------------------------------------------------------------------------
 * PARSER LAYER: parseYearFromString (the real source of the leak)
 * ------------------------------------------------------------------------- */

describe("parseYearFromString (drill-down year resolution)", function () {
  it("parses an ISO date '2024-03-14' to 2024", function () {
    assert.strictEqual(parseYearFromString("2024-03-14"), 2024);
  });

  it("parses a slashed date '2024/03' to 2024", function () {
    assert.strictEqual(parseYearFromString("2024/03"), 2024);
  });

  it("parses a bare year '2024' to 2024", function () {
    assert.strictEqual(parseYearFromString("2024"), 2024);
  });

  it("prefers the LEADING year in a range '2024-2025' (range lands in one bucket)", function () {
    // The leading four-digit rule fires first, so a "2024-2025" range item is
    // counted under 2024 only and never double-counted under 2025.
    assert.strictEqual(parseYearFromString("2024-2025"), 2024);
  });

  it("with no leading year, takes the FIRST plausible run: 'Accessed 2024, published 1999' -> 2024", function () {
    // The string does not start with four digits, so the leading rule misses
    // and the first plausible 1500..2199 run wins. Here that run is 2024 (it
    // appears before 1999), so the embedded-year item lands in the 2024 bucket.
    assert.strictEqual(
      parseYearFromString("Accessed 2024, published 1999"),
      2024,
    );
  });

  it("takes the first plausible run even when an earlier run is out of range: 'rev 1300, pub 1987' -> 1987", function () {
    // 1300 is below MIN_YEAR (1500) so it is skipped; the next run 1987 wins.
    assert.strictEqual(parseYearFromString("rev 1300, pub 1987"), 1987);
  });

  it("accepts the lower clamp bound 1500", function () {
    assert.strictEqual(parseYearFromString("1500"), 1500);
  });

  it("accepts the upper clamp bound 2199", function () {
    assert.strictEqual(parseYearFromString("2199"), 2199);
  });

  it("rejects 1499 (just below the lower bound)", function () {
    assert.isNull(parseYearFromString("1499"));
  });

  it("rejects 2200 (just above the upper bound)", function () {
    assert.isNull(parseYearFromString("2200"));
  });

  it("rejects '0999' (below the lower bound, no other run)", function () {
    assert.isNull(parseYearFromString("0999"));
  });

  it("rejects '12345' (its leading and only four-digit run 1234 is below the lower bound)", function () {
    // Leading match is "1234" -> clamp null; the global scan's first match is
    // also "1234" at index 0, and the trailing "5" is too short to form a run.
    assert.isNull(parseYearFromString("12345"));
  });

  it("returns null for empty string", function () {
    assert.isNull(parseYearFromString(""));
  });

  it("returns null for whitespace-only string", function () {
    assert.isNull(parseYearFromString("   "));
  });

  it("returns null for 'n.d.'", function () {
    assert.isNull(parseYearFromString("n.d."));
  });

  it("returns null for 'forthcoming'", function () {
    assert.isNull(parseYearFromString("forthcoming"));
  });

  it("a 2025 item parses to 2025 and so can never fall into the 2024 drill-down", function () {
    // This is the exact bug: the digits "2024" might appear elsewhere on a 2025
    // item, but the parsed publication year is 2025, so equality drill-down on
    // 2024 excludes it.
    assert.strictEqual(parseYearFromString("2025-01-02"), 2025);
    assert.notStrictEqual(parseYearFromString("2025-01-02"), 2024);
  });
});

/* ----------------------------------------------------------------------------
 * INVARIANT LAYER: drill-down id set == bucket the aggregation counted
 * ------------------------------------------------------------------------- */

describe("drill-down invariant: idsForYear matches buildPerYear buckets", function () {
  it("two-item leak regression: clicking 2024 excludes the 2025 item and vice versa", function () {
    // r1 publishes in 2024, r2 in 2025 (even if "2024" appears in r2's title).
    const records = [
      rec(1, 2024, "Survey 2024"),
      rec(2, 2025, "A 2024 retrospective published in 2025"),
    ];
    assert.deepEqual(idsForYear(records, 2024), [1]);
    assert.deepEqual(idsForYear(records, 2025), [2]);
    assert.notInclude(idsForYear(records, 2024), 2, "no 2025 item under 2024");
    assert.notInclude(idsForYear(records, 2025), 1, "no 2024 item under 2025");
  });

  it("for every non-null bucket, the drill-down id-set size equals the bucket count (no gaps)", function () {
    const records = [
      rec(1, 2020),
      rec(2, 2020),
      rec(3, 2021),
      rec(4, 2023),
      rec(5, 2023),
      rec(6, 2023),
    ];
    const data = buildPerYear(records, true);
    for (const b of data.buckets) {
      if (b.year === null) continue;
      assert.strictEqual(
        idsForYear(records, b.year).length,
        b.count,
        `bucket ${b.year} count must equal its drill-down size`,
      );
    }
  });

  it("gap-filled zero-count buckets select the EMPTY set", function () {
    // Years 2018 and 2021 present; 2019 and 2020 are zero-filled gaps.
    const records = [rec(1, 2018), rec(2, 2021)];
    const data = buildPerYear(records, true);
    assert.deepEqual(numericBucketYears(data), [2018, 2019, 2020, 2021]);
    for (const b of data.buckets) {
      if (b.year === null) continue;
      assert.strictEqual(
        idsForYear(records, b.year).length,
        b.count,
        `bucket ${b.year}`,
      );
    }
    assert.strictEqual(
      data.buckets.find((b) => b.year === 2019)!.count,
      0,
      "2019 is a zero gap",
    );
    assert.deepEqual(idsForYear(records, 2019), [], "2019 drill-down is empty");
    assert.deepEqual(idsForYear(records, 2020), [], "2020 drill-down is empty");
  });

  it("null / missing items are never selected by any numeric year", function () {
    const records = [
      rec(1, 2020),
      rec(2, null),
      rec(3, 2021),
      rec(4, null),
    ];
    const data = buildPerYear(records, true);
    const missingIds = records.filter((r) => r.year === null).map((r) => r.id);
    for (const y of numericBucketYears(data)) {
      for (const mid of missingIds) {
        assert.notInclude(
          idsForYear(records, y),
          mid,
          `missing item ${mid} must not appear under year ${y}`,
        );
      }
    }
    // The missing bucket itself is last and carries the right count.
    const last = data.buckets[data.buckets.length - 1];
    assert.isNull(last.year);
    assert.strictEqual(last.count, missingIds.length);
  });

  it("per-year drill-down sets are pairwise DISJOINT", function () {
    const records = [
      rec(1, 2019),
      rec(2, 2019),
      rec(3, 2020),
      rec(4, 2021),
      rec(5, 2021),
      rec(6, null),
    ];
    const data = buildPerYear(records, true);
    const years = numericBucketYears(data);
    for (let i = 0; i < years.length; i++) {
      for (let j = i + 1; j < years.length; j++) {
        const a = new Set(idsForYear(records, years[i]!));
        const overlap = idsForYear(records, years[j]!).filter((id) =>
          a.has(id),
        );
        assert.deepEqual(
          overlap,
          [],
          `years ${years[i]} and ${years[j]} share no items`,
        );
      }
    }
  });

  it("all numeric-year sets plus the missing set PARTITION every record exactly once", function () {
    const records = [
      rec(10, 2001),
      rec(11, 2001),
      rec(12, 2004),
      rec(13, null),
      rec(14, 2010),
      rec(15, 2010),
      rec(16, 2010),
      rec(17, null),
      rec(18, 1999),
    ];
    const data = buildPerYear(records, true);

    const seen = new Map<number, number>(); // id -> times selected
    for (const id of records.map((r) => r.id)) seen.set(id, 0);

    for (const y of numericBucketYears(data)) {
      for (const id of idsForYear(records, y)) {
        seen.set(id, (seen.get(id) || 0) + 1);
      }
    }
    // The missing set covers the rest.
    for (const id of records.filter((r) => r.year === null).map((r) => r.id)) {
      seen.set(id, (seen.get(id) || 0) + 1);
    }

    for (const [id, times] of seen) {
      assert.strictEqual(
        times,
        1,
        `record ${id} must be selected by exactly one bucket (years + missing)`,
      );
    }
    // The bucket counts themselves must also sum to total.
    const sum = data.buckets.reduce((s, b) => s + b.count, 0);
    assert.strictEqual(sum, records.length);
    assert.strictEqual(data.total, records.length);
  });
});

/* ----------------------------------------------------------------------------
 * buildPerYear shape scenarios relevant to the drill-down
 * ------------------------------------------------------------------------- */

describe("buildPerYear shapes feeding the year drill-down", function () {
  it("all-missing fixture: no numeric buckets and no numeric year selects anything", function () {
    const records = [rec(1, null), rec(2, null), rec(3, null)];
    const data = buildPerYear(records, true);
    assert.deepEqual(numericBucketYears(data), [], "no numeric buckets");
    assert.strictEqual(data.missing, 3);
    assert.strictEqual(data.total, 3);
    assert.isNull(data.minYear);
    assert.isNull(data.maxYear);
    // Probe a few arbitrary years: nothing is selectable.
    for (const y of [1999, 2020, 2024, 2199]) {
      assert.deepEqual(idsForYear(records, y), [], `year ${y} selects nothing`);
    }
    // The only bucket is the missing bucket.
    assert.lengthOf(data.buckets, 1);
    assert.isNull(data.buckets[0]!.year);
  });

  it("single year, multiple records: one bucket, drill-down returns all ids", function () {
    const records = [rec(1, 2022), rec(2, 2022), rec(3, 2022)];
    const data = buildPerYear(records, true);
    assert.deepEqual(numericBucketYears(data), [2022]);
    assert.strictEqual(data.buckets[0]!.count, 3);
    assert.deepEqual(idsForYear(records, 2022), [1, 2, 3]);
    assert.strictEqual(data.minYear, 2022);
    assert.strictEqual(data.maxYear, 2022);
  });

  it("single record: exactly one selectable bucket", function () {
    const records = [rec(7, 2015)];
    const data = buildPerYear(records, true);
    assert.deepEqual(numericBucketYears(data), [2015]);
    assert.deepEqual(idsForYear(records, 2015), [7]);
    assert.strictEqual(data.total, 1);
    assert.strictEqual(data.missing, 0);
  });

  it("empty record set: no buckets, no selectable year", function () {
    const records: ItemRecord[] = [];
    const data = buildPerYear(records, true);
    assert.lengthOf(data.buckets, 0);
    assert.isNull(data.minYear);
    assert.isNull(data.maxYear);
    assert.strictEqual(data.total, 0);
    assert.deepEqual(idsForYear(records, 2020), []);
  });

  it("min/max year reporting reflects the observed numeric years", function () {
    const records = [rec(1, 2008), rec(2, 2012), rec(3, null), rec(4, 1995)];
    const data = buildPerYear(records, true);
    assert.strictEqual(data.minYear, 1995);
    assert.strictEqual(data.maxYear, 2012);
  });

  it("is deterministic: same input yields identical buckets and drill-down sets", function () {
    const make = () => [
      rec(1, 2020),
      rec(2, 2018),
      rec(3, 2020),
      rec(4, null),
      rec(5, 2019),
    ];
    const a = buildPerYear(make(), true);
    const b = buildPerYear(make(), true);
    assert.deepEqual(a, b, "identical aggregation");
    assert.deepEqual(
      idsForYear(make(), 2020),
      idsForYear(make(), 2020),
      "identical drill-down",
    );
  });

  it("large mixed fixture: every non-null bucket count equals its drill-down size and the boundary years 1500/2199 are clickable", function () {
    const records: ItemRecord[] = [];
    let id = 1;
    // A spread of years including the clamp boundaries plus some nulls.
    const years: Array<number | null> = [
      1500, 1500, 1999, 1999, 1999, 2000, 2005, 2005, null, 2010, 2024, 2024,
      2025, null, 2199,
    ];
    for (const y of years) records.push(rec(id++, y));

    const data = buildPerYear(records, true);
    for (const b of data.buckets) {
      if (b.year === null) continue;
      assert.strictEqual(
        idsForYear(records, b.year).length,
        b.count,
        `bucket ${b.year}`,
      );
    }
    // Boundary years actually carry items and are therefore real (clickable).
    assert.strictEqual(idsForYear(records, 1500).length, 2);
    assert.strictEqual(idsForYear(records, 2199).length, 1);
    // The 2024 click never surfaces the 2025 item.
    assert.notInclude(
      idsForYear(records, 2024),
      records.find((r) => r.year === 2025)!.id,
    );
    assert.strictEqual(data.minYear, 1500);
    assert.strictEqual(data.maxYear, 2199);
    assert.strictEqual(data.missing, 2);
    assert.strictEqual(data.total, records.length);
  });
});
