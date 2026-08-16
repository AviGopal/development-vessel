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

  // THIS TEST PREVIOUSLY ASSERTED THE DEFECT. It read:
  //
  //   it("defaults vessel_id to analysis-vessel-local when not provided", ...)
  //   expect(body["vessel_id"]).toBe("analysis-vessel-local");
  //
  // so the silent-default behaviour was pinned by its own coverage, and a change that removed it
  // would have looked like a regression. That default is a false-reach generator: on 2026-08-16 a
  // goal naming discovery-vessel and development-vessel produced a valid, healthy report about
  // analysis-vessel-local, persisted it as a memory note, and the reach judge asserted the note
  // covered both named vessels. Neither appeared in it, and no gate could tell, because a
  // defaulted subject is indistinguishable from a requested one once the report is built.
  //
  // A test that pins a silent default pins the confabulation with it.
  it("REFUSES to report on an assumed vessel when vessel_id is absent", async () => {
    const result = await resolveVesselHealthReport({ type: "vessel_health_report" });
    expect(result.shape).toBe("vessel_health_report");
    const body = result.body as Record<string, unknown>;
    expect(body["resolved"]).toBe(false);
    expect(String(body["error"])).toContain("vessel_id is required");
    // The old hardcoded subject must not appear anywhere in the refusal.
    expect(JSON.stringify(body)).not.toContain('"vessel_id":"analysis-vessel-local"');
    expect(body["overall_health"]).toBeUndefined();
  });

  it("refuses on empty and whitespace-only vessel_id, not just a missing key", async () => {
    for (const vessel_id of ["", "   ", "\t"]) {
      const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id }))
        .body as Record<string, unknown>;
      expect(body["resolved"]).toBe(false);
    }
  });

  it("refuses when vessel_id is present but not a string", async () => {
    for (const vessel_id of [null, 42, {}, []] as unknown[]) {
      const body = (await resolveVesselHealthReport({
        type: "vessel_health_report",
        vessel_id,
      } as never)).body as Record<string, unknown>;
      expect(body["resolved"]).toBe(false);
    }
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
