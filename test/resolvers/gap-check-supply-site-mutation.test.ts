// THE ARM STEP REFUSES A CHECK WHOSE RED DOES NOT DEPEND ON ITS EDIT SITE (2026-10-22).
//
// A check red for an assertion, on a contract its target has, armed though no change to the edit site could move it:
// it mocks the module it asserts on (activity-api 2138d94), its mock lacks the key the code calls so the site throws
// before any branch and the check's own fallback decides (goal-host 979b966d), it reads `.shapes` off a value the site returns as a Promise (goal-host
// 725638cc), or it passes the site an argument it cannot use, so every branch gives the same NaN (2182d140). The arm step
// now runs the check under operator mutants of the EDIT SITE (scope-earn-in selectMutants over the declarations the check
// names, applied on the committed tree by test_suite's mutate_edit through lib/apply-mutant.ts) and refuses it,
// `red_independent_of_edit_site`, when at least one mutant measured and none changed the failing assertion.
//
// The 979b966d model is the one the gate can refuse: the mock lacks the key, the site throws before any branch, and the
// check's own fallback decides. Where the SITE catches the error and its fallback decides, a mutant of that fallback moves
// the red, so the gate does not refuse it (a named limit; its control pins the boundary).
// The fixtures are those four classes, reduced to one small site (src/widget.ts) so they run here; the checks keep each
// original's mechanism. END TO END: the clone is a git repo with the check committed, the birth judge's test_suite runs
// through the REAL resolveTestSuite (its shell is bash on the temp clone), and so does every mutant run.
//
// Named mutants of the rule this file kills: (R1) the gate never consulted (every hollow case arms); (R2) a mutant that
// keeps the check red with a different Received counted as unchanged (the moved-value control is refused); (R3) a mutant
// run that did not measure (the check threw instead of asserting) counted as a change (the 979b966d case arms);
// (R4) mutants taken over the whole file rather than the declarations the check names (the moved-value control, whose
// function is not among the whole file's k=2 picks, is refused).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-sitemut-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const HOLDER = "http://holder.test/v2/impulses/resolve";
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
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const SITE_REL = "src/widget.ts";
const SITE = `repos/${VESSEL}/${SITE_REL}`;
const WIDGET = `import { createPort } from "./port";

const TABLE = (() => { const t = { base: 2 }; return t; })();
export const BASE = TABLE.base;

export function score(n: number): number {
  if (n > 2) return n * BASE;
  return 0;
}

export async function infer(goal: string): Promise<{ targets: string[] }> {
  return goal.includes("net") ? { targets: ["shellResult"] } : { targets: [] };
}

export async function verify(goal: string): Promise<{ reached: boolean }> {
  const port = createPort();
  const r = await port.judge(\`Goal: \${goal}\`);
  if (!r) return { reached: false };
  return { reached: r.verdict === "ACCEPT" };
}

export async function verifyCaught(goal: string): Promise<{ reached: boolean }> {
  try {
    const port = createPort();
    const r = await port.judge(\`Goal: \${goal}\`);
    return { reached: r.verdict === "ACCEPT" };
  } catch {
    return { reached: false };
  }
}

export function delayMs(base: number, streak: number): number {
  if (streak > 1) return base * 2;
  return base;
}
`;
const PORT = `export function createPort(): { judge(prompt: string): Promise<{ verdict: string }> } {\n  throw new Error("no endpoint configured");\n}\n`;
const H = `import { describe, expect, mock, test } from "bun:test";\n`;
const CHECKS = {
  // activity-api 2138d94: mocks the very module it asserts on, so the site never runs.
  mocksItsTarget: `${H}mock.module("../../src/widget", () => ({ BASE: 2, score: (_n: number) => 1, infer: async () => ({ targets: [] }), verify: async () => ({ reached: false }), delayMs: () => 0 }));\nimport * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("score of three is six", () => { expect(mod.score(3)).toBe(6); });\n});\n`,
  // goal-host 979b966d: the mocked dependency lacks the key the site calls, so the site throws before any branch and
  // the check's own fallback decides every time.
  mockKeyAbsent: `${H}mock.module("../../src/port", () => ({ createPort: () => ({ messages: { create: async () => ({ verdict: "ACCEPT" }) } }) }));\nimport * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("a goal about today is reached", async () => {\n    const v = await mod.verify("what is happening today?").catch(() => ({ reached: false }));\n    expect(v.reached).toBe(true);\n  });\n});\n`,
  // The NAMED LIMIT's boundary: the same absent mock key, but the SITE catches the error and its own fallback decides.
  // Flipping that fallback's boolean turns the check green, so its red does depend on the site: not refused.
  siteCaughtError: `${H}mock.module("../../src/port", () => ({ createPort: () => ({ messages: { create: async () => ({ verdict: "ACCEPT" }) } }) }));\nimport * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("a goal about today is reached (site catches)", async () => {\n    const v = await mod.verifyCaught("what is happening today?");\n    expect(v.reached).toBe(true);\n  });\n});\n`,
  // goal-host 725638cc: reads .shapes off what the site returns as a Promise of { targets }.
  shapesOnAPromise: `${H}import * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("a network ask maps to shellResult", () => {\n    expect(mod.BASE).toBe(2);\n    const decision: any = mod.infer("scan net devices");\n    expect(Array.isArray(decision?.shapes) ? decision.shapes : []).toContain("shellResult");\n  });\n});\n`,
  // 2182d140: hands the site a row where it takes a number, so every branch answers NaN.
  unusableArgument: `${H}import * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("a future dispatch_after imposes a delay", () => {\n    const row: any = { dispatch_after: "2099-01-01T00:00:00Z" };\n    const d = Number(mod.delayMs(row, 1));\n    expect(d).toBeGreaterThan(0);\n  });\n});\n`,
  // CONTROL: red on the value the site computes; a mutant of score moves the Received, still red.
  movedValue: `${H}import * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("score of three is seven", () => { expect(mod.score(3)).toBe(7); });\n});\n`,
  // CONTROL: red on the site's branch; negating it turns the check green.
  flipsGreen: `${H}import * as mod from "../../src/widget";\ndescribe("widget", () => {\n  test("a second attempt is not doubled", () => { expect(mod.delayMs(5, 2)).toBe(5); });\n});\n`,
} as const;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
/** Every test_suite run: which check, mutated or not, and on which node. */
let suiteRuns: Array<{ test_file: unknown; mutant: boolean; on_holder: boolean }> = [];
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5, mutants_per_file: 2 } });

const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: join(CLONES, VESSEL), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try { return await fn(); } finally { if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was; }
}
async function runSuite(pointer: Row): Promise<Response> {
  const r = await resolveTestSuite(pointer as never);
  suiteRuns.push({ test_file: pointer["test_file"], mutant: pointer["mutate_edit"] !== undefined, on_holder: !process.env["GAP_STORE_ENDPOINT"] });
  return Response.json({ success: true, shape: r.shape, body: r.body });
}
async function holderAnswers(pointer: Row): Promise<Response> {
  return asHolder(async () => {
    if (pointer["type"] === "test_suite") return runSuite(pointer);
    let r: { shape: string; body: unknown };
    if (pointer["type"] === "substrateGap") r = await sg.resolveSubstrateGap(pointer as never);
    else if (pointer["type"] === "substrateGap_write") r = await sg.resolveSubstrateGapWrite(pointer as never);
    else r = { shape: "structuredError", body: { detail: `the test holder does not serve ${String(pointer["type"])}` } };
    await sg.__settleBirthEvaluationsForTests();
    return Response.json(r);
  });
}

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) {
    for (const d of ["src", "test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
    writeFileSync(join(base, SITE_REL), WIDGET);
    writeFileSync(join(base, "src/port.ts"), PORT);
  }
  writeFileSync(join(CLONES, VESSEL, ".gitignore"), "node_modules\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: the site");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url === HOLDER) return holderAnswers((imp.pointer ?? {}) as Row);
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-${Math.random().toString(36).slice(2, 8)}` }, { status: 202 });
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") return runSuite(imp.pointer as Row);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability" && (body?.pointer ?? imp?.pointer)?.shape === "shellResult") {
      return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    }
    if (url.startsWith("http://shell.test")) {
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='[^']*'/, `ROOT='${join(CLONES, VESSEL)}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, VESSEL), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      return Response.json({ stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) });
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
beforeEach(() => { suiteRuns = []; delete process.env["GAP_STORE_ENDPOINT"]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { delete process.env["GAP_STORE_ENDPOINT"]; expect(execGuard?.restore() ?? []).toEqual([]); });

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const stored = async (id: string): Promise<Row | undefined> => asHolder(async () => (((await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never)).body as { gaps?: Row[] }).gaps ?? [])[0]);
async function seed(id: string): Promise<void> {
  const summary = `fixture ${id}: ${SITE} \`score\` computes the wrong value`;
  const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never));
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
async function tick(now: number, forwarding: boolean): Promise<void> {
  if (forwarding) process.env["GAP_STORE_ENDPOINT"] = HOLDER;
  try { await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never); } finally { delete process.env["GAP_STORE_ENDPOINT"]; }
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
/** Seed a gap, dispatch for it, land (and commit) `check` as its check file, and let the arm step judge it. */
async function landAndArm(prefix: string, check: string, forwarding = false): Promise<{ id: string; row: Row }> {
  const id = T(prefix);
  await seed(id);
  await tick(later(), forwarding);
  expect(ledgerOf(await stored(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), edit_site: SITE });
  writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), check);
  git("add", "-A");
  git("commit", "-q", "-m", `check ${id}`);
  landCheck(join(CLONES, VESSEL), checkPathOf(id));
  await tick(later(), forwarding);
  if (forwarding) await tick(later(), true); // the hand-off, then the settlement from the holder's stamp
  return { id, row: (await stored(id))! };
}
const refusedAsIndependent = (row: Row): void => {
  expect(ledgerOf(row)["last_verdict"]).toBe("present"); // red at HEAD: without the gate it would arm
  expect(ledgerOf(row)["state"]).toBe("arm_refused");
  expect(String(ledgerOf(row)["reason"])).toStartWith("red_independent_of_edit_site:");
  const g = ledgerOf(row)["mutation_gate"] as Row;
  expect(g).toMatchObject({ site: SITE_REL, k: 2, changed: 0, region: "declarations_the_check_names" });
  expect(Number(g["measured"])).toBeGreaterThan(0);
};

describe("a check whose red is the same under every mutant of its edit site is refused before arming", () => {
  it("[MUST-FAIL] a check that mocks the module it asserts on (2138d94) is refused: red_independent_of_edit_site", async () => {
    const { id, row } = await landAndArm("mut-mock-target", CHECKS.mocksItsTarget);
    refusedAsIndependent(row);
    expect(metaOf(row)["evidence_resolve"] ?? null).toBeNull();
    // Cost: the birth run, then at most k (2) mutant runs of the same check (here, through the in-process test_suite).
    expect(suiteRuns.filter((r) => r.test_file === checkPathOf(id) && !r.mutant).length).toBe(1);
    expect((ledgerOf(row)["mutation_gate"] as Row)["ran"]).toBe(2);
  });

  it("[MUST-FAIL] a check whose mock lacks the key the site calls (979b966d) is refused", async () => {
    const { row } = await landAndArm("mut-mock-key", CHECKS.mockKeyAbsent);
    refusedAsIndependent(row);
    expect(Number((ledgerOf(row)["mutation_gate"] as Row)["unmeasured"])).toBeGreaterThan(0); // the emptied body made it throw: told nothing
  });

  it("[MUST-FAIL] a check reading .shapes off the Promise the site returns (725638cc) is refused", async () => {
    const { row } = await landAndArm("mut-shapes", CHECKS.shapesOnAPromise);
    refusedAsIndependent(row);
  });

  it("[MUST-FAIL] a check passing the site an argument it cannot use (2182d140) is refused", async () => {
    const { row } = await landAndArm("mut-arg", CHECKS.unusableArgument);
    refusedAsIndependent(row);
  });

  it("[MUST-FAIL] on a node that forwards its gap store the same check is refused too, its mutant runs read at the holder", async () => {
    const { id, row } = await landAndArm("mut-fwd", CHECKS.mocksItsTarget, true);
    refusedAsIndependent(row);
    const mutantRuns = suiteRuns.filter((r) => r.test_file === checkPathOf(id) && r.mutant);
    expect(mutantRuns.length).toBe(2);
    expect(mutantRuns.every((r) => r.on_holder)).toBe(true);
  });
});

describe("a check whose red moves under a mutant of its edit site still arms", () => {
  it("[CONTROL] a check whose Received moves under a site mutant (still red) arms", async () => {
    const { row } = await landAndArm("mut-moved", CHECKS.movedValue);
    expect(ledgerOf(row)["state"]).toBe("armed");
  });

  it("[CONTROL] a check that a site mutant turns green arms", async () => {
    const { row } = await landAndArm("mut-green", CHECKS.flipsGreen);
    expect(ledgerOf(row)["state"]).toBe("armed");
  });

  it("[CONTROL] NAMED LIMIT: a site-caught-error check (979b966d's original model) flips under flip_boolean, so it is correctly NOT refused", async () => {
    const { row } = await landAndArm("mut-caught", CHECKS.siteCaughtError);
    expect(ledgerOf(row)["state"]).toBe("armed");
  });

  it("[MUST-FAIL] an armed check's ledger keeps the gate's reading: the mutant that moved it, and no run past the first", async () => {
    const moved = await landAndArm("mut-moved-rec", CHECKS.movedValue);
    expect(ledgerOf(moved.row)["mutation_gate"]).toMatchObject({ site: SITE_REL, k: 2, changed: 1, ran: 1, region: "declarations_the_check_names" });
    expect(suiteRuns.filter((r) => r.test_file === checkPathOf(moved.id)).length).toBe(1); // the birth run; the one mutant ran in process
    const caught = await landAndArm("mut-caught-rec", CHECKS.siteCaughtError);
    expect(ledgerOf(caught.row)["mutation_gate"]).toMatchObject({ changed: 1, unmeasured: 1, changed_by: { operator: "flip_boolean" } });
  });

  it("[CONTROL] on a forwarding node a check whose red moves arms", async () => {
    const { row } = await landAndArm("mut-fwd-moved", CHECKS.movedValue, true);
    expect(ledgerOf(row)["state"]).toBe("armed");
  });
});
