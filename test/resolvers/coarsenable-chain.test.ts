import { describe, it, expect } from "bun:test";
import { resolveCoarsenableChain } from "../../src/resolvers/coarsenable-chain.js";

describe("coarsenable_chain resolver", () => {
  it("returns a well-formed result for the coarsenableChain shape", async () => {
    const r = await resolveCoarsenableChain({ type: "coarsenable_chain" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
