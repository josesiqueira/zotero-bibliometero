import { assert } from "chai";
import { buildCoAuthorship } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Co-authorship adjacency (buildCoAuthorship).
 *
 * One undirected edge per co-authoring pair within an item, weight = number of
 * shared papers, degree = incident edge count. Edges are canonicalised so
 * (a,b) == (b,a). Authors need a minimum number of items (2, or 1 when 2
 * would leave almost nobody), raised until at most `cap` remain; authors left
 * without links are dropped. All fixtures are plain records.
 */

let nextId = 1;
function paper(
  authors: Array<{ firstName?: string; lastName?: string; name?: string }>,
): ItemRecord {
  return {
    id: nextId++,
    title: "P" + nextId,
    itemType: "journalArticle",
    creators: authors,
    year: 2020,
    source: "",
    collections: [],
  };
}

function A(last: string, first?: string) {
  return first ? { firstName: first, lastName: last } : { lastName: last };
}

/** Look up the single edge between two author keys regardless of orientation. */
function edgeBetween(
  edges: Array<{ source: string; target: string; weight: number }>,
  a: string,
  b: string,
) {
  return edges.find(
    (e) =>
      (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
}

describe("buildCoAuthorship", function () {
  it("2 authors on 1 paper -> 1 edge of weight 1", function () {
    const data = buildCoAuthorship(
      [paper([A("Smith", "John"), A("Doe", "Jane")])],
      0,
    );
    assert.lengthOf(data.nodes, 2);
    assert.lengthOf(data.edges, 1);
    assert.strictEqual(data.edges[0].weight, 1);
    assert.isFalse(data.truncated);
    assert.strictEqual(data.totalAuthors, 2);
  });

  it("same pair across 3 papers -> one edge of weight 3", function () {
    const data = buildCoAuthorship(
      [
        paper([A("Smith", "John"), A("Doe", "Jane")]),
        paper([A("Smith", "John"), A("Doe", "Jane")]),
        paper([A("Smith", "John"), A("Doe", "Jane")]),
      ],
      0,
    );
    assert.lengthOf(data.edges, 1, "duplicate pairs collapse into one edge");
    const e = edgeBetween(data.edges, "smith|j", "doe|j");
    assert.ok(e, "edge between Smith and Doe should exist");
    assert.strictEqual(e!.weight, 3);
  });

  it("triangle (3 authors / 1 paper) -> 3 edges", function () {
    const data = buildCoAuthorship(
      [paper([A("Smith", "John"), A("Doe", "Jane"), A("Roe", "Rita")])],
      0,
    );
    assert.lengthOf(data.nodes, 3);
    assert.lengthOf(data.edges, 3);
    for (const n of data.nodes) {
      assert.strictEqual(n.degree, 2, "every triangle node has degree 2");
    }
  });

  it("an author with no co-author on the map is not drawn", function () {
    const data = buildCoAuthorship([paper([A("Solo", "Sam")])], 0);
    assert.lengthOf(
      data.nodes,
      0,
      "isolated authors say nothing about collaboration",
    );
    assert.lengthOf(data.edges, 0);
    assert.strictEqual(data.totalAuthors, 1);
  });

  it("canonicalises undirected edges (source < target)", function () {
    const data = buildCoAuthorship(
      [paper([A("Zeta", "Zed"), A("Alpha", "Ann")])],
      0,
    );
    assert.lengthOf(data.edges, 1);
    const e = data.edges[0];
    assert.isTrue(e.source < e.target, "edge endpoints stored in sorted order");
  });

  it("empty input -> empty graph", function () {
    const data = buildCoAuthorship([], 0);
    assert.lengthOf(data.nodes, 0);
    assert.lengthOf(data.edges, 0);
    assert.isFalse(data.truncated);
    assert.strictEqual(data.totalAuthors, 0);
  });

  it("raises the minimum items until at most `cap` authors remain", function () {
    // Hub has 3 items, three leaves have 1 each; X and Y share 2 items.
    // Five authors have 2+ items? No: only Hub, Xeno and Yuki do, so the base
    // threshold is 1 (fewer than 5 authors with 2+). A cap of 3 then raises it
    // to 2, which keeps Hub, Xeno and Yuki; Hub has no co-author left, so only
    // the Xeno-Yuki link is drawn.
    const data = buildCoAuthorship(
      [
        paper([A("Hub", "Henry"), A("Leaf", "Lara")]),
        paper([A("Hub", "Henry"), A("Mint", "Max")]),
        paper([A("Hub", "Henry"), A("Nile", "Nora")]),
        paper([A("Xeno", "Xander"), A("Yuki", "Yara")]),
        paper([A("Xeno", "Xander"), A("Yuki", "Yara")]),
      ],
      3,
    );
    assert.strictEqual(data.minPapers, 2);
    assert.strictEqual(data.totalAuthors, 6, "totalAuthors counts everyone");
    assert.deepEqual(data.nodes.map((n) => n.id).sort(), ["xeno|x", "yuki|y"]);
    assert.strictEqual(edgeBetween(data.edges, "xeno|x", "yuki|y")!.weight, 2);
    assert.isTrue(data.truncated);
  });

  it("items with very many authors count but add no links", function () {
    const many = Array.from({ length: 30 }, (_, i) => A("Author" + i, "A"));
    const data = buildCoAuthorship(
      [paper(many), paper([A("Doe", "Jane"), A("Roe", "Rita")])],
      0,
    );
    assert.strictEqual(data.largeTeamPapers, 1);
    assert.deepEqual(data.nodes.map((n) => n.id).sort(), ["doe|j", "roe|r"]);
  });

  it("colours research groups: two separate teams get two groups", function () {
    const team = (names: string[]) => paper(names.map((n) => A(n, "X")));
    const records = [
      team(["Ant", "Bee", "Cat"]),
      team(["Ant", "Bee", "Cat"]),
      team(["Dog", "Eel", "Fox"]),
      team(["Dog", "Eel", "Fox"]),
    ];
    const data = buildCoAuthorship(records, 0);
    assert.lengthOf(data.groups, 2);
    const g = (id: string) => data.nodes.find((n) => n.id === id)!.group;
    assert.strictEqual(g("ant|x"), g("cat|x"));
    assert.notStrictEqual(g("ant|x"), g("dog|x"));
    assert.isAtLeast(g("ant|x"), 0);
  });
});
