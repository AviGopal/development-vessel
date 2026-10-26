// THE 5e69d7a0 PAIR UNDER THE REGION GATE (qa, 2026-10-24). The gap: the check supply's edit-site mutation gate refuses
// to arm a check (red_independent_of_edit_site) and logs nothing. Its region, derived from the row's evidence since the
// anchor-source ruling, is the token red_independent_of_edit_site: both refusal returns of editSiteMutationGate,
// replaced together by one mutant.
//  - 5e69d7a0's own system-authored check asserts on outcomeKindOf over a literal ledger body, a function the gap is
//    not about. Its red survives replacing the region: REFUSED, region_red_unchanged.
//  - A hand-written CORRECT check drives the arm step to that refusal (canned test_suite reports, no nested runs) and
//    asserts the arm_refused write AND the one journal line naming the gap and the reason. Red today on the missing
//    line; with the region replaced the refusal never happens, so its first assertion fails instead (Expected
//    "arm_refused", Received "armed"): its failure signature moves, and it ARMS.
// So the signature branch held: the omission fallback ("unmeasured: omission") is not needed for this gap.
//
// END TO END, as gap-check-supply-region-mutant.test.ts: the fixture clone is this vessel's own src/ (committed in a
// temp git repo, its node_modules linked), every run goes through the REAL resolveTestSuite, and the edit site is the
// clone's src/resolvers/gap-check-supply.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-pair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const supply = await import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const REPO = join(import.meta.dir, "..", "..");
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const VESSEL = "fixture-dv";
const SITE = `repos/${VESSEL}/src/resolvers/gap-check-supply.ts`;
const ROW = JSON.parse(fixture("5e69d7a0-row-evidence.json")) as { summary: string; must_fail: string; control: string; falsifier_spec: string };

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", require_control: false, budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5, mutants_per_file: 6 } });
const clone = join(CLONES, VESSEL);
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: clone, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(join(clone, "test/checks"), { recursive: true });
  mkdirSync(join(clone, "test/resolvers"), { recursive: true });
  cpSync(join(REPO, "src"), join(clone, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) cpSync(join(REPO, f), join(clone, f));
  cpSync(join(REPO, "test/resolvers/isolated-gap-store-run.ts"), join(clone, "test/resolvers/isolated-gap-store-run.ts"));
  writeFileSync(join(clone, "test/checks/mg-log-env.ts"), fixture("5e69d7a0-correct-arm-refusal-logs.env.ts.txt"));
  symlinkSync(join(REPO, "node_modules"), join(clone, "node_modules"));
  writeFileSync(join(clone, ".gitignore"), "node_modules\n");
  mkdirSync(RUNTIME, { recursive: true });
  symlinkSync(clone, join(RUNTIME, VESSEL));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture: this vessel's src");
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
      const local = String(imp?.pointer?.command ?? "").replace(/^ROOT='([^']*)'/, (_m, p: string) => `ROOT='${join(CLONES, basename(p))}'`);
      const p = Bun.spawnSync(["bash", "-c", local], { cwd: clone, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
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
const regionGateOf = (r: Row | undefined): Row => (((ledgerOf(r)["mutation_gate"] ?? {}) as Row)["region_gate"] ?? {}) as Row;
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
/** Seed the 5e69d7a0 row (its own evidence, no literal region), dispatch, land and commit `check`, and judge it. */
async function landAndArm(prefix: string, check: string): Promise<Row> {
  const id = T(prefix);
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: ROW.summary,
    classification_metadata: { edit_site: SITE, must_fail: ROW.must_fail, control: ROW.control, falsifier_spec: ROW.falsifier_spec } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  await tick();
  expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id) });
  writeFileSync(join(clone, checkPathOf(id)), check);
  git("add", "-A");
  git("commit", "-q", "-m", `check ${id}`);
  await tick();
  return (await storeRow(id))!;
}

describe("the 5e69d7a0 pair under the region gate (token anchor red_independent_of_edit_site)", () => {
  it("[MUST-FAIL] 5e69d7a0's own check (outcomeKindOf) is REFUSED: region_red_unchanged", async () => {
    const row = await landAndArm("pair-own", fixture("5e69d7a0-mutation-gate-refusal-logs.check.ts.txt"));
    expect(ledgerOf(row)["last_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("arm_refused");
    expect(String(ledgerOf(row)["reason"])).toStartWith("region_red_unchanged:");
    expect(regionGateOf(row)).toMatchObject({ region: "derived_from_token_anchor", anchor: "red_independent_of_edit_site", occurrences: 2, measured: 1, changed: 0 });
  }, 240_000);

  it("[CONTROL] the hand-written correct check (arm_refused write AND the log line) ARMS: its signature moves under the region mutant", async () => {
    const row = await landAndArm("pair-correct", fixture("5e69d7a0-correct-arm-refusal-logs.check.ts.txt"));
    expect(ledgerOf(row)["last_verdict"]).toBe("present");
    expect(ledgerOf(row)["state"]).toBe("armed");
    expect(regionGateOf(row)).toMatchObject({ region: "derived_from_token_anchor", anchor: "red_independent_of_edit_site", occurrences: 2, measured: 1, changed: 1 });
  }, 240_000);
});
