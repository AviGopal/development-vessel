import { describe, it, expect } from "bun:test";
import { resolveSelectionEntropy } from "../../src/resolvers/selection-entropy.js";

describe("selection_entropy resolver", () => {
  it("returns a well-formed result for the selectionEntropy shape", async () => {
    const r = await resolveSelectionEntropy({ type: "selection_entropy" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
