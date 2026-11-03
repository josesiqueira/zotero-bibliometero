import { assert } from "chai";
import { buildBipartite } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Author<->paper bipartite graph (buildBipartite).
 *
 * One node per paper, one per normalized author ("author:" + key); every edge is
 * paper -> author. Items appear only through a shown author, so a paper with
 * no usable creators is not drawn. In a larger scope only repeat authors (2+
 * items) are shown. Empty input yields an empty graph.
 */

function paper(
  id: number,
  authors: Array<{ firstName?: string; lastName?: string; name?: string }>,
): ItemRecord {
  return {
    id,
    title: "Paper " + id,
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

describe("buildBipartite", function () {
  it("a shared author has incident degree 2 across two papers", function () {
    const shared = A("Lovelace", "Ada");
    const data = buildBipartite(
      [paper(1, [shared]), paper(2, [shared, A("Turing", "Alan")])],
      0,
    );
    assert.lengthOf(data.papers, 2);
    assert.lengthOf(data.authors, 2, "Lovelace shared, Turing solo");

    const lovelaceId = "author:lovelace|a";
    const incident = data.edges.filter((e) => e.authorId === lovelaceId);
    assert.lengthOf(incident, 2, "shared author touches both papers");
    const paperIds = incident.map((e) => e.paperId).sort();
    assert.deepEqual(paperIds, [1, 2]);
  });

  it("every edge connects a real paper id to an author id", function () {
    const data = buildBipartite([paper(7, [A("Smith", "John")])], 0);
    const paperIds = new Set(data.papers.map((p) => p.id));
    const authorIds = new Set(data.authors.map((a) => a.id));
    assert.isAbove(data.edges.length, 0);
    for (const e of data.edges) {
      assert.isTrue(
        paperIds.has(e.paperId),
        "edge paperId references a paper node",
      );
      assert.isTrue(
        authorIds.has(e.authorId),
        "edge authorId references an author node",
      );
      assert.match(e.authorId, /^author:/, "author ids are namespaced");
    }
  });

  it("a paper with no creators is not drawn", function () {
    const data = buildBipartite([paper(3, [])], 0);
    assert.lengthOf(data.papers, 0);
    assert.lengthOf(data.authors, 0);
    assert.strictEqual(data.totalPapers, 1);
  });

  it("with enough repeat authors, one-item authors are left out", function () {
    // Five repeat authors (2 items each) plus two one-item authors.
    const rs = [
      paper(1, [A("Ant", "A"), A("Bee", "B"), A("Solo", "S")]),
      paper(2, [A("Ant", "A"), A("Cat", "C")]),
      paper(3, [A("Bee", "B"), A("Dog", "D")]),
      paper(4, [A("Cat", "C"), A("Eel", "E")]),
      paper(5, [A("Dog", "D"), A("Eel", "E")]),
      paper(6, [A("Lone", "L")]),
    ];
    const data = buildBipartite(rs, 0);
    assert.strictEqual(data.minPapers, 2);
    assert.deepEqual(data.authors.map((a) => a.label).sort(), [
      "Ant, A.",
      "Bee, B.",
      "Cat, C.",
      "Dog, D.",
      "Eel, E.",
    ]);
    assert.deepEqual(
      data.papers.map((p) => p.id),
      [1, 2, 3, 4, 5],
      "item 6 has no repeat author",
    );
  });

  it("empty input -> empty graph", function () {
    const data = buildBipartite([], 0);
    assert.lengthOf(data.papers, 0);
    assert.lengthOf(data.authors, 0);
    assert.lengthOf(data.edges, 0);
    assert.isFalse(data.truncated);
    assert.strictEqual(data.totalPapers, 0);
  });
});
