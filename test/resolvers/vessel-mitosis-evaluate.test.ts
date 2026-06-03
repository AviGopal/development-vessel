import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselMitosisEvaluate } from "../../src/resolvers/vessel-mitosis-evaluate.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFetch(executions: Array<Record<string, unknown>>): typeof fetch {
  return (async () => new Response(JSON.stringify({ executions }), { status: 200 })) as unknown as typeof fetch;
}

function vTrace(
  exec_id: string,
  version: string,
  status: "success" | "failure",
  failureModeType?: string,
): Record<string, unknown> {
  return {
    execution_id: exec_id,
    status,
    metadata: { version_id: version },
    failure_mode: failureModeType ? { type: failureModeType } : null,
    executed_at: "2026-06-03T00:00:00Z",
  };
}

describe("vessel_mitosis_evaluate", () => {
  it("returns INSUFFICIENT_DATA when traces below threshold", async () => {
    globalThis.fetch = makeFetch([
      vTrace("e1", "v1", "success"),
      vTrace("e2", "mitosis-X", "success"),
    ]);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    expect(r.shape).toBe("vesselMitosisEvaluation");
    expect((r.body as { verdict: string }).verdict).toBe("INSUFFICIENT_DATA");
  });

  it("returns FAVORABLE when mitosis success_rate beats base by >= threshold", async () => {
    const traces = [
      // Base: 1 success, 4 failures (success_rate 0.2)
      vTrace("e_b1", "v1", "success"),
      vTrace("e_b2", "v1", "failure", "preflight_rejection"),
      vTrace("e_b3", "v1", "failure", "preflight_rejection"),
      vTrace("e_b4", "v1", "failure", "preflight_rejection"),
      vTrace("e_b5", "v1", "failure", "preflight_rejection"),
      // Mitosis: 5 success, 0 failures (success_rate 1.0); no new fm classes
      vTrace("e_m1", "mitosis-X", "success"),
      vTrace("e_m2", "mitosis-X", "success"),
      vTrace("e_m3", "mitosis-X", "success"),
      vTrace("e_m4", "mitosis-X", "success"),
      vTrace("e_m5", "mitosis-X", "success"),
    ];
    globalThis.fetch = makeFetch(traces);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    const body = r.body as {
      verdict: string;
      base_success_rate: number;
      mitosis_success_rate: number;
      cited_trace_ids: string[];
    };
    expect(body.verdict).toBe("FAVORABLE");
    expect(body.base_success_rate).toBeCloseTo(0.2, 2);
    expect(body.mitosis_success_rate).toBeCloseTo(1.0, 2);
    expect(body.cited_trace_ids.length).toBeGreaterThan(0);
  });

  it("returns UNFAVORABLE when mitosis introduces a new failure_mode class", async () => {
    const traces = [
      vTrace("e_b1", "v1", "success"),
      vTrace("e_b2", "v1", "success"),
      vTrace("e_b3", "v1", "success"),
      vTrace("e_m1", "mitosis-X", "success"),
      vTrace("e_m2", "mitosis-X", "success"),
      vTrace("e_m3", "mitosis-X", "failure", "new_explosion"),
    ];
    globalThis.fetch = makeFetch(traces);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    const body = r.body as { verdict: string; verdict_reason: string };
    expect(body.verdict).toBe("UNFAVORABLE");
    expect(body.verdict_reason).toContain("new_explosion");
  });

  it("returns NEUTRAL when delta within threshold and no new classes", async () => {
    const traces = [
      ...Array.from({ length: 5 }, (_, i) => vTrace(`b${i}`, "v1", i < 4 ? "success" : "failure")),
      ...Array.from({ length: 5 }, (_, i) => vTrace(`m${i}`, "mitosis-X", i < 4 ? "success" : "failure")),
    ];
    globalThis.fetch = makeFetch(traces);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    expect((r.body as { verdict: string }).verdict).toBe("NEUTRAL");
  });

  it("returns structuredError on activity-api 500", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    expect(r.shape).toBe("structuredError");
  });

  it("requires base_version_id and mitosis_version_id", async () => {
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "",
      mitosis_version_id: "mitosis-X",
    });
    expect(r.shape).toBe("structuredError");
  });
});
