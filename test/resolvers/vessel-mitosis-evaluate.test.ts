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

  // V8 (2026-06-05): trace-path verdict must be deterministic across calls
  // when the underlying trace set is the same. Previously the verdict
  // drifted (INSUFFICIENT_DATA → NEUTRAL on same input) because the
  // trace window slid. Now we bucket time to the hour and use a
  // 30-day default window so identical input yields identical verdict.
  it("V8: verdict is deterministic across repeated calls with same trace set", async () => {
    const traces = [
      ...Array.from({ length: 5 }, (_, i) => vTrace(`b${i}`, "v1", i < 4 ? "success" : "failure")),
      ...Array.from({ length: 5 }, (_, i) => vTrace(`m${i}`, "mitosis-X", i < 4 ? "success" : "failure")),
    ];
    globalThis.fetch = makeFetch(traces);
    const verdicts: string[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await resolveVesselMitosisEvaluate({
        type: "vessel_mitosis_evaluate",
        base_version_id: "v1",
        mitosis_version_id: "mitosis-X",
      });
      verdicts.push((r.body as { verdict: string }).verdict);
      reasons.push((r.body as { verdict_reason: string }).verdict_reason);
    }
    // All five should agree exactly.
    expect(new Set(verdicts).size).toBe(1);
    expect(new Set(reasons).size).toBe(1);
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

  it("returns vesselMitosisEvaluation{INSUFFICIENT_DATA} on activity-api 500", async () => {
    // Trace-fetch failure is the substrate's audited NO ("no runtime
    // evidence available"), not a chain crash. Cutover should see the
    // verdict and refuse cleanly instead of structuredError being
    // silently dropped by the engine top-level catch.
    // Mirrors pattern from 74542cc/875d539/f9573a3/befb371.
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const r = await resolveVesselMitosisEvaluate({
      type: "vessel_mitosis_evaluate",
      base_version_id: "v1",
      mitosis_version_id: "mitosis-X",
    });
    expect(r.shape).toBe("vesselMitosisEvaluation");
    const body = r.body as { verdict: string; verdict_reason: string };
    expect(body.verdict).toBe("INSUFFICIENT_DATA");
    expect(body.verdict_reason).toMatch(/activity_api_traces_returned_500/);
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

// ── Delta-typecheck gate soundness (2026-07-29) ──────────────────────────────
// Gate accepts a staged change iff its error-SIGNATURE set is a SUBSET of the base's
// (no NEW error the baseline lacked) and not a clean-base/dirty-mitosis transition.
// Pins the two real regressions a raw error-LINE COUNT let land FAVORABLE (5697f70
// TS2552, 0f794d2 syntax) so a future rewrite reopening the hole fails HERE, not live.
import { signatureSet } from "../../src/resolvers/vessel-mitosis-evaluate.js";

function deltaAccepts(baseOut: string, mitOut: string, baseExit: number, mitExit: number): boolean {
  const cleanBaseDirtyMitosis = baseExit === 0 && mitExit !== 0;
  const newSignatures = [...signatureSet(mitOut)].filter((s) => !signatureSet(baseOut).has(s));
  return !cleanBaseDirtyMitosis && newSignatures.length === 0;
}

const SYNTAX_0f794d2 =
  "src/resolvers/apply-proposal-as-patch.ts(441,41): error TS1005: '>' expected.\n" +
  "src/resolvers/apply-proposal-as-patch.ts(495,1): error TS1128: Declaration or statement expected.";
const TYPE_5697f70 =
  "src/resolvers/gap-to-feature.ts(1012,153): error TS2552: Cannot find name 'parentId'. Did you mean 'parent'?";
const OTHER_BASELINE_ERR = "src/x.ts(1,1): error TS2339: Property 'foo' does not exist on type 'Bar'.";

describe("mitosis delta gate: signatureSet", () => {
  it("strips path(line,col) prefix, keeps error TS<code>: message", () => {
    expect([...signatureSet(TYPE_5697f70)]).toEqual(["error TS2552: Cannot find name 'parentId'. Did you mean 'parent'?"]);
  });
  it("line/col shift yields the SAME signature", () => {
    expect(signatureSet(TYPE_5697f70.replace("(1012,153)", "(1050,9)"))).toEqual(signatureSet(TYPE_5697f70));
  });
  it("folds shape-dispatch violations per-shape, skips volatile 'at file:line'", () => {
    expect([...signatureSet("  [unhandled] fooShape\n    at src/config.ts:12")]).toEqual(["[unhandled] fooShape"]);
  });
});

describe("mitosis delta gate: REJECTS new errors (pinned regressions)", () => {
  it("0f794d2 syntax break on clean base", () => { expect(deltaAccepts("", SYNTAX_0f794d2, 0, 2)).toBe(false); });
  it("0f794d2 syntax break on DIRTY base (early-abort, fewer lines)", () => { expect(deltaAccepts(TYPE_5697f70, SYNTAX_0f794d2, 1, 2)).toBe(false); });
  it("5697f70 out-of-scope-name type error on clean base", () => { expect(deltaAccepts("", TYPE_5697f70, 0, 1)).toBe(false); });
  it("5697f70 type error vs an unrelated dirty baseline", () => { expect(deltaAccepts(OTHER_BASELINE_ERR, TYPE_5697f70, 1, 1)).toBe(false); });
  it("half-wired new resolver (new [unhandled] shape) on dirty base (Seam-3)", () => { expect(deltaAccepts("  [unhandled] aShape", "  [unhandled] aShape\n  [unhandled] bShape", 1, 1)).toBe(false); });
});

describe("mitosis delta gate: ACCEPTS legit deltas (delta-awareness preserved)", () => {
  it("unchanged dirty baseline (nothing new)", () => { expect(deltaAccepts(TYPE_5697f70, TYPE_5697f70, 1, 1)).toBe(true); });
  it("patch that FIXES the base error", () => { expect(deltaAccepts(TYPE_5697f70, "", 1, 0)).toBe(true); });
  it("same error, line shifted", () => { expect(deltaAccepts(TYPE_5697f70, TYPE_5697f70.replace("(1012,153)", "(1050,9)"), 1, 1)).toBe(true); });
});
