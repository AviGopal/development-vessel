import { describe, it, expect } from "bun:test";
import { resolveSubstantiveFindings } from "../../src/resolvers/substantive-findings.js";

describe("substantive_findings resolver", () => {
  it("returns a well-formed result for the substantive_findings shape", async () => {
    const r = await resolveSubstantiveFindings({ type: "substantive_findings" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
