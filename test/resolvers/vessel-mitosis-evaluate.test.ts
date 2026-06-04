import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselMitosisEvaluate } from "../../src/resolvers/vessel-mitosis-evaluate.js";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  // ---- Static evaluation path (2026-06-04) ----

  it("static eval: returns INSUFFICIENT_DATA fall-through when mitosis_root missing → trace path", async () => {
    globalThis.fetch = makeFetch([]);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/nonexistent/path/that/should/not/exist",
    });
    const body = r.body as { verdict: string };
    // mitosis_root absent → static eval falls through to trace path → INSUFFICIENT_DATA
    expect(body.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("static eval: FAVORABLE response populates cited_check_names with passing-check names", async () => {
    // Construct a tiny mitosis dir with a fake `bun` shim that exits 0 for
    // every invocation. The static-eval path should reach the FAVORABLE
    // branch and populate cited_check_names from the per-check names.
    const tmpRoot = await mkdtemp(join(tmpdir(), "mitosis-eval-"));
    try {
      const mitosisRoot = join(tmpRoot, "mitosis");
      await mkdir(mitosisRoot, { recursive: true });
      await writeFile(
        join(mitosisRoot, "package.json"),
        JSON.stringify({ name: "fake", scripts: { lint: "true" } }),
      );
      const bunShim = join(tmpRoot, "bun-shim.sh");
      await writeFile(bunShim, "#!/bin/sh\nexit 0\n");
      await chmod(bunShim, 0o755);

      const r = await resolveVesselMitosisEvaluate({
        type: "vessel_mitosis_evaluate",
        base_version_id: "v1",
        mitosis_version_id: "mitosis-X",
        mitosis_root: mitosisRoot,
        bun_cmd: bunShim,
      });
      const body = r.body as {
        verdict: string;
        cited_check_names?: string[];
        verdict_reason?: string;
      };
      expect(body.verdict).toBe("FAVORABLE");
      expect(body.verdict_reason).toBe("static_checks_pass");
      expect(Array.isArray(body.cited_check_names)).toBe(true);
      expect((body.cited_check_names ?? []).length).toBeGreaterThan(0);
      // Both lint and tests run by default → at least 2 named checks.
      expect((body.cited_check_names ?? []).some((n) => n.includes("lint"))).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("static eval: returns FAVORABLE when static_check_runner=skip via trace-only path", async () => {
    // With static_check_runner='skip', static eval is bypassed even when mitosis_root supplied.
    const traces = [
      vTrace("e_b1", "v1", "success"),
      vTrace("e_b2", "v1", "success"),
      vTrace("e_b3", "v1", "success"),
      vTrace("e_m1", "mitosis-X", "success"),
      vTrace("e_m2", "mitosis-X", "success"),
      vTrace("e_m3", "mitosis-X", "success"),
    ];
    globalThis.fetch = makeFetch(traces);
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
      mitosis_root: "/some/path",
      static_check_runner: "skip",
    });
    const body = r.body as { verdict: string; static_evaluation: unknown };
    expect(body.verdict).toBe("NEUTRAL");
    // static_evaluation field present (null when skipped)
    expect(body.static_evaluation).toBeNull();
  });
});
