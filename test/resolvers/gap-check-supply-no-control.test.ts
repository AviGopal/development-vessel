// THE CHECK WRITER IS GIVEN THE ROW'S MUST-FAIL AND ASKED FOR A CONTROL, AND THE ARM STEP REFUSES A CHECK WITH NONE.
//
// An arming-only landing armed a goal-host check that tested the wrong failure kind and expected a literal no src line
// holds: the drafter was never told the row's meta.must_fail (it reached only the region gate) and was never asked for
// a control, so nothing in the check showed the code still does what the defect does not touch. checkSupplyGoal now
// carries the must-fail (or asks for the expected value in the title) and always asks for a CONTROL; the arm step
// refuses a check whose every new test is red at HEAD (check_no_control), and the reason tells the next draft to add one.
//
// The MF cases are red at the parent; the CONTROL cases hold at both ends, except the red-plus-green arm, which the
// parent refused (every new title had to be red). The arm cases run end to end as
// gap-check-supply-contract-mismatch.test.ts: the birth judge's test_suite is the REAL resolveTestSuite on a temp clone.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-control-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SELF_RESOLVE_ENDPOINT"] = "http://self.test/v2/impulses/resolve";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const SITE_REL = "src/widget.ts";
const SITE = `repos/${VESSEL}/${SITE_REL}`;
// The defect: add subtracts. add(2, 1) must be 3; add(5, 0) is 5 either way (the control's input, untouched by it).
const TREE: Record<string, string> = { [SITE_REL]: "export function add(a: number, b: number): number {\n  return a - b;\n}\n" };
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let lastShellOutput = "";
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) {
    for (const d of ["test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
    for (const [rel, text] of Object.entries(TREE)) { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); }
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      const r = await resolveTestSuite(imp.pointer);
      return Response.json({ shape: r.shape, body: r.body });
    }
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${join(CLONES, VESSEL)}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, VESSEL), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      lastShellOutput = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      return Response.json({ stdout: lastShellOutput });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [dueRhythm()], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
async function seed(id: string): Promise<void> {
  const summary = `fixture ${id}: ${SITE} \`add\` returns 1 for add(2, 1) where 3 is required`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<void> {
  await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** Seed a gap, let the supply dispatch for it, land `check` as its check file, and let the arm step judge it. */
async function landAndArm(prefix: string, check: string): Promise<Row> {
  const id = T(prefix);
  await seed(id);
  await tick(later());
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), edit_site: SITE });
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), check);
  await tick(later());
  return (await storeRow(id))!;
}

const ROW_MUST_FAIL = "X returns 3";
const siteReader = { read: (rel: string): string | null => (rel === SITE_REL ? TREE[SITE_REL]! : null) };
const goalFor = (meta: Row | null): string => supply.checkSupplyGoal(VESSEL, "test/checks/x.check.ts", "add returns 1 where 3 is required", SITE, siteReader as never, [], [], meta);
const RED = `  test("add(2, 1) is 3", () => { expect(mod.add(2, 1)).toBe(3); });\n`;
const GREEN = `  test("add(5, 0) stays 5 (control)", () => { expect(mod.add(5, 0)).toBe(5); });\n`;
const checkOf = (...tests: string[]): string => `import { describe, expect, test } from "bun:test";\nimport * as mod from "../../src/widget";\ndescribe("add", () => {\n${tests.join("")}});\n`;

describe("the check goal carries the row's must-fail and asks for a control", () => {
  it("[MF1] a row with meta.must_fail gets a goal that states it as the expected value", () => {
    expect(goalFor({ must_fail: ROW_MUST_FAIL })).toContain(`After the fix, this must hold: ${ROW_MUST_FAIL}.`);
  });
  it("[MF2] every code-site goal asks for a CONTROL test, and names the row's control when it has one", () => {
    expect(goalFor(null)).toContain("Write a second test, a CONTROL: an input the defect does not touch");
    expect(goalFor({ control: "add(5, 0) is 5" })).toContain("The control: add(5, 0) is 5.");
  });
  it("[MF2b] with no must_fail the goal asks for the expected value in the failing test's title", () => {
    expect(goalFor({})).toContain("Name the expected (correct) value in the failing test's title.");
  });
  it("[MF2c] a long must_fail and control are clamped, and the goal stays inside MAX_GOAL_LEN", () => {
    const goal = goalFor({ must_fail: "y".repeat(5000), control: "z".repeat(5000) });
    expect(goal).toContain("y".repeat(200));
    expect(goal).not.toContain("y".repeat(301));
    expect(goal).not.toContain("z".repeat(301));
    expect(goal.length).toBeLessThan(8192);
  });
  it("[MF-a] after a check_no_control refusal, the next attempt's goal tells it to add a control", () => {
    const prior = [{ state: "arm_refused", titles: ["add(2, 1) is 3"], reason: String(supply["CHECK_NO_CONTROL_REASON"] ?? "") }];
    const goal = supply.checkSupplyGoal(VESSEL, "test/checks/x.check.ts", "add returns 1 where 3 is required", SITE, undefined, [], prior as Row[], null);
    expect(goal).toContain("check_no_control: every new test is red at HEAD; add a CONTROL test");
  });
  it("[CONTROL] a config-site goal is unchanged: no must-fail or control sentence", () => {
    const reader = { read: (rel: string): string | null => (rel === "src/seed/a.ts" ? `export const T = { id: "a1", tasks: [{ resolver: "r1" }] };\n` : null), list: (): string[] => [] };
    const goal = supply.checkSupplyGoal(VESSEL, "test/checks/x.check.ts", "a template is wrong", `repos/${VESSEL}/src/seed/a.ts`, reader as never, [], [], { must_fail: ROW_MUST_FAIL, control: "c" });
    expect(goal).toContain("is configuration");
    expect(goal).not.toContain("this must hold");
    expect(goal).not.toContain("a CONTROL:");
  });
});

describe("the arm step refuses a check with no control", () => {
  it("[MF3] a check whose every new test is red at HEAD is NOT armed: check_no_control", async () => {
    const row = await landAndArm("nc-red", checkOf(RED));
    expect(metaOf(row)["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toStartWith("check_no_control:");
  });
  it("[CONTROL] one red must-fail plus one green control arms, the control kept in the predicate", async () => {
    const row = await landAndArm("nc-pair", checkOf(RED, GREEN));
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(metaOf(row)["predicate_birth_verdict"]).toBe("present");
    const only = ((metaOf(row)["evidence_resolve"] as Row)["input"] as Row)["only_tests"];
    expect(only).toEqual(["add(2, 1) is 3", "add(5, 0) stays 5 (control)"]);
  });
  it("[CONTROL] a check whose every new test passes at HEAD is still green_at_head, not check_no_control", async () => {
    const row = await landAndArm("nc-green", checkOf(GREEN));
    expect(ledgerOf(row)["state"]).toBe("green_at_head");
  });
});
