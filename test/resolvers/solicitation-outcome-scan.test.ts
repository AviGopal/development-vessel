import { describe, it, expect } from "bun:test";
import { resolveSolicitationOutcomeScan } from "../../src/resolvers/solicitation-outcome-scan.js";

describe("solicitation_outcome_scan resolver", () => {
  it("returns a well-formed result for the solicitationOutcomeReport shape", async () => {
    const r = await resolveSolicitationOutcomeScan({ type: "solicitation_outcome_scan" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
