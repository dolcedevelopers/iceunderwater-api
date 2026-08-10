import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { addCents, centsToRands, randsToCents, sellingCentsFromCost } from "../src/lib/money.js";

describe("money cents discipline", () => {
  it("converts without floats in arithmetic", () => {
    assert.equal(randsToCents(25), 2500);
    assert.equal(randsToCents(1500), 150000);
    assert.equal(centsToRands(150000), 1500);
    assert.equal(addCents(2500, 36000), 38500);
    assert.equal(centsToRands(38500), 385);
  });

  it("rejects non-integer cents", () => {
    assert.throws(() => centsToRands(1.5));
  });

  it("applies supplier markup to cost", () => {
    assert.equal(sellingCentsFromCost(2500, 0), 2500);
    assert.equal(sellingCentsFromCost(2500, 15), 2875);
    assert.equal(sellingCentsFromCost(1999, 10), 2199);
  });
});
