import { assert } from "chai";
import {
  parsePref,
  serialize,
  needsMigration,
  resolveScopeIds,
  toIdSet,
  defaultScope,
  activeSetOf,
  isDefaultScope,
  isValidId,
  isInScope,
  pruneScope,
  type LibScope,
} from "../src/modules/insights/set/scope.ts";

/**
 * Dual-mode scope persistence + resolution (PURE: ../set/scope.ts).
 *
 * These are the highest-risk parts of the include/exclude dual-mode feature and
 * the four "must fix before build" items flagged by the design critique:
 *
 *  1. MIGRATION must lift the legacy `{ [libraryID]: number[] }` exclusion blob
 *     into v2 exclude mode loss-free, and must NEVER misread a v2 blob as legacy
 *     (which would wipe the include lists). Gated strictly on numeric `v === 2`.
 *  2. SERIALIZATION round-trips both lists and the mode, omits default scopes to
 *     keep JSON compact, and is stable.
 *  3. SCOPE RESOLUTION: include mode = universe INTERSECT active (empty active =>
 *     empty scope); exclude mode = universe MINUS active (empty active => whole
 *     universe). This is the canonical rule the data layer mirrors.
 *  4. Defensive parsing: corrupt / partial / wrong-typed input never throws and
 *     degrades to an empty map or a default scope.
 */

function libScope(
  mode: "exclude" | "include",
  exclude: number[],
  include: number[],
): LibScope {
  return { mode, exclude: new Set(exclude), include: new Set(include) };
}

describe("scope.toIdSet", function () {
  it("coerces an array of finite numbers into a Set", function () {
    assert.deepEqual([...toIdSet([1, 2, 3])].sort(), [1, 2, 3]);
  });
  it("drops non-finite and non-numeric entries", function () {
    assert.deepEqual([...toIdSet([1, "2", NaN, Infinity, null, "x", 3])].sort(), [
      1, 2, 3,
    ]);
  });
  it("returns an empty Set for non-array input", function () {
    assert.strictEqual(toIdSet(undefined).size, 0);
    assert.strictEqual(toIdSet("nope" as unknown).size, 0);
    assert.strictEqual(toIdSet({} as unknown).size, 0);
  });
});

describe("scope.defaultScope / activeSetOf / isDefaultScope", function () {
  it("default is exclude mode with two empty lists", function () {
    const s = defaultScope();
    assert.strictEqual(s.mode, "exclude");
    assert.strictEqual(s.exclude.size, 0);
    assert.strictEqual(s.include.size, 0);
    assert.isTrue(isDefaultScope(s));
  });
  it("activeSetOf returns the exclude list in exclude mode", function () {
    const s = libScope("exclude", [1, 2], [9]);
    assert.strictEqual(activeSetOf(s), s.exclude);
  });
  it("activeSetOf returns the include list in include mode", function () {
    const s = libScope("include", [1, 2], [9]);
    assert.strictEqual(activeSetOf(s), s.include);
  });
  it("a scope with any list non-empty is not default", function () {
    assert.isFalse(isDefaultScope(libScope("exclude", [1], [])));
    assert.isFalse(isDefaultScope(libScope("exclude", [], [1])));
    assert.isFalse(isDefaultScope(libScope("include", [], [])));
  });
});

describe("scope.parsePref - legacy migration", function () {
  it("lifts the legacy { [libraryID]: number[] } blob into v2 exclude mode", function () {
    const map = parsePref(JSON.stringify({ "1": [10, 20, 30], "3": [7] }));
    assert.strictEqual(map.size, 2);
    const lib1 = map.get(1)!;
    assert.strictEqual(lib1.mode, "exclude");
    assert.deepEqual([...lib1.exclude].sort((a, b) => a - b), [10, 20, 30]);
    assert.strictEqual(lib1.include.size, 0, "legacy lift leaves include empty");
    const lib3 = map.get(3)!;
    assert.deepEqual([...lib3.exclude], [7]);
  });
  it("skips legacy entries whose value is not an array", function () {
    const map = parsePref(JSON.stringify({ "1": [1, 2], "2": "oops", "3": 5 }));
    assert.isTrue(map.has(1));
    assert.isFalse(map.has(2));
    assert.isFalse(map.has(3));
  });
  it("filters non-finite ids out of a legacy list", function () {
    const map = parsePref(JSON.stringify({ "1": [1, null, "x", 2] }));
    assert.deepEqual([...map.get(1)!.exclude].sort((a, b) => a - b), [1, 2]);
  });
});

describe("scope.parsePref - v2 shape", function () {
  it("parses mode + both lists", function () {
    const raw = JSON.stringify({
      v: 2,
      libs: {
        "1": { mode: "include", exclude: [5], include: [10, 11] },
        "2": { mode: "exclude", exclude: [99], include: [] },
      },
    });
    const map = parsePref(raw);
    const lib1 = map.get(1)!;
    assert.strictEqual(lib1.mode, "include");
    assert.deepEqual([...lib1.exclude], [5], "inactive list still preserved");
    assert.deepEqual([...lib1.include].sort((a, b) => a - b), [10, 11]);
    assert.strictEqual(map.get(2)!.mode, "exclude");
  });
  it("defaults missing fields (mode->exclude, lists->empty)", function () {
    const map = parsePref(JSON.stringify({ v: 2, libs: { "1": {} } }));
    const s = map.get(1)!;
    assert.strictEqual(s.mode, "exclude");
    assert.strictEqual(s.exclude.size, 0);
    assert.strictEqual(s.include.size, 0);
  });
  it("coerces an unknown mode value to exclude", function () {
    const map = parsePref(
      JSON.stringify({ v: 2, libs: { "1": { mode: "weird", include: [1] } } }),
    );
    assert.strictEqual(map.get(1)!.mode, "exclude");
  });
  it("tolerates a v2 blob with no libs object", function () {
    assert.strictEqual(parsePref(JSON.stringify({ v: 2 })).size, 0);
  });
  it("STRICT GUARD: a v2 blob is parsed as v2, never as legacy", function () {
    // The critical correctness item: include lists must survive a reload.
    const raw = JSON.stringify({
      v: 2,
      libs: { "1": { mode: "include", exclude: [], include: [42] } },
    });
    const map = parsePref(raw);
    assert.deepEqual([...map.get(1)!.include], [42]);
    // If it were misread as legacy, the include list would be lost and the
    // top-level "v"/"libs" keys would be ignored (non-numeric), giving size 0.
    assert.strictEqual(map.size, 1);
  });
});

describe("scope.parsePref - defensive", function () {
  it("returns an empty map for empty / non-string input", function () {
    assert.strictEqual(parsePref(undefined).size, 0);
    assert.strictEqual(parsePref("").size, 0);
    assert.strictEqual(parsePref(123 as unknown).size, 0);
  });
  it("returns an empty map for corrupt JSON", function () {
    assert.strictEqual(parsePref("{not json").size, 0);
  });
  it("returns an empty map for a non-object / array top level", function () {
    assert.strictEqual(parsePref("[1,2,3]").size, 0);
    assert.strictEqual(parsePref("42").size, 0);
  });
});

describe("scope.needsMigration", function () {
  it("is true for the legacy blob", function () {
    assert.isTrue(needsMigration(JSON.stringify({ "1": [1, 2] })));
  });
  it("is false for a v2 blob", function () {
    assert.isFalse(needsMigration(JSON.stringify({ v: 2, libs: {} })));
  });
  it("is false for empty / corrupt / non-object input", function () {
    assert.isFalse(needsMigration(""));
    assert.isFalse(needsMigration(undefined));
    assert.isFalse(needsMigration("{bad"));
    assert.isFalse(needsMigration("[1]"));
  });
});

describe("scope.serialize", function () {
  it("emits the versioned shape and omits default scopes", function () {
    const map = new Map<number, LibScope>([
      [1, defaultScope()], // omitted
      [2, libScope("include", [], [7, 8])],
    ]);
    const obj = JSON.parse(serialize(map));
    assert.strictEqual(obj.v, 2);
    assert.notProperty(obj.libs, "1", "default scope omitted to stay compact");
    assert.property(obj.libs, "2");
    assert.strictEqual(obj.libs["2"].mode, "include");
    assert.deepEqual(obj.libs["2"].include.sort((a: number, b: number) => a - b), [
      7, 8,
    ]);
  });
  it("empty map serializes to an empty v2 blob", function () {
    assert.deepEqual(JSON.parse(serialize(new Map())), { v: 2, libs: {} });
  });
  it("round-trips mode + BOTH lists (non-destructive switch guarantee)", function () {
    const map = new Map<number, LibScope>([
      [1, libScope("include", [1, 2, 3], [10, 20])],
    ]);
    const back = parsePref(serialize(map));
    const s = back.get(1)!;
    assert.strictEqual(s.mode, "include");
    assert.deepEqual([...s.exclude].sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual([...s.include].sort((a, b) => a - b), [10, 20]);
  });
});

describe("scope.resolveScopeIds", function () {
  const universe = [1, 2, 3, 4, 5];

  it("exclude mode with empty active returns the whole universe", function () {
    assert.deepEqual(resolveScopeIds("exclude", [], universe), universe);
  });
  it("exclude mode returns universe MINUS active", function () {
    assert.deepEqual(resolveScopeIds("exclude", [2, 4], universe), [1, 3, 5]);
  });
  it("include mode with empty active returns nothing", function () {
    assert.deepEqual(resolveScopeIds("include", [], universe), []);
  });
  it("include mode returns universe INTERSECT active", function () {
    assert.deepEqual(resolveScopeIds("include", [2, 4, 99], universe), [2, 4]);
  });
  it("accepts a Set or an array for the active list", function () {
    assert.deepEqual(
      resolveScopeIds("include", new Set([3, 5]), universe),
      [3, 5],
    );
  });
  it("preserves the universe order", function () {
    assert.deepEqual(resolveScopeIds("exclude", [3], [5, 4, 3, 2, 1]), [
      5, 4, 2, 1,
    ]);
  });
  it("include + exclude over the same active+universe partition the universe", function () {
    const active = [2, 4];
    const inc = resolveScopeIds("include", active, universe);
    const exc = resolveScopeIds("exclude", active, universe);
    assert.deepEqual(
      [...inc, ...exc].sort((a, b) => a - b),
      universe,
      "include and exclude are complementary over the universe",
    );
    assert.lengthOf(
      inc.filter((id) => exc.includes(id)),
      0,
      "no overlap between the two modes' results",
    );
  });
});

describe("scope.isValidId", function () {
  it("accepts positive integers (and numeric strings)", function () {
    assert.isTrue(isValidId(1));
    assert.isTrue(isValidId(999));
    assert.isTrue(isValidId("42"));
  });
  it("rejects zero, negatives, and non-numeric values", function () {
    for (const bad of [0, -1, NaN, Infinity, null, undefined, "x", "", {}]) {
      assert.isFalse(isValidId(bad), "should reject " + String(bad));
    }
  });
  it("matches the toIdSet parse-path rule (no round-trip drift)", function () {
    const raw = [1, 0, -5, "7", null, 3];
    const stored = [...toIdSet(raw)].sort((a, b) => a - b);
    const validByGate = raw.filter((v) => isValidId(v)).map((v) => Number(v)).sort((a, b) => a - b);
    assert.deepEqual(stored, validByGate);
  });
});

describe("scope.isInScope", function () {
  it("exclude mode: in scope iff NOT in the active list", function () {
    const active = new Set([2, 4]);
    assert.isTrue(isInScope("exclude", active, 1));
    assert.isFalse(isInScope("exclude", active, 2));
  });
  it("include mode: in scope iff IN the active list", function () {
    const active = new Set([2, 4]);
    assert.isTrue(isInScope("include", active, 2));
    assert.isFalse(isInScope("include", active, 1));
  });
  it("empty active: include => nothing, exclude => everything", function () {
    const empty = new Set<number>();
    assert.isFalse(isInScope("include", empty, 5));
    assert.isTrue(isInScope("exclude", empty, 5));
  });
  it("agrees with resolveScopeIds over a universe (no resolver drift)", function () {
    const universe = [1, 2, 3, 4, 5, 6];
    const active = new Set([2, 5]);
    for (const mode of ["exclude", "include"] as const) {
      const viaResolve = resolveScopeIds(mode, active, universe);
      const viaPredicate = universe.filter((id) => isInScope(mode, active, id));
      assert.deepEqual(
        viaPredicate,
        viaResolve,
        "isInScope filter must match resolveScopeIds for mode " + mode,
      );
    }
  });
});

describe("scope.pruneScope (dual-list prune, must-fix #1)", function () {
  it("removes a missing id from the ACTIVE list", function () {
    const s = libScope("exclude", [1, 2, 3], []);
    const mutated = pruneScope(s, (id) => id !== 2);
    assert.isTrue(mutated);
    assert.deepEqual([...s.exclude].sort((a, b) => a - b), [1, 3]);
  });
  it("removes a missing id from the INACTIVE list (the resurrection guard)", function () {
    // include mode active; a deleted id lives only in the inactive exclude list.
    const s = libScope("include", [99], [10, 11]);
    const mutated = pruneScope(s, (id) => id !== 99);
    assert.isTrue(mutated, "must prune the inactive list too");
    assert.strictEqual(s.exclude.size, 0, "stale inactive id was removed");
    assert.deepEqual([...s.include].sort((a, b) => a - b), [10, 11]);
  });
  it("keeps every id when all exist (no spurious mutation)", function () {
    const s = libScope("exclude", [1, 2], [3, 4]);
    const mutated = pruneScope(s, () => true);
    assert.isFalse(mutated);
    assert.strictEqual(s.exclude.size, 2);
    assert.strictEqual(s.include.size, 2);
  });
  it("does NOT drop ids when the existence probe reports them present", function () {
    // Models the library-loaded guard: when a library's items are not loaded,
    // the store skips prune entirely, so no id is dropped.
    const s = libScope("include", [], [7, 8, 9]);
    const mutated = pruneScope(s, () => true);
    assert.isFalse(mutated);
    assert.deepEqual([...s.include].sort((a, b) => a - b), [7, 8, 9]);
  });
});
