import { describe, it, expect } from "bun:test";
import { resolveActivityMetrics } from "../../src/resolvers/activity-metrics.js";

describe("activity_metrics resolver", () => {
  it("returns a well-formed result for the activity_metrics shape", async () => {
    const r = await resolveActivityMetrics({ type: "activity_metrics" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
