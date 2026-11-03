import { assert } from "chai";
import {
  buildTopAuthors,
  buildTopSources,
  buildComposition,
  buildPerYear,
  minPapersFor,
  sourceKey,
} from "../src/modules/insights/data/aggregate.ts";
import { louvain } from "../src/modules/insights/data/cluster.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Author identity, source matching, drill-down ids and the helpers behind the
 * network views.
 */

let nextId = 100;
function rec(over: Partial<ItemRecord>): ItemRecord {
  return {
    id: nextId++,
    title: "T",
    itemType: "journalArticle",
    creators: [],
    year: 2020,
    source: "",
    collections: [],
    ...over,
  };
}
const A = (lastName: string, firstName: string) => ({ lastName, firstName });

describe("author identity", function () {
  it("joins an initials-only form to the one full name it matches", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Floridi", "Luciano")] }),
        rec({ creators: [A("Floridi", "L.")] }),
        rec({ creators: [A("Floridi", "Luciano")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 1);
    assert.strictEqual(d.entries[0].count, 3);
    assert.strictEqual(d.entries[0].label, "Floridi, Luciano");
  });

  it("keeps different full names with the same initial apart", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Zhang", "Yi")] }),
        rec({ creators: [A("Zhang", "Yu")] }),
        rec({ creators: [A("Zhang", "Yu")] }),
        rec({ creators: [A("Zhang", "Y.")] }),
      ],
      0,
    );
    const labels = d.entries.map((e) => `${e.label}:${e.count}`).sort();
    assert.deepEqual(labels, ["Zhang, Y.:1", "Zhang, Yi:1", "Zhang, Yu:2"]);
  });

  it("folds accents and case in surnames", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Müller", "Anna")] }),
        rec({ creators: [A("MULLER", "Anna")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 1);
    assert.strictEqual(d.entries[0].count, 2);
  });

  it("joins a compound surname split differently (same name words)", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Dias Canedo", "Edna")] }),
        rec({ creators: [A("Canedo", "Edna Dias")] }),
        rec({ creators: [A("Dias Canedo", "Edna")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 1);
    assert.strictEqual(d.entries[0].count, 3);
    assert.strictEqual(d.entries[0].label, "Dias Canedo, Edna");
  });

  it("joins particle and shortened forms of one compound name", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Siqueira De Cerqueira", "José Antonio")] }),
        rec({ creators: [A("Cerqueira", "Jose Antonio Siqueira De")] }),
        rec({ creators: [A("De Cerqueira", "José Siqueira")] }),
        rec({ creators: [A("de Cerqueira", "José Siqueira")] }),
        rec({ creators: [A("Siqueira Cerqueira", "José")] }),
        rec({ creators: [A("Cerqueira", "Jose Siqueira De")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 1);
    assert.strictEqual(d.entries[0].count, 6);
  });

  it("leaves a short form alone when two longer names contain it", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Silva Santos", "Maria")] }),
        rec({ creators: [A("Silva Santos Oliveira", "Maria")] }),
        rec({ creators: [A("Silva Santos Pereira", "Maria")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 3);
  });

  it("does not join two-word names written in swapped order", function () {
    const d = buildTopAuthors(
      [
        rec({ creators: [A("Lee", "Kim")] }),
        rec({ creators: [A("Kim", "Lee")] }),
      ],
      0,
    );
    assert.lengthOf(d.entries, 2);
  });

  it("carries the item ids behind each author", function () {
    const a = rec({ creators: [A("Doe", "Jane")] });
    const b = rec({ creators: [A("Doe", "Jane")] });
    const d = buildTopAuthors([a, b], 0);
    assert.deepEqual(d.entries[0].itemIds.sort(), [a.id, b.id].sort());
  });
});

describe("sources", function () {
  it("groups spelling variants and labels with the most common one", function () {
    const d = buildTopSources(
      [
        rec({ source: "Nature" }),
        rec({ source: "Nature" }),
        rec({ source: "NATURE." }),
        rec({ source: "AI & Society" }),
        rec({ source: "AI and Society" }),
      ],
      0,
    );
    assert.deepEqual(
      d.entries.map((e) => `${e.name}:${e.count}`),
      ["Nature:3", "AI & Society:2"],
    );
    assert.strictEqual(sourceKey("  Journal of  X. "), "journal of x");
  });
});

describe("drill-down ids and honest counts", function () {
  it("year buckets carry their item ids, including no date", function () {
    const a = rec({ year: 2021 });
    const b = rec({ year: null });
    const d = buildPerYear([a, b], true);
    assert.deepEqual(d.buckets.find((x) => x.year === 2021)!.itemIds, [a.id]);
    assert.deepEqual(d.buckets.find((x) => x.year === null)!.itemIds, [b.id]);
  });

  it("'Other collections' counts items once, not memberships", function () {
    const both = rec({ collections: [1, 2] });
    const d = buildComposition(
      [rec({ collections: [3] }), rec({ collections: [3] }), both],
      (t) => t,
      (id) => "C" + id,
      1,
    );
    const other = d.byCollection.find((s) => s.key === "__other")!;
    assert.strictEqual(
      other.count,
      1,
      "an item in two tail collections counts once",
    );
    assert.deepEqual(other.itemIds, [both.id]);
  });
});

describe("network helpers", function () {
  it("minPapersFor starts at 2 and rises to respect the cap", function () {
    assert.strictEqual(minPapersFor([5, 4, 3, 2, 2, 1, 1], 0), 2);
    assert.strictEqual(minPapersFor([5, 4, 3, 2, 2, 1, 1], 3), 3);
    assert.strictEqual(
      minPapersFor([2, 1, 1, 1], 0),
      1,
      "too few repeat authors -> 1",
    );
  });

  it("louvain separates two cliques joined by one weak link", function () {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const e = (a: string, b: string, w = 3) => ({ a, b, w });
    const groups = louvain(ids, [
      e("a", "b"),
      e("b", "c"),
      e("a", "c"),
      e("d", "e"),
      e("e", "f"),
      e("d", "f"),
      e("c", "d", 1),
    ]);
    assert.strictEqual(groups.get("a"), groups.get("c"));
    assert.strictEqual(groups.get("d"), groups.get("f"));
    assert.notStrictEqual(groups.get("a"), groups.get("d"));
  });
});
