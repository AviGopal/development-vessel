import { describe, it, expect } from "bun:test";
import { resolveVesselHealthReport } from "../../src/resolvers/vessel-health-report.js";

describe("resolveVesselHealthReport", () => {
  it("returns shape=vessel_health_report with required fields", async () => {
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
      vessel_id: "analysis-vessel-local",
    });
    expect(result.shape).toBe("vessel_health_report");
    const body = result.body as Record<string, unknown>;
    expect(typeof body["vessel_id"]).toBe("string");
    expect(typeof body["overall_health"]).toBe("string");
    expect(body["discovery"]).toBeDefined();
    expect(body["traces"]).toBeDefined();
    expect(body["goals"]).toBeDefined();
    expect(body["health_probe"]).toBeDefined();
  });

  it("defaults vessel_id to analysis-vessel-local when not provided", async () => {
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
    });
    expect(result.shape).toBe("vessel_health_report");
    const body = result.body as Record<string, unknown>;
    expect(body["vessel_id"]).toBe("analysis-vessel-local");
  });

  it("overall_health is one of the valid enum values", async () => {
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
      vessel_id: "analysis-vessel-local",
    });
    const body = result.body as Record<string, unknown>;
    const validValues = ["healthy", "degraded", "unknown"];
    expect(validValues).toContain(body["overall_health"]);
  });

  it("traces block always has expected numeric fields", async () => {
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
      vessel_id: "analysis-vessel-local",
    });
    const body = result.body as Record<string, unknown>;
    const traces = body["traces"] as Record<string, unknown>;
    expect(typeof traces["total_recent"]).toBe("number");
    expect(typeof traces["success_count"]).toBe("number");
    expect(typeof traces["failure_count"]).toBe("number");
  });
});
