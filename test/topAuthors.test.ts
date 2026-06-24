import { assert } from "chai";
import { buildTopAuthors } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Top-authors-by-item-count ranking (buildTopAuthors).
 *
 * An author is counted once per paper (never twice if duplicated within one
 * item). Entries are ranked by count desc with a deterministic tie-break (label
 * then key). Institutional / single-field creators are a single keyed node.
 * Empty input yields no entries.
 */

let nextId = 1;
function paper(
  authors: Array<{ firstName?: string; lastName?: string; name?: string }>,
): ItemRecord {
  return {
    id: nextId++,
    title: "P",
    itemType: "journalArticle",
    creators: authors,
    year: 2020,
    source: "",
    collections: [],
  };
}

function A(last: string, first: string) {
  return { firstName: first, lastName: last };
}

describe("buildTopAuthors", function () {
  it("counts an author once per paper and ranks by count desc", function () {
    const data = buildTopAuthors(
      [
        paper([A("Smith", "John"), A("Doe", "Jane")]),
        paper([A("Smith", "John")]),
        paper([A("Smith", "John"), A("Roe", "Rita")]),
      ],
      0,
    );
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 3);
    assert.strictEqual(data.entries[0].key, "smith|j", "highest count first");
    assert.strictEqual(data.totalAuthors, 3);
  });

  it("counts an author once even if duplicated within a single item", function () {
    const data = buildTopAuthors(
      [paper([A("Smith", "John"), { firstName: "J.", lastName: "Smith" }])],
      0,
    );
    const smith = data.entries.find((e) => e.key === "smith|j");
    assert.ok(smith);
    assert.strictEqual(smith!.count, 1, "intra-item dedup -> counted once");
  });

  it("breaks ties deterministically by label then key", function () {
    // Three authors each on exactly one paper -> tie on count.
    const data = buildTopAuthors(
      [paper([A("Banks", "Bo"), A("Adams", "Al"), A("Carter", "Cy")])],
      0,
    );
    assert.deepEqual(
      data.entries.map((e) => e.label),
      ["Adams, A.", "Banks, B.", "Carter, C."],
      "equal counts -> alphabetical by label",
    );
  });

  it("represents an institutional creator as one node", function () {
    const data = buildTopAuthors(
      [
        paper([{ name: "World Health Organization" }]),
        paper([{ name: "World Health Organization" }]),
      ],
      0,
    );
    assert.lengthOf(data.entries, 1);
    assert.strictEqual(data.entries[0].key, "n:world health organization");
    assert.strictEqual(data.entries[0].count, 2);
  });

  it("slices to top-N", function () {
    const data = buildTopAuthors(
      [
        paper([A("Aa", "A")]),
        paper([A("Aa", "A")]),
        paper([A("Bb", "B")]),
        paper([A("Cc", "C")]),
      ],
      1,
    );
    assert.lengthOf(data.entries, 1);
    assert.strictEqual(data.entries[0].key, "aa|a");
    assert.strictEqual(data.totalAuthors, 3, "totalAuthors counts pre-slice");
  });

  it("empty input -> no entries", function () {
    const data = buildTopAuthors([], 5);
    assert.lengthOf(data.entries, 0);
    assert.strictEqual(data.totalAuthors, 0);
  });
});
