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

describe("vessel_exercise_scan", () => {
  it("returns empty report when no vessels are connected", async () => {
    fetchMock.setResponse("http://127.0.0.1:8100", { vessels: [] });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/activities/execution-traces?limit=500", {
      executions: [],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/impulses/resolutions?limit=500", {
      resolutions: [],
    });

    const result = await resolveVesselExerciseScan({ type: "vessel_exercise_scan" });

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

    fetchMock.setResponse("http://127.0.0.1:8100", {
      vessels: [
        { vessel_id: "vessel-a", last_heartbeat: recentHeartbeat },
        { vessel_id: "vessel-b", last_heartbeat: recentHeartbeat },
      ],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/activities/execution-traces?limit=500", {
      executions: [],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/impulses/resolutions?limit=500", {
      resolutions: [],
    });
    fetchMock.setResponse("http://127.0.0.1:8210/run-goal", { success: true });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
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

    fetchMock.setResponse("http://127.0.0.1:8100", {
      vessels: [{ vessel_id: "vessel-a", last_heartbeat: recentHeartbeat }],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/activities/execution-traces?limit=500", {
      executions: [
        {
          vessel_id: "vessel-a",
          status: "success",
          started_at: recentExercise,
        },
      ],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/impulses/resolutions?limit=500", {
      resolutions: [],
    });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
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

    fetchMock.setResponse("http://127.0.0.1:8100", {
      vessels: [{ vessel_id: "vessel-stale", last_heartbeat: recentHeartbeat }],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/activities/execution-traces?limit=500", {
      executions: [],
    });
    fetchMock.setResponse("http://127.0.0.1:8080/v2/impulses/resolutions?limit=500", {
      resolutions: [],
    });
    fetchMock.setResponse("http://127.0.0.1:8210/run-goal", new Error("probe failed"));
    fetchMock.setResponse("http://127.0.0.1:8090/v2/impulses/resolve", { success: true });

    const result = await resolveVesselExerciseScan({
      type: "vessel_exercise_scan",
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
