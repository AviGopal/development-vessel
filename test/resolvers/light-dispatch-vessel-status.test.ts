import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { resolveLightDispatchVesselStatus } from "../../src/resolvers/light-dispatch-vessel-status.js";

// Intercept fetch so tests run without live substrate
const originalFetch = globalThis.fetch;

function makeMockFetch(
  responses: Array<{ ok: boolean; status: number; body: unknown }>,
) {
  let callIndex = 0;
  return async (_url: string | URL | Request, _opts?: RequestInit): Promise<Response> => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex += 1;
    const json = response?.body ?? null;
    return new Response(JSON.stringify(json), {
      status: response?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("resolveLightDispatchVesselStatus", () => {
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns shape light-dispatch-vessel_status", async () => {
    globalThis.fetch = makeMockFetch([
      // health
      { ok: true, status: 200, body: { status: "ok", vessel: "light-dispatch-vessel" } },
      // discovery
      {
        ok: true,
        status: 200,
        body: {
          vessels: [
            {
              vesselId: "light-dispatch-vessel",
              vesselName: "light-dispatch-vessel",
              endpoint: "http://127.0.0.1:8320",
              shapes: ["light_dispatch"],
              last_heartbeat: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
      // traces
      {
        ok: true,
        status: 200,
        body: {
          total: 3,
          traces: [
            { id: "trace:1", status: "success", duration_ms: 100, created_at: "2026-01-01T00:00:01Z" },
            { id: "trace:2", status: "success", duration_ms: 200, created_at: "2026-01-01T00:00:00Z" },
            { id: "trace:3", status: "failure", duration_ms: 50, created_at: "2025-12-31T23:59:59Z" },
          ],
        },
      },
    ]) as typeof globalThis.fetch;

    const result = await resolveLightDispatchVesselStatus({ type: "light-dispatch-vessel_status" });
    expect(result.shape).toBe("light-dispatch-vessel_status");

    const body = result.body as Record<string, unknown>;
    expect(body["overallHealth"]).toBe("healthy");
    expect(body["reachable"]).toBe(true);
    expect(body["discoveryRegistered"]).toBe(true);

    const traces = body["traces"] as Record<string, unknown>;
    expect(traces["successCount"]).toBe(2);
    expect(traces["failureCount"]).toBe(1);
    expect(traces["successRatePct"]).toBe(67);
    expect(traces["avgDurationMs"]).toBe(117);
    expect(traces["mostRecentId"]).toBe("trace:1");
  });

  it("reports degraded when vessel is unreachable", async () => {
    globalThis.fetch = makeMockFetch([
      // health fails
      { ok: false, status: 0, body: null },
      // discovery - not registered
      { ok: true, status: 200, body: { vessels: [] } },
      // traces - empty
      { ok: true, status: 200, body: { total: 0, traces: [] } },
    ]) as typeof globalThis.fetch;

    const result = await resolveLightDispatchVesselStatus({ type: "light-dispatch-vessel_status" });
    expect(result.shape).toBe("light-dispatch-vessel_status");

    const body = result.body as Record<string, unknown>;
    expect(body["overallHealth"]).toBe("degraded");
    expect(body["reachable"]).toBe(false);
    expect(body["discoveryRegistered"]).toBe(false);

    const traces = body["traces"] as Record<string, unknown>;
    expect(traces["successCount"]).toBe(0);
    expect(traces["successRatePct"]).toBeNull();
  });

  it("reports unregistered when reachable but not in discovery", async () => {
    globalThis.fetch = makeMockFetch([
      // health ok
      { ok: true, status: 200, body: { status: "ok" } },
      // discovery empty
      { ok: true, status: 200, body: { vessels: [] } },
      // traces
      { ok: true, status: 200, body: { total: 0, traces: [] } },
    ]) as typeof globalThis.fetch;

    const result = await resolveLightDispatchVesselStatus({ type: "light-dispatch-vessel_status" });
    const body = result.body as Record<string, unknown>;
    expect(body["overallHealth"]).toBe("unregistered");
    expect(body["reachable"]).toBe(true);
    expect(body["discoveryRegistered"]).toBe(false);
  });

  it("accepts a custom vesselId pointer field", async () => {
    globalThis.fetch = makeMockFetch([
      { ok: true, status: 200, body: { status: "ok" } },
      { ok: true, status: 200, body: { vessels: [] } },
      { ok: true, status: 200, body: { total: 0, traces: [] } },
    ]) as typeof globalThis.fetch;

    const result = await resolveLightDispatchVesselStatus({
      type: "light-dispatch-vessel_status",
      vesselId: "light-dispatch-vessel-prod",
    });
    const body = result.body as Record<string, unknown>;
    expect(body["vesselId"]).toBe("light-dispatch-vessel-prod");
  });
});
