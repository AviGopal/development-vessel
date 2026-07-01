import { describe, it, expect } from "bun:test";
import { resolveAssessmentSummary } from "../../src/resolvers/assessment-summary.js";

describe("assessment_summary resolver", () => {
  it("returns a well-formed result for the assessment_summary shape", async () => {
    const r = await resolveAssessmentSummary({ type: "assessment_summary" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
