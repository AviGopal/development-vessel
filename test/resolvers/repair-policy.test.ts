import { describe, it, expect } from "bun:test";
import { resolveRepairPolicy } from "../../src/resolvers/repair-policy.js";

describe("repair_policy resolver", () => {
  it("returns a well-formed result for the repairPolicy shape", async () => {
    const r = await resolveRepairPolicy({ type: "repair_policy" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
