import { describe, it, expect } from "bun:test";
import { resolveCodeLocalityMiningTick } from "../../src/resolvers/code-locality-mining-tick.js";

describe("code_locality_mining_tick resolver", () => {
  it("returns a well-formed result for the codeLocalityIndex shape", async () => {
    const r = await resolveCodeLocalityMiningTick({ type: "code_locality_mining_tick" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
