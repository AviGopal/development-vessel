import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveVesselExerciseScan } from "../../src/resolvers/vessel-exercise-scan.js";

let originalFetch: typeof global.fetch;
let fetchMock: ReturnType<typeof createFetchMock>;

function createFetchMock() {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const responses = new Map<string, unknown>();

  const mock = async (url: string | URL | Request, options?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, options });

    const response = responses.get(urlStr);
    if (response === undefined) {
      return new Response(JSON.stringify({ vessels: [], executions: [], resolutions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (response instanceof Error) {
      throw response;
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    mock,
    calls,
    responses,
    setResponse: (url: string, data: unknown) => responses.set(url, data),
  };
}

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock = createFetchMock();
  global.fetch = fetchMock.mock as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// Pin the discovery endpoint explicitly instead of inheriting it. The resolver reads
// `process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100"`, and `??` falls back only
// on null/undefined — NOT on "". This container exports DISCOVERY_ENDPOINT as an EMPTY
// STRING, so the default never applied, the endpoint resolved to "", and the resolver
// fetched a hostless "/resolve". That missed every registered mock URL, the harness
// returned its default `{vessels: []}` at status 200, and the scan reported 0 connected
// vessels — a lookup failure wearing the costume of a healthy empty fleet.
const DISCOVERY = "http://127.0.0.1:8100";
const ACTIVITY = "http://127.0.0.1:8080";
const GOAL_HOST = "http://127.0.0.1:8210";

describe("vessel_exercise_scan", () => {
  it("returns empty report when no vessels are connected", async () => {
    fetchMock.setResponse(`${DISCOVERY}/resolve`, { vessels: [] });
    fetchMock.setResponse(`${ACTIVITY}/v2/activities/execution-traces?limit=500`, {
      executions: [],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/impulses/resolutions?limit=500`, {
      resolutions: [],
    });

    const result = await resolveVesselExerciseScan({ type: "vessel_exercise_scan", discoveryEndpoint: DISCOVERY, activityEndpoint: ACTIVITY, goalHostEndpoint: GOAL_HOST });

    expect(result.shape).toBe("vesselExerciseReport");
    expect(result.body).toMatchObject({
      connected_vessels: 0,
      stale_vessels: 0,
      probes_dispatched: 0,
      cells: [],
    });
  });

  it("identifies connected vessels with recent heartbeats", async () => {
    const now = Date.now();
    const recentHeartbeat = new Date(now - 1000 * 60 * 5).toISOString();

    fetchMock.setResponse(`${DISCOVERY}/resolve`, {
      vessels: [
        // Registry payload uses the discovery-vessel wire names (vesselId/lastSeen);
        // the resolver maps them to vessel_id/last_heartbeat internally. Mocking the
        // internal names leaves both fields undefined, so every vessel is dropped by
        // the `!v.vessel_id || !v.last_heartbeat` guard and the scan reports zero.
        // See discovery-vessel/src/resolvers.ts:69,79.
        { vesselId: "vessel-a", lastSeen: recentHeartbeat },
        { vesselId: "vessel-b", lastSeen: recentHeartbeat },
      ],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/activities/execution-traces?limit=500`, {
      executions: [],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/impulses/resolutions?limit=500`, {
      resolutions: [],
    });
    fetchMock.setResponse(`${GOAL_HOST}/run-goal`, { success: true });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
      discoveryEndpoint: DISCOVERY,
      activityEndpoint: ACTIVITY,
      goalHostEndpoint: GOAL_HOST,
      window_ms: 24 * 60 * 60 * 1000,
    });

    expect(result.shape).toBe("vesselExerciseReport");
    expect(result.body).toMatchObject({
      connected_vessels: 2,
      stale_vessels: 2,
    });
    expect((result.body as { cells: unknown[] }).cells).toHaveLength(2);
  });

  it("marks vessels as non-stale when they have recent successful traces", async () => {
    const now = Date.now();
    const recentHeartbeat = new Date(now - 1000 * 60 * 5).toISOString();
    const recentExercise = new Date(now - 1000 * 60 * 30).toISOString();

    fetchMock.setResponse(`${DISCOVERY}/resolve`, {
      vessels: [{ vesselId: "vessel-a", lastSeen: recentHeartbeat }],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/activities/execution-traces?limit=500`, {
      executions: [
        {
          vessel_id: "vessel-a",
          status: "success",
          started_at: recentExercise,
        },
      ],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/impulses/resolutions?limit=500`, {
      resolutions: [],
    });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
      discoveryEndpoint: DISCOVERY,
      activityEndpoint: ACTIVITY,
      goalHostEndpoint: GOAL_HOST,
      window_ms: 24 * 60 * 60 * 1000,
    });

    expect(result.shape).toBe("vesselExerciseReport");
    const body = result.body as { stale_vessels: number; cells: Array<{ stale: boolean }> };
    expect(body.stale_vessels).toBe(0);
    expect(body.cells[0].stale).toBe(false);
  });

  it("dispatches probes for stale vessels and emits gaps on failure", async () => {
    const now = Date.now();
    const recentHeartbeat = new Date(now - 1000 * 60 * 5).toISOString();

    fetchMock.setResponse(`${DISCOVERY}/resolve`, {
      vessels: [{ vesselId: "vessel-stale", lastSeen: recentHeartbeat }],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/activities/execution-traces?limit=500`, {
      executions: [],
    });
    fetchMock.setResponse(`${ACTIVITY}/v2/impulses/resolutions?limit=500`, {
      resolutions: [],
    });
    fetchMock.setResponse(`${GOAL_HOST}/run-goal`, new Error("probe failed"));
    fetchMock.setResponse("http://127.0.0.1:8090/v2/impulses/resolve", { success: true });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
      discoveryEndpoint: DISCOVERY,
      activityEndpoint: ACTIVITY,
      goalHostEndpoint: GOAL_HOST,
      window_ms: 24 * 60 * 60 * 1000,
      emit_gap: true,
    });

    expect(result.shape).toBe("vesselExerciseReport");
    const body = result.body as {
      probes_dispatched: number;
      probes_failed: number;
      gaps_emitted: number;
    };
    expect(body.probes_dispatched).toBe(1);
    expect(body.probes_failed).toBe(1);
    expect(body.gaps_emitted).toBe(1);
  });
});
