import { assert } from "chai";
import {
  niceMax,
  niceTicks,
} from "../src/modules/insights/charts/chartkit/scale.ts";

/** Axis rounding: a round step (1, 2 or 5 times a power of ten), then the
 * maximum rounded up to the next step, so the axis ends close to the data. */
describe("axis scale", function () {
  it("ends one step above the largest value, not at the next power", function () {
    assert.strictEqual(niceMax(12), 15);
    assert.strictEqual(niceMax(84), 100);
    assert.strictEqual(niceMax(9), 10);
    assert.strictEqual(niceMax(3), 3);
    assert.strictEqual(niceMax(376), 400);
  });

  it("uses whole-number steps for counts", function () {
    assert.deepEqual(niceTicks(12), [0, 5, 10, 15]);
    assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
    assert.deepEqual(niceTicks(84), [0, 20, 40, 60, 80, 100]);
  });

  it("handles empty data", function () {
    assert.strictEqual(niceMax(0), 1);
    assert.deepEqual(niceTicks(0), [0, 1]);
  });
});
