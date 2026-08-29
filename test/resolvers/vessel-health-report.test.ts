import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselHealthReport } from "../../src/resolvers/vessel-health-report.js";

// The refusal tests below need no network and always passed. The reporting tests did: this
// resolver makes FOUR sequential fetches (discovery 8s, traces 8s, goals 8s, /health probe 6s)
// — up to 30s against bun's 5s test timeout — so they failed as timeouts under substrate load.
// They were also existence-only (typeof overall_health === "string", traces defined), which the
// all-errors path satisfies just as well as a healthy vessel, so the health DERIVATION went
// unasserted. Stubbed per-URL below, each arm of that derivation is pinned instead.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const serve = (opts: {
  discovery?: unknown; discoveryStatus?: number; discoveryThrows?: boolean;
  traces?: unknown; goals?: unknown; healthOk?: boolean;
}): void => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/vessels/")) {
      if (opts.discoveryThrows) throw new Error("ECONNREFUSED");
      return json(opts.discovery ?? {}, opts.discoveryStatus ?? 200);
    }
    if (url.includes("/execution-traces")) return json(opts.traces ?? { executions: [] });
    if (url.includes("/v2/goals")) return json(opts.goals ?? { goals: [] });
    if (url.endsWith("/health")) {
      if (opts.healthOk === false) throw new Error("probe refused");
      return json({ ok: true });
    }
    return json({});
  }) as unknown as typeof fetch;
};

const REGISTERED = { endpoint: "http://127.0.0.1:8099", shapes: ["analysis"] };

describe("resolveVesselHealthReport", () => {
  it("returns shape=vessel_health_report with required fields", async () => {
    serve({ discovery: REGISTERED });
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

  it("healthy: discovery resolves, the probe answers, and successes dominate", async () => {
    serve({
      discovery: REGISTERED,
      traces: { executions: [{ success: true, resolver_id: "a" }, { success: true, resolver_id: "a" }, { success: false, resolver_id: "b" }] },
    });
    const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id: "analysis-vessel-local" })).body as Record<string, any>;
    expect(body["overall_health"]).toBe("healthy");
    expect(body["traces"]["total_recent"]).toBe(3);
    expect(body["traces"]["success_count"]).toBe(2);
    expect(body["traces"]["failure_count"]).toBe(1);
    expect(body["traces"]["success_rate_pct"]).toBeCloseTo(66.7, 1);
    expect(body["traces"]["top_resolvers"][0]).toMatchObject({ resolver_id: "a", count: 2 });
  });

  it("unknown (not degraded) when discovery itself cannot be reached", async () => {
    // The distinction this resolver is careful about: "I cannot see the vessel" is not the
    // same claim as "the vessel is unwell". Discovery failure dominates the verdict.
    serve({ discoveryThrows: true });
    const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id: "analysis-vessel-local" })).body as Record<string, any>;
    expect(body["overall_health"]).toBe("unknown");
    expect(body["discovery"]["registered"]).toBe(false);
    expect(body["discovery"]["error"]).toBeTruthy();
  });

  it("degraded when the success rate falls below 50%", async () => {
    serve({
      discovery: REGISTERED,
      traces: { executions: [{ success: false }, { success: false }, { success: true }] },
    });
    const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id: "analysis-vessel-local" })).body as Record<string, any>;
    expect(body["overall_health"]).toBe("degraded");
  });

  it("degraded when the vessel's own /health probe fails", async () => {
    serve({ discovery: REGISTERED, healthOk: false });
    const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id: "analysis-vessel-local" })).body as Record<string, any>;
    expect(body["overall_health"]).toBe("degraded");
  });

  it("reads the `executions` key activity-api actually returns, not just `traces`", async () => {
    // Regression guard named in the resolver: accepting only `traces` read undefined -> [],
    // leaving the block silently empty even when the fetch succeeded.
    serve({ discovery: REGISTERED, traces: { executions: [{ success: true }] } });
    const body = (await resolveVesselHealthReport({ type: "vessel_health_report", vessel_id: "analysis-vessel-local" })).body as Record<string, any>;
    expect(body["traces"]["total_recent"]).toBe(1);
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
    serve({ discovery: REGISTERED });
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
      vessel_id: "analysis-vessel-local",
    });
    const body = result.body as Record<string, unknown>;
    const validValues = ["healthy", "degraded", "unknown"];
    expect(validValues).toContain(body["overall_health"]);
  });

  it("traces block always has expected numeric fields, even when every fetch fails", async () => {
    // The "always" in the name is the point: the numeric fields must be present on the
    // all-errors path too, so a consumer never has to distinguish absent from zero.
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await resolveVesselHealthReport({
      type: "vessel_health_report",
      vessel_id: "analysis-vessel-local",
    });
    const body = result.body as Record<string, unknown>;
    const traces = body["traces"] as Record<string, unknown>;
    expect(typeof traces["total_recent"]).toBe("number");
    expect(typeof traces["success_count"]).toBe("number");
    expect(typeof traces["failure_count"]).toBe("number");
    expect(traces["fetch_error"]).toBeTruthy();
  });
});
