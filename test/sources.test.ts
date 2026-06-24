import { assert } from "chai";
import { buildTopSources } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Top-sources ranking (buildTopSources).
 *
 * NOTE: per-item-type source-FIELD selection (journalArticle ->
 * publicationTitle, conferencePaper -> proceedingsTitle, ...) lives in
 * extract.ts which is Zotero-coupled, so it is exercised by the live harness.
 * Here `rec.source` is already the extracted container title, and we test the
 * pure RANKING logic: count desc, deterministic alphabetical tie-break, an empty
 * source counts toward `missing`, top-N slicing, and empty input.
 */

let nextId = 1;
function rec(source: string): ItemRecord {
  return {
    id: nextId++,
    title: "P",
    itemType: "journalArticle",
    creators: [],
    year: 2020,
    source,
    collections: [],
  };
}

describe("buildTopSources", function () {
  it("ranks sources by count descending", function () {
    const data = buildTopSources(
      [rec("Nature"), rec("Nature"), rec("Nature"), rec("Science"), rec("Science"), rec("Cell")],
      0,
    );
    assert.deepEqual(
      data.entries.map((e) => [e.name, e.count]),
      [
        ["Nature", 3],
        ["Science", 2],
        ["Cell", 1],
      ],
    );
    assert.strictEqual(data.total, 3, "distinct non-empty sources");
    assert.strictEqual(data.missing, 0);
  });

  it("breaks count ties alphabetically (deterministic)", function () {
    const data = buildTopSources([rec("Zeta"), rec("Alpha")], 0);
    assert.deepEqual(
      data.entries.map((e) => e.name),
      ["Alpha", "Zeta"],
      "equal counts -> alphabetical order",
    );
  });

  it("counts blank / whitespace-only sources as missing", function () {
    const data = buildTopSources([rec("Nature"), rec(""), rec("   ")], 0);
    assert.strictEqual(data.missing, 2);
    assert.strictEqual(data.total, 1);
    assert.deepEqual(data.entries.map((e) => e.name), ["Nature"]);
  });

  it("slices to top-N", function () {
    const data = buildTopSources(
      [rec("A"), rec("A"), rec("A"), rec("B"), rec("B"), rec("C")],
      2,
    );
    assert.lengthOf(data.entries, 2);
    assert.deepEqual(data.entries.map((e) => e.name), ["A", "B"]);
    assert.strictEqual(data.total, 3, "total counts pre-slice distinct sources");
  });

  it("empty input -> no entries, zero totals", function () {
    const data = buildTopSources([], 5);
    assert.lengthOf(data.entries, 0);
    assert.strictEqual(data.total, 0);
    assert.strictEqual(data.missing, 0);
  });
});
