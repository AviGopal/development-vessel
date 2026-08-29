import { describe, it, expect, afterEach } from "bun:test";
import { resolveVesselMitosisEvaluate, staticEvaluate } from "../../src/resolvers/vessel-mitosis-evaluate.js";
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
    // MUST be relative to now, not a literal date. The resolver clamps traces to a
    // deterministic window of `now - 30 days` (DEFAULT_WINDOW_HOURS, filtered at
    // `ts >= since`), so a hardcoded fixture date is a TIME BOMB: these tests passed
    // until wall-clock crossed that date + 30d, then every trace aged out of the
    // window, every version counted 0 traces, and four tests began asserting their
    // verdict against INSUFFICIENT_DATA. Nothing about these cases is date-specific —
    // they test relative recency, so the fixture must be recent by construction.
    executed_at: new Date().toISOString(),
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
  // Mirrors the gate's FAIL-CLOSED guard. TS1xxx = grammar/parse bails (tsc stops early,
  // truncating the error set; generic signatures collide across files → subset unsound).
  // TS2300/2440/2451/2393 = duplicate-identifier / redeclare / duplicate-implementation:
  // the tree does not compile and the class is cascade-prone (a NEW one can collide with a
  // dirty-base signature → new=0). Neither is ever a legitimate baseline to build on.
  const hasParseBail = (s: string) => /error TS1\d{3}:/.test(s) || /error TS(?:2300|2440|2451|2393):/.test(s);
  const syntaxBail = hasParseBail(mitOut) || hasParseBail(baseOut);
  return !cleanBaseDirtyMitosis && !syntaxBail && newSignatures.length === 0;
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
  // 2026-07-29 cascade: a syntax-broken landing made the base DIRTY-with-parse-error; tsc then
  // bailed early on both trees, so a NEW syntax error in a DIFFERENT file normalized to a generic
  // signature ALREADY in the (equally-truncated) base → new=0 → every subsequent broken patch
  // landed as a "subset". The syntax-bail guard fails closed on any TS1xxx in either tree.
  const SYNTAX_DIRTY_BASE = "src/resolvers/apply-proposal-as-patch.ts(441,41): error TS1005: ',' expected.";
  const SYNTAX_NEW_OTHER_FILE = "src/resolvers/gap-to-feature.ts(999,9): error TS1005: ',' expected.";
  it("parse-bail collision: NEW syntax error in another file, same signature as syntax-dirty base → REJECT", () => {
    expect(deltaAccepts(SYNTAX_DIRTY_BASE, SYNTAX_NEW_OTHER_FILE, 2, 2)).toBe(false);
  });
});

describe("mitosis delta gate: ACCEPTS legit deltas (delta-awareness preserved)", () => {
  it("unchanged dirty baseline (nothing new)", () => { expect(deltaAccepts(TYPE_5697f70, TYPE_5697f70, 1, 1)).toBe(true); });
  it("patch that FIXES the base error", () => { expect(deltaAccepts(TYPE_5697f70, "", 1, 0)).toBe(true); });
  it("same error, line shifted", () => { expect(deltaAccepts(TYPE_5697f70, TYPE_5697f70.replace("(1012,153)", "(1050,9)"), 1, 1)).toBe(true); });
  // No-over-block: boredom-vessel's long-standing baseline (METABOB_API_KEY undefined = TS2304,
  // NOT a fail-closed class) must STILL be delta-excused when the patch doesn't worsen it.
  const BOREDOM_BASELINE = "src/index.ts(1805,15): error TS2304: Cannot find name 'METABOB_API_KEY'.";
  it("boredom-vessel TS2304 baseline stays delta-excused (not a fail-closed class)", () => {
    expect(deltaAccepts(BOREDOM_BASELINE, BOREDOM_BASELINE, 1, 1)).toBe(true);
  });
});

// ── Redeclare / duplicate-symbol families are FAIL-CLOSED (2026-07-30) ───────────────
// Pins the TS2451 class that let goal-host 7b3168e ("let walkTerminationReason ... remove
// duplicate declaration" — the drafter INVERTED its own intent and ADDED a second decl) slip.
// These classes mean the tree does not compile and are cascade-prone: on a base already dirty
// with the SAME redeclare message, a NEW redeclare normalizes to a signature already present →
// new=0 → the plain subset test would ACCEPT it. The fail-closed guard rejects regardless.
const REDECLARE_WALK = "src/index.ts(3230,5): error TS2451: Cannot redeclare block-scoped variable 'walkTerminationReason'.";
const DUP_IDENT = "src/x.ts(10,7): error TS2300: Duplicate identifier 'foo'.";
describe("mitosis delta gate: REJECTS redeclare/duplicate families (fail-closed)", () => {
  it("TS2451 redeclare on a CLEAN base (7b3168e class)", () => {
    expect(deltaAccepts("", REDECLARE_WALK, 0, 2)).toBe(false);
  });
  it("TS2451 redeclare on a DIRTY base carrying the SAME redeclare signature (cascade) → REJECT", () => {
    // Plain subset would say new=0 and ACCEPT; fail-closed on TS2451 rejects it.
    expect(deltaAccepts(REDECLARE_WALK, REDECLARE_WALK, 2, 2)).toBe(false);
  });
  it("TS2300 duplicate identifier is fail-closed too", () => {
    expect(deltaAccepts("", DUP_IDENT, 0, 1)).toBe(false);
  });
});

// ── ROOT CAUSE: a check that never ran must NOT delta-excuse (2026-07-30) ─────────────
// The dominant slip for BOTH broken goal-host commits: the landing gate ran `bun run lint`,
// but goal-host-vessel has no `lint` script. bun prints `Script not found "lint"` and exits
// non-zero with ZERO `error TS` lines, so overlay and base both normalize to the EMPTY
// signature set, new=0, and the gate delta-excused a tree it NEVER TYPECHECKED. This drives
// the REAL staticEvaluate (overlay path) with a bun shim to prove the fix end-to-end.
import { mkdtemp as mkdtempX, mkdir as mkdirX, writeFile as writeFileX, rm as rmX, chmod as chmodX } from "node:fs/promises";
import { tmpdir as tmpdirX } from "node:os";
import { join as joinX } from "node:path";

async function makeBunShim(dir: string): Promise<string> {
  // Emulates bun: `run lint` → Script-not-found (exit 1); `run typecheck` → clean (exit 0);
  // `test` → exit 0. This is exactly goal-host-vessel's script surface.
  const shim = joinX(dir, "bun-shim.sh");
  await writeFileX(
    shim,
    "#!/bin/sh\n" +
      'if [ "$1" = "run" ]; then\n' +
      '  if [ "$2" = "typecheck" ]; then exit 0; fi\n' +
      '  echo "error: Script not found \\"$2\\"" 1>&2; exit 1\n' +
      "fi\n" +
      'if [ "$1" = "test" ]; then exit 0; fi\n' +
      "exit 0\n",
  );
  await chmodX(shim, 0o755);
  return shim;
}

describe("staticEvaluate: script-missing is fail-closed, not delta-excused", () => {
  it("scripts=[lint] on a vessel with no lint script → REFUSE (was: silently accepted)", async () => {
    const root = await mkdtempX(joinX(tmpdirX(), "mitosis-scriptmiss-"));
    try {
      const base = joinX(root, "base");
      const mit = joinX(root, "mit");
      await mkdirX(joinX(base, "src"), { recursive: true });
      await mkdirX(joinX(mit, "src"), { recursive: true });
      // base HAS package.json (only `typecheck`, like goal-host); mitosis is sparse (no pkg).
      await writeFileX(joinX(base, "package.json"), JSON.stringify({ name: "gh", scripts: { typecheck: "tsc --noEmit" } }));
      await writeFileX(joinX(base, "src", "foo.ts"), "export const a = 1;\n");
      await writeFileX(joinX(mit, "src", "foo.ts"), "export const a = 2;\n");
      const bunShim = await makeBunShim(root);
      const ev = await staticEvaluate(mit, bunShim, base, ["src/foo.ts"], ["lint"], true);
      expect(ev.ok).toBe(false);
      expect(ev.timed_out ?? false).toBe(false); // hard refuse, not a deferrable timeout
      expect(ev.reason).toMatch(/script_missing/);
    } finally {
      await rmX(root, { recursive: true, force: true });
    }
  });

  it("scripts=[typecheck] (the vessel's REAL script) still passes → no over-block", async () => {
    const root = await mkdtempX(joinX(tmpdirX(), "mitosis-scriptok-"));
    try {
      const base = joinX(root, "base");
      const mit = joinX(root, "mit");
      await mkdirX(joinX(base, "src"), { recursive: true });
      await mkdirX(joinX(mit, "src"), { recursive: true });
      await writeFileX(joinX(base, "package.json"), JSON.stringify({ name: "gh", scripts: { typecheck: "tsc --noEmit" } }));
      await writeFileX(joinX(base, "src", "foo.ts"), "export const a = 1;\n");
      await writeFileX(joinX(mit, "src", "foo.ts"), "export const a = 2;\n");
      const bunShim = await makeBunShim(root);
      const ev = await staticEvaluate(mit, bunShim, base, ["src/foo.ts"], ["typecheck"], true);
      expect(ev.ok).toBe(true);
    } finally {
      await rmX(root, { recursive: true, force: true });
    }
  });
});
