// THE OWN-CHECK BASELINE GOAL NAMES ITS VERDICTS (gap-check-supply.ts dispatchOwnCheckBaselines). goal-host's reach
// judge reads the goal text: "measure ..." read as asking for a quantity, so every baseline run, whose output is a
// classification, was judged hollow. The goal now says "classify ... as" and lists the four OwnCheckBaselineVerdict
// values (own-check-baseline.ts); the routing (target template, expected shape, variables) is unchanged.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `own-check-baseline-goal-text-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SUPER = join(ROOT, "super");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const HEAD = "e".repeat(40);
beforeAll(() => {
  mkdirSync(join(SUPER, ".git"), { recursive: true });
  mkdirSync(join(SUPER, "policies"), { recursive: true });
  writeFileSync(join(SUPER, "policies", "ownCheckEnvironmentPolicy.json"), JSON.stringify({ own_check_baseline_per_tick: 1 }));
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

const check = { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" } };
async function sendOne(): Promise<Record<string, any>> {
  const sends: Array<Record<string, any>> = [];
  await supply.dispatchOwnCheckBaselines([{ id: "g-a", status: "open", category: "systematic_failure", source: "substrate_detected", summary: "s", classification_metadata: check }] as never, {
    node: "node-a", nowIso: "2026-01-01T00:00:00Z", env: { SUPER_REPO_DIR: SUPER },
    write: async () => ({ shape: "substrateGap", body: {} }),
    send: (async (p: Record<string, any>) => { sends.push(p); return { shape: "goalDispatchResult", body: { dispatch_id: "disp-1" } }; }) as never,
    headOf: () => HEAD,
    executionIdOf: async () => null,
  });
  expect(sends).toHaveLength(1);
  return sends[0]!;
}

describe("the own-check baseline goal asks for a classification", () => {
  it("MUST-FAIL the goal says classify and names all four verdicts, never measure", async () => {
    const goal = String((await sendOne()).goal);
    expect(goal).toContain("classify");
    for (const v of ["green_at_parent", "red_code_reachable", "red_environmental", "unrunnable"]) expect(goal).toContain(v);
    expect(goal).not.toContain("measure");
    expect(goal).toContain(`g-a's own check fixture-vessel/test/a.test.ts at base ${HEAD.slice(0, 12)}`);
  });

  it("CONTROL the routing is unchanged: target template, expected shape and variables", async () => {
    const p = await sendOne();
    expect(p.type).toBe("dispatch_goal");
    expect(p.target_template_id).toBe("development-vessel:own-check-baseline");
    expect(p.expected_output_shapes).toEqual(["ownCheckBaseline"]);
    expect(p.variables).toEqual({ gap_id: "g-a", base_ref: HEAD });
  });
});
