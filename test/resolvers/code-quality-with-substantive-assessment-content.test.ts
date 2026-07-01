import { describe, it, expect } from "bun:test";
import { resolveCodeQualityWithSubstantiveAssessmentContent } from "../../src/resolvers/code-quality-with-substantive-assessment-content.js";

describe("resolveCodeQualityWithSubstantiveAssessmentContent", () => {
  it("returns the correct shape even when vessel root is missing", async () => {
    // Point at a non-existent path so fs_list fails gracefully
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: "code_quality with substantive assessment content",
      vesselRoot: "/tmp/nonexistent-clock-vessel-test-path-xyz",
    });
    expect(result.shape).toBe("code_quality with substantive assessment content");
    expect(result.body).toBeDefined();
    const body = result.body as Record<string, unknown>;
    expect(typeof body["assessment"]).toBe("string");
    expect((body["assessment"] as string).length).toBeGreaterThan(0);
  });

  it("body always contains assessment and files_analyzed fields", async () => {
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: "code_quality with substantive assessment content",
      vesselRoot: "/tmp/nonexistent-clock-vessel-test-path-abc",
    });
    const body = result.body as Record<string, unknown>;
    expect("assessment" in body).toBe(true);
    expect("files_analyzed" in body).toBe(true);
    expect(typeof body["files_analyzed"]).toBe("number");
  });

  it("shape string is exactly 'code_quality with substantive assessment content'", async () => {
    const result = await resolveCodeQualityWithSubstantiveAssessmentContent({
      type: "code_quality with substantive assessment content",
    });
    expect(result.shape).toBe("code_quality with substantive assessment content");
  });
});
