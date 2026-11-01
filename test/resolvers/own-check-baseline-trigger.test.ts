// THE OWN-CHECK BASELINE IS MEASURED FROM THE CHECK-SUPPLY TICK (gap-check-supply.ts dispatchOwnCheckBaselines), and
// the drafter is grounded on it (feature-compose baselineGrounding / baselineParentRun).
//   - each open row with a test_suite own check not measured at its vessel's current origin/dev gets ONE
//     development-vessel:own-check-baseline goal (target template, gap_id + base_ref, expected ownCheckBaseline), at most
//     the policy's own_check_baseline_per_tick; the dispatch is recorded on the row; a row measured (or sent) at the
//     current sha, or with no check, gets none; an earlier dispatch's execution id is read back and kept;
//   - an invalid policy, or none, measures nothing (the bound's default is 0);
//   - the compose: a code-reachable reading's call-path files and function names ground the draft; a reading at the
//     compose's HEAD stands in for the parent run (no run), one at another sha does not.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-baseline-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SUPER = join(ROOT, "super"), BAD = join(ROOT, "bad"), NONE = join(ROOT, "none");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const fc = await import("../../src/resolvers/feature-compose.js") as Record<string, any>;
const HEAD = "f".repeat(40), OLD = "1".repeat(40);
beforeAll(() => {
  for (const d of [SUPER, BAD, NONE]) mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(SUPER, "policies"), { recursive: true });
  writeFileSync(join(SUPER, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: 2 }));
  mkdirSync(join(BAD, "policies"), { recursive: true });
  writeFileSync(join(BAD, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: "lots" }));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const row = (id: string, meta: Record<string, unknown>) => ({ id, status: "open", category: "systematic_failure", source: "substrate_detected", summary: "s", classification_metadata: meta });
const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" } };
async function tick(open: Array<Record<string, unknown>>, env = SUPER) {
  const sends: Array<Record<string, any>> = [];
  const writes: Array<{ id: string; meta: Record<string, any> }> = [];
  let n = 0;
  const sent = await supply.dispatchOwnCheckBaselines(open as never, {
    node: "node-a", nowIso: "2026-01-01T00:00:00Z", env: { SUPER_REPO_DIR: env },
    write: async (r: Record<string, unknown>, m: Record<string, unknown>) => { writes.push({ id: String(r["id"]), meta: m as Record<string, any> }); return { shape: "substrateGap", body: {} }; },
    send: (async (p: Record<string, any>) => { sends.push(p); n += 1; return { shape: "goalDispatchResult", body: { dispatch_id: `disp-${n}` } }; }) as never,
    headOf: () => HEAD,
    executionIdOf: async (d: string) => (d === "disp-old" ? "exec-old" : null),
  });
  return { sent, sends, writes };
}

describe("the check-supply tick dispatches own-check baselines", () => {
  it("MUST-FAIL a row with an unmeasured own check gets one own-check-baseline goal, recorded on the row", async () => {
    expect(typeof (supply as Record<string, unknown>).dispatchOwnCheckBaselines).toBe("function");
    const { sent, sends, writes } = await tick([row("g-a", check)]);
    expect(sent).toEqual([{ id: "g-a", base_sha: HEAD, dispatch_id: "disp-1" }]);
    expect(sends[0]!.target_template_id).toBe("development-vessel:own-check-baseline");
    expect(sends[0]!.expected_output_shapes).toEqual(["ownCheckBaseline"]);
    expect(sends[0]!.variables).toEqual({ gap_id: "g-a", base_ref: HEAD });
    expect(writes[0]!.meta.own_check_baseline_dispatches).toEqual([{ base_sha: HEAD, dispatch_id: "disp-1", at: "2026-01-01T00:00:00Z", node: "node-a" }]);
  });

  it("the per-tick bound is the policy's; a row measured or sent at the current sha, or with no check, gets none", async () => {
    const rows = [
      row("g-measured", { ...check, own_check_baseline: { base_sha: HEAD } }),
      row("g-sent", { ...check, own_check_baseline_dispatches: [{ base_sha: HEAD, dispatch_id: "d0" }] }),
      row("g-nocheck", {}),
      row("g-1", check), row("g-2", check), row("g-3", check),
    ];
    const { sent } = await tick(rows);
    expect(sent.map((s) => s.id).sort()).toHaveLength(2);
    expect(sent.map((s) => s.id)).not.toContain("g-measured");
    expect(sent.map((s) => s.id)).not.toContain("g-sent");
    expect(sent.map((s) => s.id)).not.toContain("g-nocheck");
  });

  it("an earlier dispatch's execution id is read back from goal-host and kept beside it", async () => {
    const { writes } = await tick([row("g-old", { ...check, own_check_baseline: { base_sha: OLD }, own_check_baseline_dispatches: [{ base_sha: OLD, dispatch_id: "disp-old" }] })]);
    expect(writes[0]!.meta.own_check_baseline_dispatches[0]).toEqual({ base_sha: OLD, dispatch_id: "disp-old", execution_id: "exec-old" });
    expect(writes[0]!.meta.own_check_baseline_dispatches[1].base_sha).toBe(HEAD);
  });

  it("CONTROL an invalid policy, or no policy file, measures nothing", async () => {
    for (const env of [BAD, NONE]) {
      const { sent, sends, writes } = await tick([row("g-a", check)], env);
      expect(sent).toEqual([]);
      expect(sends).toEqual([]);
      expect(writes).toEqual([]);
    }
  });
});

describe("the compose reads the baseline", () => {
  const b = (verdict: string, base_sha = HEAD) => ({
    gap_id: "g-a", vessel: "fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"], base_sha, verdict,
    red: ["a > b"], failing: [{ name: "a > b" }], expect_count: 3,
    call_path: [{ path: "repos/fixture-vessel/src/widget.ts", fn: "parseWidget", line: 7 }, { path: "repos/fixture-vessel/test/helper.test.ts", fn: "h", line: 1 }],
    call_path_source: "frames", env_signals: [], env_policy: "policy", dispatch_id: "disp-1", measured_at: "x",
  });
  const own = { test_file: "test/a.test.ts", only_tests: ["a > b"] };

  it("MUST-FAIL a code-reachable reading grounds the draft on its call path: src files as targets, function names as probes", () => {
    expect(typeof fc.baselineGrounding).toBe("function");
    const g = fc.baselineGrounding(b("red_code_reachable"));
    expect(g.files).toEqual(["repos/fixture-vessel/src/widget.ts"]);
    expect(g.probes).toEqual(["parseWidget", "h"]);
    expect(fc.baselineGrounding(b("red_environmental")).files).toEqual([]);
    expect(fc.baselineGrounding(null).probes).toEqual([]);
  });

  it("MUST-FAIL a reading at the compose's HEAD stands in for the parent run; at another sha, or for another check, it does not", () => {
    const meta = { ...check, own_check_baseline: b("red_code_reachable") };
    const fold = fc.baselineParentRun(meta, HEAD, "g-a", "repos/fixture-vessel", own);
    expect(fold?.run).toEqual({ sha: HEAD, raw: null, cached: "baseline", red: ["a > b"], failing: [{ name: "a > b" }], expects: 3, call_path: b("red_code_reachable").call_path });
    expect(fc.baselineParentRun(meta, OLD, "g-a", "repos/fixture-vessel", own)).toBeNull();
    expect(fc.baselineParentRun(meta, HEAD, "g-a", "repos/fixture-vessel", { ...own, only_tests: ["other"] })).toBeNull();
    expect(fc.baselineParentRun({ ...check, own_check_baseline: b("unrunnable") }, HEAD, "g-a", "repos/fixture-vessel", own)).toBeNull();
  });

  it("the compose uses both at their sites (grounding probes, check-import targets, the parent run)", () => {
    const src = require("node:fs").readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8") as string;
    expect(src).toMatch(/const regionProbes = \[regionHint, \.\.\.baselineProbes,/);
    expect(src).toMatch(/ownCheckImportedModules\(ownCheckCtx, \(\) => ownCheckCtx\.root\), \.\.\.\(ownCheckCtx\.vessel === composeBaseline\?\.vessel \? baselineCallPathFiles : \[\]\)/);
    expect(src).toMatch(/const fold = gateGapMeta \? baselineParentRun\(gateGapMeta, sha, gapId, v, own\) : null;/);
  });
});
