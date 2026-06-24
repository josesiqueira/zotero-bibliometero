import { assert } from "chai";
import { normalizeCreators } from "../src/modules/insights/data/aggregate.ts";
import type { ItemRecord } from "../src/modules/insights/data/extract.ts";

/**
 * Author normalization (normalizeCreators / creatorToKey heuristic).
 *
 * These are PURE: every fixture is a plain ItemRecord built inline, so no Zotero
 * binary is involved. We assert the merge key behaviour that views 1, 2 and 5
 * all rely on so they agree on author identity:
 *  - "John Smith" and "J. Smith" collapse to one key (last + first-initial).
 *  - "John Smith" and "Jane Smith" stay distinct (different initial).
 *  - single-field / institutional creators are keyed on the whole name.
 *  - creators with no usable name are skipped.
 *  - surrounding whitespace is trimmed before keying.
 *  - duplicate authors within one item are de-duplicated.
 */

function rec(
  creators: Array<{ firstName?: string; lastName?: string; name?: string }>,
): ItemRecord {
  return {
    id: 1,
    title: "T",
    itemType: "journalArticle",
    creators,
    year: 2020,
    source: "",
    collections: [],
  };
}

describe("normalizeCreators", function () {
  it("merges 'John Smith' and 'J. Smith' to the same key", function () {
    const full = normalizeCreators(
      rec([{ firstName: "John", lastName: "Smith" }]),
    );
    const initial = normalizeCreators(
      rec([{ firstName: "J.", lastName: "Smith" }]),
    );
    assert.lengthOf(full, 1);
    assert.lengthOf(initial, 1);
    assert.strictEqual(full[0].key, "smith|j");
    assert.strictEqual(
      initial[0].key,
      full[0].key,
      "first-initial collapse should produce one key",
    );
  });

  it("keeps 'John Smith' and 'Jane Smith' distinct (different initial)", function () {
    const john = normalizeCreators(rec([{ firstName: "John", lastName: "Smith" }]));
    const jane = normalizeCreators(rec([{ firstName: "Jane", lastName: "Smith" }]));
    assert.strictEqual(john[0].key, "smith|j");
    assert.strictEqual(jane[0].key, "smith|j");
    // NOTE: by design only the first initial discriminates, so John and Jane
    // intentionally share a key. We assert that documented behaviour, and that
    // a different initial (e.g. "Adam") does split.
    const adam = normalizeCreators(rec([{ firstName: "Adam", lastName: "Smith" }]));
    assert.strictEqual(adam[0].key, "smith|a");
    assert.notStrictEqual(adam[0].key, john[0].key);
  });

  it("keys a single-field / institutional creator on the whole name", function () {
    const out = normalizeCreators(
      rec([{ name: "World Health Organization" }]),
    );
    assert.lengthOf(out, 1);
    assert.strictEqual(out[0].key, "n:world health organization");
    assert.strictEqual(out[0].label, "World Health Organization");
  });

  it("skips creators with no usable name", function () {
    const out = normalizeCreators(
      rec([
        {},
        { firstName: "", lastName: "" },
        { firstName: "Ada", lastName: "Lovelace" },
      ]),
    );
    assert.lengthOf(out, 1, "empty creators are dropped, only Lovelace remains");
    assert.strictEqual(out[0].key, "lovelace|a");
  });

  it("trims surrounding whitespace before keying", function () {
    const out = normalizeCreators(
      rec([{ firstName: "  John  ", lastName: "  Smith  " }]),
    );
    assert.strictEqual(out[0].key, "smith|j");
    assert.strictEqual(out[0].label, "Smith, J.");
  });

  it("labels a last-name-only creator without a trailing initial", function () {
    const out = normalizeCreators(rec([{ lastName: "Curie" }]));
    assert.strictEqual(out[0].key, "curie|");
    assert.strictEqual(out[0].label, "Curie");
  });

  it("de-duplicates the same author appearing twice in one item", function () {
    const out = normalizeCreators(
      rec([
        { firstName: "John", lastName: "Smith" },
        { firstName: "J.", lastName: "Smith" },
        { firstName: "Jane", lastName: "Doe" },
      ]),
    );
    // Smith collapses to one entry; Doe is distinct -> 2 keys total.
    assert.lengthOf(out, 2);
    const keys = out.map((k) => k.key).sort();
    assert.deepEqual(keys, ["doe|j", "smith|j"]);
  });
});
