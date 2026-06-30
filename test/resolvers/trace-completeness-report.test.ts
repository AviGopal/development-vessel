import { describe, it, expect } from "bun:test";
import { resolveTraceCompletenessReport } from "../../src/resolvers/trace-completeness-report.js";

describe("trace_completeness_report resolver", () => {
  it("returns a well-formed result for the traceCompletenessReport shape", async () => {
    const r = await resolveTraceCompletenessReport({ type: "trace_completeness_report" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
