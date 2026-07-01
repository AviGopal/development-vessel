import { describe, it, expect } from "bun:test";
import { resolveSummaryOfClockVesselFunctionality } from "../../src/resolvers/summary-of-clock-vessel-functionality.js";

describe("resolveSummaryOfClockVesselFunctionality", () => {
  it("returns the correct shape", async () => {
    const result = await resolveSummaryOfClockVesselFunctionality({});
    expect(result.shape).toBe("summary_of_clock_vessel_functionality");
  });

  it("body contains required fields", async () => {
    const result = await resolveSummaryOfClockVesselFunctionality({});
    const body = result.body as Record<string, unknown>;
    expect(typeof body["vessel_id"]).toBe("string");
    expect(typeof body["summary"]).toBe("string");
    expect(typeof body["shape_count"]).toBe("number");
    expect(typeof body["resolver_count"]).toBe("number");
    expect(Array.isArray(body["advertised_shapes"])).toBe(true);
    expect(Array.isArray(body["data_sources"])).toBe(true);
  });

  it("body contains improvement_suggestion with file and detail", async () => {
    const result = await resolveSummaryOfClockVesselFunctionality({});
    const body = result.body as Record<string, unknown>;
    const suggestion = body["improvement_suggestion"] as Record<string, unknown> | undefined;
    expect(suggestion).toBeDefined();
    expect(typeof suggestion?.["file"]).toBe("string");
    expect(typeof suggestion?.["detail"]).toBe("string");
    expect((suggestion?.["file"] as string).length).toBeGreaterThan(0);
  });

  it("success_rate field is a string", async () => {
    const result = await resolveSummaryOfClockVesselFunctionality({});
    const body = result.body as Record<string, unknown>;
    expect(typeof body["success_rate"]).toBe("string");
  });

  it("does not throw when all upstreams are unavailable", async () => {
    // Resolver must be resilient: all external calls fail gracefully
    const result = await resolveSummaryOfClockVesselFunctionality({ type: "summary_of_clock_vessel_functionality" });
    expect(result.shape).toBe("summary_of_clock_vessel_functionality");
    const body = result.body as Record<string, unknown>;
    // Even with no connectivity, these must be present
    expect(body["vessel_id"]).toBeDefined();
    expect(body["improvement_suggestion"]).toBeDefined();
  });
});
