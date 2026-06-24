import { assert } from "chai";
import { buildCoAuthorship } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Co-authorship adjacency (buildCoAuthorship).
 *
 * One undirected edge per co-authoring pair within an item, weight = number of
 * shared papers, degree = incident edge count. Edges are canonicalised so
 * (a,b) == (b,a). A node cap keeps the top authors by paperCount and drops
 * dangling edges, marking the result truncated. All fixtures are plain records.
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
    const data = buildCoAuthorship([paper([A("Smith", "John"), A("Doe", "Jane")])], 0);
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

  it("single-author paper -> 1 node, 0 edges", function () {
    const data = buildCoAuthorship([paper([A("Solo", "Sam")])], 0);
    assert.lengthOf(data.nodes, 1);
    assert.lengthOf(data.edges, 0);
    assert.strictEqual(data.nodes[0].degree, 0);
    assert.strictEqual(data.nodes[0].paperCount, 1);
  });

  it("canonicalises undirected edges (source < target)", function () {
    const data = buildCoAuthorship([paper([A("Zeta", "Zed"), A("Alpha", "Ann")])], 0);
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

  it("cap keeps top-degree authors, drops dangling edges, and truncates", function () {
    // Hub author H co-authors with three leaves L1,L2,L3 (H appears on 3 papers
    // -> highest paperCount). A separate isolated pair X-Y on one paper. With a
    // cap of 4 we expect H + its leaves kept and X/Y dropped, so the X-Y edge is
    // pruned (no dangling edge survives).
    const data = buildCoAuthorship(
      [
        paper([A("Hub", "Henry"), A("Leaf", "Lara")]), // H + L1
        paper([A("Hub", "Henry"), A("Mint", "Max")]), // H + L2
        paper([A("Hub", "Henry"), A("Nile", "Nora")]), // H + L3
        paper([A("Xeno", "Xander"), A("Yuki", "Yara")]), // isolated pair
      ],
      4,
    );
    assert.isTrue(data.truncated, "more authors than cap -> truncated");
    assert.strictEqual(data.totalAuthors, 6, "totalAuthors counts pre-cap");
    assert.lengthOf(data.nodes, 4, "cap honoured");

    const keptKeys = new Set(data.nodes.map((n) => n.id));
    assert.isTrue(keptKeys.has("hub|h"), "highest-paperCount hub kept");

    // No edge references a dropped node.
    for (const e of data.edges) {
      assert.isTrue(
        keptKeys.has(e.source) && keptKeys.has(e.target),
        "no dangling edge to a pruned node",
      );
    }
    // The isolated X-Y pair must not survive once one of them is capped out.
    assert.isUndefined(edgeBetween(data.edges, "xeno|x", "yuki|y"));
  });
});
