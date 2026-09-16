/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";

/**
 * Store-level behaviour of the dual-mode scope singleton (../set/store).
 *
 * The pure persistence/resolution rules live in scope.ts and are covered by
 * scopeStore.test.ts. THIS file pins the two store invariants the design called
 * out as must-fix and that the pure tests cannot reach because they never import
 * the singleton:
 *
 *  - ACTIVE-LIST ROUTING (must-fix #3): has/count/list/add/remove/toggle/clear
 *    operate on the exclude list in exclude mode and the include list in include
 *    mode; setMode flips the target WITHOUT touching the other list.
 *  - NON-DESTRUCTIVE SWITCH: both lists survive a mode flip, so a curated
 *    allowlist is never lost by toggling to blocklist and back.
 *  - Per-library independence.
 *
 * The store touches Zotero only inside method bodies (all guarded by try/catch)
 * and lazily; we stub the globals so persistence is a clean no-op and init()
 * registers no notifier. Each test uses a distinct libraryID so the shared
 * module-singleton cache cannot leak between tests.
 */

// Stubs MUST exist before the first store method call (the store reads them
// lazily inside ensureCache/init). Importing the store does not touch them.
(globalThis as any).addon = { data: { alive: false } };
(globalThis as any).Zotero = {
  Prefs: { get: () => undefined, set: () => undefined, clear: () => undefined },
  Notifier: { registerObserver: () => "stub", unregisterObserver: () => undefined },
  Items: { get: (id: number) => ({ id }) },
  Libraries: { get: () => ({ getDataLoaded: () => true }) },
};

import { insightsSet } from "../src/modules/insights/set/store.ts";

let nextLib = 9000;
function freshLib(): number {
  return ++nextLib;
}

describe("insightsSet - default + mode", function () {
  it("a fresh library defaults to exclude mode with empty lists", function () {
    const L = freshLib();
    assert.strictEqual(insightsSet.getMode(L), "exclude");
    assert.strictEqual(insightsSet.count(L), 0);
    assert.deepEqual(insightsSet.list(L), []);
  });

  it("setMode flips the mode and is reflected by getMode", function () {
    const L = freshLib();
    insightsSet.setMode(L, "include");
    assert.strictEqual(insightsSet.getMode(L), "include");
    insightsSet.setMode(L, "exclude");
    assert.strictEqual(insightsSet.getMode(L), "exclude");
  });
});

describe("insightsSet - active-list routing (must-fix #3)", function () {
  it("add/list/count act on the include list in include mode", function () {
    const L = freshLib();
    insightsSet.setMode(L, "include");
    insightsSet.add(L, [1, 2, 3]);
    assert.strictEqual(insightsSet.count(L), 3);
    assert.deepEqual(insightsSet.list(L).sort((a, b) => a - b), [1, 2, 3]);
    // The exclude list must be untouched: flipping to exclude shows it empty.
    insightsSet.setMode(L, "exclude");
    assert.strictEqual(insightsSet.count(L), 0, "exclude list stayed empty");
  });

  it("add/list/count act on the exclude list in exclude mode", function () {
    const L = freshLib();
    insightsSet.add(L, [7, 8]); // exclude is the default active list
    assert.strictEqual(insightsSet.getMode(L), "exclude");
    assert.deepEqual(insightsSet.list(L).sort((a, b) => a - b), [7, 8]);
    insightsSet.setMode(L, "include");
    assert.strictEqual(insightsSet.count(L), 0, "include list stayed empty");
  });

  it("has/remove route to the active list only", function () {
    const L = freshLib();
    insightsSet.setMode(L, "include");
    insightsSet.add(L, [10, 11]);
    assert.isTrue(insightsSet.has(L, 10));
    assert.isFalse(insightsSet.has(L, 99));
    insightsSet.remove(L, [10]);
    assert.isFalse(insightsSet.has(L, 10));
    assert.deepEqual(insightsSet.list(L), [11]);
  });

  it("toggle adds when any missing, removes when all present, on the active list", function () {
    const L = freshLib();
    insightsSet.setMode(L, "include");
    assert.strictEqual(insightsSet.toggle(L, [1, 2]), "added");
    assert.deepEqual(insightsSet.list(L).sort((a, b) => a - b), [1, 2]);
    assert.strictEqual(insightsSet.toggle(L, [1, 2]), "removed");
    assert.deepEqual(insightsSet.list(L), []);
  });

  it("clear empties only the active list", function () {
    const L = freshLib();
    // Seed both lists.
    insightsSet.add(L, [5]); // exclude
    insightsSet.setMode(L, "include");
    insightsSet.add(L, [6]); // include
    insightsSet.clear(L); // clears include (active)
    assert.strictEqual(insightsSet.count(L), 0, "include cleared");
    insightsSet.setMode(L, "exclude");
    assert.deepEqual(insightsSet.list(L), [5], "exclude list survived the clear");
  });

  it("rejects non-positive / non-finite ids on the write path", function () {
    const L = freshLib();
    insightsSet.setMode(L, "include");
    insightsSet.add(L, [0, -1, NaN as any, 4]);
    assert.deepEqual(insightsSet.list(L), [4], "only the valid id was stored");
  });
});

describe("insightsSet - non-destructive mode switch", function () {
  it("keeps BOTH lists across an exclude<->include round trip", function () {
    const L = freshLib();
    insightsSet.add(L, [100, 101]); // exclude list
    insightsSet.setMode(L, "include");
    insightsSet.add(L, [200, 201]); // include list
    // Flip back and forth; neither list may be lost.
    insightsSet.setMode(L, "exclude");
    assert.deepEqual(insightsSet.list(L).sort((a, b) => a - b), [100, 101]);
    insightsSet.setMode(L, "include");
    assert.deepEqual(insightsSet.list(L).sort((a, b) => a - b), [200, 201]);
  });
});

describe("insightsSet - per-library independence", function () {
  it("mutating library A leaves library B's mode and lists unchanged", function () {
    const A = freshLib();
    const B = freshLib();
    insightsSet.setMode(A, "include");
    insightsSet.add(A, [1, 2, 3]);
    // B is a different library; it must be untouched.
    assert.strictEqual(insightsSet.getMode(B), "exclude");
    assert.strictEqual(insightsSet.count(B), 0);
    insightsSet.add(B, [9]);
    assert.deepEqual(insightsSet.list(A).sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(insightsSet.list(B), [9]);
  });
});
