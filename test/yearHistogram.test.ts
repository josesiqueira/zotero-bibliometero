import { assert } from "chai";
import { buildPerYear } from "../src/modules/insights/data/aggregate.ts";
import { parseYearFromString } from "../src/modules/insights/data/extract.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Publications-per-year histogram (buildPerYear) plus the pure year parser
 * (parseYearFromString) that feeds rec.year.
 *
 * Year parsing: ISO "2021-03-14" -> 2021; bare "1998" -> 1998; free text yields
 * a plausible year or null; missing -> null. Histogram: a null bucket collects
 * missing/unparseable years (and is kept, not dropped) and is placed last; gap
 * filling produces zero-count years; real-year buckets are sorted ascending.
 */

function rec(id: number, year: number | null): ItemRecord {
  return {
    id,
    title: "P" + id,
    itemType: "journalArticle",
    creators: [],
    year,
    source: "",
    collections: [],
  };
}

describe("parseYearFromString", function () {
  it("extracts the year from an ISO date 2021-03-14", function () {
    assert.strictEqual(parseYearFromString("2021-03-14"), 2021);
  });

  it("parses a bare year string '1998'", function () {
    assert.strictEqual(parseYearFromString("1998"), 1998);
  });

  it("recovers a plausible year from free text", function () {
    assert.strictEqual(parseYearFromString("Published in 1987, reprinted"), 1987);
  });

  it("returns null for text with no plausible year", function () {
    assert.isNull(parseYearFromString("forthcoming"));
    assert.isNull(parseYearFromString(""));
  });

  it("rejects an out-of-range four-digit run", function () {
    // 9999 is outside the 1500..2199 clamp -> no plausible year.
    assert.isNull(parseYearFromString("9999"));
  });
});

describe("buildPerYear", function () {
  it("places the missing/null bucket last and does not drop it", function () {
    const data = buildPerYear(
      [rec(1, 2020), rec(2, null), rec(3, 2020)],
      false,
    );
    assert.strictEqual(data.missing, 1);
    assert.strictEqual(data.total, 3);
    const last = data.buckets[data.buckets.length - 1];
    assert.isNull(last.year, "null bucket is last");
    assert.strictEqual(last.count, 1, "missing items are kept, not dropped");
  });

  it("fills gaps with zero-count years and sorts ascending", function () {
    const data = buildPerYear([rec(1, 2018), rec(2, 2021)], true);
    const realYears = data.buckets.filter((b) => b.year !== null);
    assert.deepEqual(
      realYears.map((b) => b.year),
      [2018, 2019, 2020, 2021],
      "years filled and ascending",
    );
    assert.strictEqual(realYears.find((b) => b.year === 2019)!.count, 0);
    assert.strictEqual(realYears.find((b) => b.year === 2020)!.count, 0);
    assert.strictEqual(data.minYear, 2018);
    assert.strictEqual(data.maxYear, 2021);
  });

  it("without gap fill emits only observed years (still ascending, null last)", function () {
    const data = buildPerYear(
      [rec(1, 2021), rec(2, 2010), rec(3, null), rec(4, 2010)],
      false,
    );
    const realYears = data.buckets.filter((b) => b.year !== null);
    assert.deepEqual(realYears.map((b) => b.year), [2010, 2021]);
    assert.strictEqual(realYears.find((b) => b.year === 2010)!.count, 2);
    const last = data.buckets[data.buckets.length - 1];
    assert.isNull(last.year);
  });

  it("empty input -> no buckets, null min/max", function () {
    const data = buildPerYear([], true);
    assert.lengthOf(data.buckets, 0);
    assert.isNull(data.minYear);
    assert.isNull(data.maxYear);
    assert.strictEqual(data.total, 0);
    assert.strictEqual(data.missing, 0);
  });
});
