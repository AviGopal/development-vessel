// ADMISSION READS THE OWN-CHECK BASELINE (src/resolvers/own-check-baseline.ts) AT THE VESSEL'S CURRENT origin/dev.
// A gap whose own check was measured at the current base as green (green_at_parent) or red for its environment
// (red_environmental: the C1 shape, a live-DB check whose code's catch returns []) cannot be closed by a src draft, so
// admission excludes it, by a reason naming the sha and the signals, and the reason lands per gap in the
// gapAdmissionPass record. A code-reachable red is admitted. A baseline at another sha (the vessel moved) excludes
// nothing, and a gap with no baseline is admitted exactly as before.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `admit-ocb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, PROPOSALS_DIR: process.env.PROPOSALS_DIR, GAP_STORE_ENDPOINT: process.env.GAP_STORE_ENDPOINT };
// This node forwards its gap store (the stamp below must travel through the write shape to the holder).
const STORE = "http://127.0.0.1:9/v2/impulses/resolve";
process.env.GAP_STORE_ENDPOINT = STORE;
process.env.MITOSIS_RUNTIME_DIR = ROOT;
process.env.PROPOSALS_DIR = join(ROOT, "proposals");
mkdirSync(join(ROOT, "goal-host-vessel", "src"), { recursive: true });
writeFileSync(join(ROOT, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
writeFileSync(join(ROOT, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
mkdirSync(join(ROOT, "proposals"), { recursive: true });

const explicitOpenPolicy = (body: { pointer?: { type?: string; shape?: string }; impulse?: { type?: string } }): Response | null => {
  if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
    return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
  }
  if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
  return null;
};
const originalFetch = globalThis.fetch;
const stamped: Array<Record<string, any>> = [];
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap") return Response.json({ shape: "substrateGap", body: { gaps: [], total: 0 } });
    if (String(input) === STORE && body?.impulse?.pointer?.type === "substrateGap_write") { stamped.push(body.impulse.pointer); return Response.json({ shape: "substrateGap", body: { written: true } }); }
    return explicitOpenPolicy(body) ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  (modPolicy as { __resetPolicyReadsForTests: () => void }).__resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const modAdmission = await import("../../src/judge/gap-admission.js") as Record<string, unknown>;
const modPolicy = await import("../../src/judge/gap-policy.js") as Record<string, unknown>;
const g2f = await import("../../src/resolvers/gap-to-feature.js") as Record<string, unknown>;
const admitActionableGaps = modAdmission.admitActionableGaps as (g: Record<string, unknown>[], o?: unknown) => Promise<{ admitted: Record<string, unknown>[]; excluded: Array<{ id: string; reason: string }> }>;

const HEAD = "c".repeat(40);
const MOVED = "d".repeat(40);
const runner = (_v: string) => ({ ran: true, clean: false });
const TF = "test/checks/phase5.check.ts";
const TITLES = ["phase5 > returns traces"];
const CHECK = { shape: "test_suite", input: { vessel: "repos/goal-host-vessel", test_file: TF, only_tests: TITLES }, zero_field: "requested_not_passing" };
const baseline = (verdict: string, base_sha = HEAD, env_signals: string[] = []) => ({
  gap_id: "x", vessel: "goal-host-vessel", test_file: TF, only_tests: TITLES, base_sha, verdict, red: [], failing: [], expect_count: 1,
  call_path: [], call_path_source: null, env_signals, env_policy: "policy", dispatch_id: "disp-1", measured_at: "2026-01-01T00:00:00Z",
});
function gap(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary: "phase5 traces are empty", status: "open", detected_at: "2026-01-01T00:00:00Z",
    classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:1", falsifier: "class2", evidence_resolve: CHECK, ...meta },
  };
}
async function admit(gs: Record<string, unknown>[], head: string = HEAD) {
  const r = await admitActionableGaps(gs, { typecheckRunner: runner, baseShaOf: () => head });
  return { r, admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason };
}

describe("admission excludes a gap its own-check baseline shows no src draft can close", () => {
  it("MUST-FAIL the C1-shaped gap (red_environmental at the current base) is excluded, by sha and signals, and the reason is in the pass record", async () => {
    const env = gap("ocb-env-aaaa", { own_check_baseline: baseline("red_environmental", HEAD, ["S_live_import", "S_empty_received", "S_count_expected"]) });
    const { r, admittedIds, reasonOf } = await admit([env]);
    expect(admittedIds).not.toContain("ocb-env-aaaa");
    expect(reasonOf("ocb-env-aaaa")).toBe(`own_check_baseline_red_environmental(${HEAD.slice(0, 12)}; S_live_import+S_empty_received+S_count_expected)`);
    const body = (g2f.admissionPassBody as (p: unknown) => Record<string, any>)({ node: "n", candidates: 1, admitted: r.admitted, excluded: r.excluded, floored: [] });
    expect(body.excluded["ocb-env-aaaa"]).toBe(reasonOf("ocb-env-aaaa"));
    expect(body.by_reason["own_check_baseline_red_environmental"]).toBe(1);
  });

  it("MUST-FAIL green at the current base is excluded as own_check_baseline_green_at_parent(<sha12>)", async () => {
    const { admittedIds, reasonOf } = await admit([gap("ocb-green-bbbb", { own_check_baseline: baseline("green_at_parent") })]);
    expect(admittedIds).not.toContain("ocb-green-bbbb");
    expect(reasonOf("ocb-green-bbbb")).toBe(`own_check_baseline_green_at_parent(${HEAD.slice(0, 12)})`);
  });

  it("the first exclusion stamps the reading consumed, through the substrateGap write shape", async () => {
    stamped.length = 0;
    await admit([gap("ocb-env-stamp", { own_check_baseline: baseline("red_environmental", HEAD, ["S_precondition"]) })]);
    const w = stamped.find((p) => p.gap?.id === "ocb-env-stamp");
    expect(w?.gap?.classification_metadata?.own_check_baseline?.consumed?.by).toBe("admission");
  });

  it("a code-reachable red is admitted", async () => {
    const { admittedIds } = await admit([gap("ocb-code-cccc", { own_check_baseline: baseline("red_code_reachable") })]);
    expect(admittedIds).toContain("ocb-code-cccc");
  });

  it("CONTROL a baseline measured at another sha (the vessel moved) excludes nothing", async () => {
    const { admittedIds, reasonOf } = await admit([gap("ocb-moved-dddd", { own_check_baseline: baseline("red_environmental", HEAD, ["S_precondition"]) })], MOVED);
    expect(admittedIds).toContain("ocb-moved-dddd");
    expect(reasonOf("ocb-moved-dddd")).toBeUndefined();
  });

  it("CONTROL a gap with no baseline, and one with no evidence_resolve, are admitted as before", async () => {
    const plain = gap("ocb-plain-eeee", {});
    const nocheck = { ...gap("ocb-nocheck-ffff", {}), classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:1" } };
    const withOpt = await admitActionableGaps([plain, nocheck], { typecheckRunner: runner, baseShaOf: () => HEAD });
    const without = await admitActionableGaps([plain, nocheck], { typecheckRunner: runner });
    expect(withOpt.admitted.map((g) => String(g.id))).toEqual(without.admitted.map((g) => String(g.id)));
    expect(withOpt.excluded).toEqual(without.excluded);
    expect(withOpt.admitted.map((g) => String(g.id))).toContain("ocb-plain-eeee");
  });
});
