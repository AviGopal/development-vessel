// GATE 9, CHECK_SATISFIED_BY_GUTTING (ruling 2026-10-24). One extra mutant replaces the body of the edit-site function
// the check calls with its fallback return (an existing early return that uses nothing the function binds, else the
// zero value of its declared return type). A check GREEN under it is passed by a "fix" that removes the behaviour:
// refused, with the reason as the drafter's arm lesson. PRE-REGISTERED REPLAYS, each check verbatim from its commit,
// against its edit site at the sha it was armed on (fixtures; the rows' own evidence, read from the live store, one
// node name in the light-dispatch summary replaced by "one node"):
//  - light-dispatch ac2ed275 (answerOutcome of a resolved:false answer must not be ok), site src/failure-type.ts at
//    a3aeedca^: answerOutcome has no early return free of its locals, so its zero value { ok: false } (AnswerOutcome's
//    one required field) is returned, and the check passes: REFUSED. Gate 9 is run on it alone: end to end, the region
//    gate already refuses it at this gate's parent (armed live before the token-anchor region).
//  - goal-host 39fbacd (carryForward drops an object error body), site src/walk-pool.ts at 39fbacd: carryForward has no
//    early return, so it returns [] (CarriedStep[]), and the check passes: REFUSED at arm, end to end. Armed live, and
//    at this gate's parent.
// CONTROL: the light-dispatch check with the control the reason asks for (a success answer stays ok) in the same test
// is not passed by the gutted site. The hand-written 5e69d7a0 correct check is the other control
// (gap-check-supply-region-pair-5e69d7a0.test.ts, armed).
// END TO END on the harness of gap-check-supply-region-regate.test.ts: every run through the REAL resolveTestSuite.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";
import { landCheck } from "./landed-check.fixture.js";

const ROOT = join(tmpdir(), `gcs-gut-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const ev = (f: string) => JSON.parse(fixture(f)) as { summary: string; falsifier_spec?: string | null; must_fail?: string | null; control?: string | null; region?: string | null };

const LD = { vessel: "fixture-ld", siteRel: "src/failure-type.ts" };
const GH = { vessel: "fixture-gh", siteRel: "src/walk-pool.ts" };
const TREES: Record<string, Record<string, string>> = {
  [LD.vessel]: { [LD.siteRel]: fixture("light-dispatch-failure-type.a3aeedca-parent.ts.txt") },
  [GH.vessel]: { [GH.siteRel]: fixture("goal-host-walk-pool.39fbacd.ts.txt"), "src/judge-view.ts": fixture("goal-host-judge-view.39fbacd.ts.txt"), "src/reach-date.ts": fixture("goal-host-reach-date.39fbacd.ts.txt") },
};
// The reason, by value: the gate's parent has no export of it.
const GUTTING = "check_satisfied_by_gutting: a fix that removes the behaviour passes it; add a control asserting the behaviour that must remain";
const LD_CHECK = fixture("ac2ed275-resolved-false-answer-outcome.check.ts.txt");
const LD_WITH_CONTROL = LD_CHECK.replace("expect(outcome.ok).toBe(false);", "expect(outcome.ok).toBe(false);\n  // Control: an answer with a result stays a success.\n  expect(mod.answerOutcome({ body: { value: 1 } }).ok).toBe(true);");

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5, mutants_per_file: 6 } });
const git = (vessel: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: join(CLONES, vessel), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const [vessel, tree] of Object.entries(TREES)) {
    for (const base of [join(CLONES, vessel), join(RUNTIME, vessel)]) {
      for (const d of ["test/checks", "node_modules"]) mkdirSync(join(base, d), { recursive: true });
      for (const [rel, text] of Object.entries(tree)) { mkdirSync(join(base, rel, ".."), { recursive: true }); writeFileSync(join(base, rel), text); }
    }
    writeFileSync(join(CLONES, vessel, ".gitignore"), "node_modules\n");
    git(vessel, "init", "-q");
    git(vessel, "add", "-A");
    git(vessel, "commit", "-q", "-m", "fixture: the site");
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
      let vessel = LD.vessel;
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='([^']*)'/, (_m, p: string) => { vessel = basename(p); return `ROOT='${join(CLONES, vessel)}'`; });
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: join(CLONES, vessel), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
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
beforeEach(() => { execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const gutGateOf = (r: Row | undefined): Row => (((ledgerOf(r)["mutation_gate"] ?? {}) as Row)["gut_gate"] ?? {}) as Row;
const lessonsOf = (r: Row | undefined): Row[] => (Array.isArray(metaOf(r)["failure_lessons"]) ? (metaOf(r)["failure_lessons"] as Row[]) : []);
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);
async function tick(): Promise<void> {
  await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: later() } as never);
  await sg.__settleBirthEvaluationsForTests();
}
/** Seed a row with its own evidence, dispatch, land and commit `check`, and judge it. */
async function landAndArm(prefix: string, check: string, e: ReturnType<typeof ev>, at: { vessel: string; siteRel: string }): Promise<Row> {
  const id = T(prefix);
  const site = `repos/${at.vessel}/${at.siteRel}`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: e.summary,
    classification_metadata: { edit_site: site, ...(e.must_fail ? { must_fail: e.must_fail } : {}), ...(e.control ? { control: e.control } : {}), ...(e.falsifier_spec ? { falsifier_spec: e.falsifier_spec } : {}), ...(e.region ? { region: e.region } : {}) } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  await tick();
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id) });
  writeFileSync(join(CLONES, at.vessel, checkPathOf(id)), check);
  git(at.vessel, "add", "-A");
  git(at.vessel, "commit", "-q", "-m", `check ${id}`);
  landCheck(join(CLONES, at.vessel), checkPathOf(id));
  await tick();
  return (await storeRow(id))!;
}

/** Commit `check` in the fixture vessel and run gate 9 on it alone, as the arm step does (the REAL test_suite run). */
async function gutGate(prefix: string, check: string, at: { vessel: string; siteRel: string }): Promise<{ kind: string; reason?: string; record?: Row }> {
  const testFile = `test/checks/${prefix}-${RUN}.check.ts`;
  writeFileSync(join(CLONES, at.vessel, testFile), check);
  git(at.vessel, "add", "-A");
  git(at.vessel, "commit", "-q", "-m", `check ${prefix}`);
  landCheck(join(CLONES, at.vessel), testFile);
  const gate = supply["guttingGate"] as (a: { vessel: string; siteRel: string; testFile: string; checkSrc: string; titles: string[] }) => Promise<{ kind: string; reason?: string; record?: Row }>;
  return gate({ vessel: at.vessel, siteRel: at.siteRel, testFile, checkSrc: check, titles: supply.declaredTestTitles(check) });
}

describe("gate 9: a check the gutted edit-site function passes is not armed", () => {
  // End to end, this check is already refused at this gate's parent, by the region gate (region_red_unchanged on the
  // derived token region in budgetRefusalOf), so it never reaches gate 9 there: the gate is replayed on it alone.
  it("[MUST-FAIL] light-dispatch ac2ed275: answerOutcome gutted to { ok: false } passes it: REFUSED", async () => {
    const g = await gutGate("gut-ld", LD_CHECK, LD);
    expect(g.kind).toBe("refuse");
    expect(g.reason).toBe(GUTTING);
    expect(g.record).toMatchObject({ functions: ["answerOutcome"], green: true, replacement: "{ return { ok: false } as any; }" });
  }, 240_000);

  it("[MUST-FAIL] goal-host 39fbacd, end to end: carryForward gutted to [] passes it: REFUSED at arm, one arm lesson", async () => {
    const row = await landAndArm("gut-gh", fixture("39fbacd-carry-forward-error-body.check.ts.txt"), ev("39fbacd-row-evidence.json"), GH);
    expect(ledgerOf(row)["last_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(ledgerOf(row)["reason"]).toBe(GUTTING);
    expect(gutGateOf(row)).toMatchObject({ functions: ["carryForward"], green: true, replacement: "{ return [] as any; }" });
    expect(lessonsOf(row).map((l) => [l["class"], l["stage"], l["reason"]])).toEqual([["check_satisfied_by_gutting", "arm", GUTTING]]);
  }, 240_000);

  it("[CONTROL] the same light-dispatch check with its control (a success answer stays ok) is not passed by the gutted site", async () => {
    const g = await gutGate("gut-ld-ctl", LD_WITH_CONTROL, LD);
    expect(g.kind).toBe("pass");
    expect(g.record).toMatchObject({ functions: ["answerOutcome"], green: false });
  }, 240_000);

  // THE EARLY-RETURN RULE, read statically: activity-api's seedPriorFromConcepts at cbbe8fa6 (the import line of its
  // prior-seed identifier-query test) guts to its first early return that uses nothing it binds, `return FALLBACK` (a
  // module constant), so its zero value (SeededPrior's fields at zero) is not reached.
  it("[PIN] an early return free of the function's bindings is its fallback: seedPriorFromConcepts guts to `return FALLBACK`", () => {
    const m = supply.guttingMutant(fixture("activity-api-prior-seed.cbbe8fa6.ts.txt"), "import { seedPriorFromConcepts } from '../src/lib/prior-seed';\n", "src/lib/prior-seed.ts");
    expect(m?.functions).toEqual(["seedPriorFromConcepts"]);
    expect(m?.replacement).toBe("{ return FALLBACK as any; }");
  });
});
