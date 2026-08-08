import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { addCents, centsToRands, randsToCents } from "../src/lib/money.js";

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
});
