import { assert } from "chai";
import { buildComposition } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Item-type & collection composition (buildComposition).
 *
 * Item-type counts; an item in two collections is counted in BOTH; items in zero
 * collections feed the `uncategorized` bucket; `total` is the item count and is
 * used to derive percentages without dividing by zero on empty input.
 *
 * typeLabel / collName are injected (Zotero-free) — we pass identity stubs:
 *   typeLabel = (t) => t
 *   collName  = (id) => "C" + id
 */

let nextId = 1;
function rec(itemType: string, collections: number[]): ItemRecord {
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

describe("buildComposition", function () {
  it("counts items by type (ranked desc)", function () {
    const data = buildComposition(
      [
        rec("journalArticle", []),
        rec("journalArticle", []),
        rec("book", []),
      ],
      typeLabel,
      collName,
    );
    assert.deepEqual(
      data.byType.map((s) => [s.key, s.count]),
      [
        ["journalArticle", 2],
        ["book", 1],
      ],
    );
    assert.strictEqual(data.byType[0].label, "journalArticle", "label via stub");
    assert.strictEqual(data.total, 3);
  });

  it("counts an item in two collections in both", function () {
    const data = buildComposition(
      [rec("journalArticle", [10, 20])],
      typeLabel,
      collName,
    );
    const c10 = data.byCollection.find((s) => s.label === "C10");
    const c20 = data.byCollection.find((s) => s.label === "C20");
    assert.ok(c10 && c20, "both collections present");
    assert.strictEqual(c10!.count, 1);
    assert.strictEqual(c20!.count, 1);
    assert.strictEqual(data.uncategorized, 0);
  });

  it("buckets items in zero collections as uncategorized", function () {
    const data = buildComposition(
      [rec("journalArticle", []), rec("book", [5])],
      typeLabel,
      collName,
    );
    assert.strictEqual(data.uncategorized, 1);
    assert.lengthOf(data.byCollection, 1);
    assert.strictEqual(data.byCollection[0].count, 1);
  });

  it("supports percentage math against a non-zero total", function () {
    const data = buildComposition(
      [
        rec("journalArticle", []),
        rec("journalArticle", []),
        rec("journalArticle", []),
        rec("book", []),
      ],
      typeLabel,
      collName,
    );
    assert.strictEqual(data.total, 4);
    const ja = data.byType.find((s) => s.key === "journalArticle")!;
    const pct = (ja.count / data.total) * 100;
    assert.strictEqual(pct, 75);
  });

  it("empty input -> zero total and no divide-by-zero", function () {
    const data = buildComposition([], typeLabel, collName);
    assert.lengthOf(data.byType, 0);
    assert.lengthOf(data.byCollection, 0);
    assert.strictEqual(data.uncategorized, 0);
    assert.strictEqual(data.total, 0);
    // A consumer guards on total before dividing; assert the guard value is 0.
    const safePct = data.total === 0 ? 0 : 100 / data.total;
    assert.strictEqual(safePct, 0);
  });
});
