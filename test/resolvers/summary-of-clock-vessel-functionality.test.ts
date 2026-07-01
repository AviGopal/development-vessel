import { describe, it, expect } from "bun:test";
import { resolveSummaryOfClockVesselFunctionality } from "../../src/resolvers/summary-of-clock-vessel-functionality.js";

describe("summary_of_clock_vessel_functionality resolver", () => {
  it("returns a well-formed result for the summary_of_clock_vessel_functionality shape", async () => {
    const r = await resolveSummaryOfClockVesselFunctionality({ type: "summary_of_clock_vessel_functionality" });
    expect(typeof r.shape).toBe("string");
    expect(r).toHaveProperty("body");
  });
});
