// B′ P3: THE SUPPLY ASKS FOR ONE OUT-OF-SUITE CHECK AND ARMS IT BY THE SHARED CLASSIFIER (check-first, 2026-10-08).
//
// gap-check-supply's test-writing goal named test/gap-<slug>.test.ts, or APPENDED to an existing *.test.ts that
// imports the edit site. Either way the intended red landed in a file bun's default discovery runs, so the pre-cutover
// suite, the post-land suite and pull-sync all read it as a regression. B′: the goal names exactly
// test/checks/<checkSupplyCheckFile(gap)> (one slug definition, shared with feature_compose's R3 gate), never an
// existing file; it says what the verify enforces (ONE failing test whose assertion fails because of the defect,
// importing the edit site as a namespace, no network, no src changes); and the arm step judges the landed check by
// the same W2 import rule and the same red-reason classifier as the verify (via test_suite's red_reason), so the two
// cannot disagree.
//
// END TO END (no stub between the arm and bun): the arm's evidence_resolve goes through the ONE birth judge
// (takeBirthVerdictWithReport -> evaluateGapCheck -> the self-resolve HTTP call, answered here by the REAL
// resolveTestSuite) whose shell call runs the resolver's real command with the bun on PATH against a temp clone. So
// "the check is measured" means P0's ./<path> run actually executed the .check.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `gcs-checkfile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SELF_RESOLVE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SELF_RESOLVE_ENDPOINT"] = "http://self.test/v2/impulses/resolve";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const H = `import { expect, test } from "bun:test";\n`;
const SITE = `repos/${VESSEL}/src/widget.ts`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
/** Every test_suite report the birth judge observed, with what bun printed for it. */
let suiteRuns: Array<{ body: Row; output: string }> = [];
/** Simulate a test_suite that predates red_reason (an older evaluator): strip the field from its report. */
let stripRedReason = false;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(), body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 5 } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of ["src", "test/checks", "node_modules"]) mkdirSync(join(CLONES, VESSEL, d), { recursive: true });
  mkdirSync(join(RUNTIME, VESSEL, "src"), { recursive: true });
  for (const base of [join(CLONES, VESSEL), join(RUNTIME, VESSEL)]) writeFileSync(join(base, "src", "widget.ts"), "export const widget = 1;\n");
  // an existing test that already imports the edit site: the old supply would APPEND to it
  writeFileSync(join(CLONES, VESSEL, "test", "widget.test.ts"), `${H}import { widget } from "../src/widget";\ntest("widget is one", () => { expect(widget).toBe(1); });\n`);
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) { goals.push({ goal: String(body.goal ?? ""), variables: body.variables }); return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 }); }
    // the birth judge's self-resolve of the gap's check: answered by the REAL test_suite resolver
    if (url === "http://self.test/v2/impulses/resolve" && imp?.pointer?.type === "test_suite") {
      const r = await resolveTestSuite(imp.pointer);
      const b = { ...((r.body ?? {}) as Row) };
      if (stripRedReason) delete b["red_reason"];
      suiteRuns.push({ body: b, output: lastShellOutput });
      return Response.json({ shape: r.shape, body: b });
    }
    // test_suite's discovery and shell: the resolver's real command, ROOT pointed at the temp clone
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
let lastShellOutput = "";
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
beforeEach(() => { goals = []; suiteRuns = []; stripRedReason = false; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
async function seed(id: string, meta: Row = {}): Promise<void> {
  const summary = `fixture ${id}: repos/${VESSEL}/src/widget.ts widget returns 1 where 2 is required`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
const goalFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);
const checkPathOf = (id: string): string => `test/checks/${(csa["checkSupplyCheckFile"] as (x: string) => string)(id)}`;
let clock = Date.now() + 5000 * 3600_000;
const later = (): number => (clock += 30 * 3600_000);

describe("B′ P3: the supply's goal names one out-of-suite check", () => {
  it("[MUST-FAIL] checkSupplyTestFile is test/checks/<checkSupplyCheckFile(id)> — the one slug the R3 gate allows", () => {
    expect(typeof csa["checkSupplyCheckFile"]).toBe("function");
    for (const id of ["gap-Env_gated SF.discount", "route-edit-abc", "x"]) expect(supply.checkSupplyTestFile(id)).toBe(checkPathOf(id));
  });

  it("[MUST-FAIL] the goal names the exact check path, the edit site as a namespace import, ONE assertion-red test, no network and no src changes", async () => {
    const id = T("p3-goal");
    await seed(id);
    await tick(later());
    expect(goalFor(id).length).toBe(1);
    const goal = goalFor(id)[0]!.goal;
    expect(goal.startsWith(`Write ONE failing test in repos/${VESSEL}/${checkPathOf(id)} that reproduces: `)).toBe(true);
    expect(goal).toContain('import * as mod from "../../src/widget"');
    expect(goal).toMatch(/assertion fails because of the defect/i);
    expect(goal).toMatch(/no network/i);
    expect(goal).toContain("Do not change src/");
    const led = ledgerOf(await storeRow(id));
    expect(led).toMatchObject({ state: "goal_dispatched", test_file: checkPathOf(id), vessel: VESSEL, edit_site: SITE });
  });

  it("[MUST-FAIL] NO APPEND: a gap whose edit site already has an importing *.test.ts still gets its own check file", async () => {
    const id = T("p3-noappend");
    await seed(id);
    await tick(later());
    const goal = goalFor(id)[0]?.goal ?? "";
    expect(goal).not.toMatch(/^Append/);
    expect(goal).not.toContain("test/widget.test.ts");
    const led = ledgerOf(await storeRow(id));
    expect(led["test_file"]).toBe(checkPathOf(id));
    expect(led["mode"]).not.toBe("append");
  });

  it("[MUST-FAIL] a retry of a gap whose old ledger named a discovered *.test.ts is re-asked for the check file", async () => {
    const id = T("p3-oldledger");
    await seed(id, { check_supply: { state: "arm_refused", attempts: 1, last_dispatch_at: new Date(clock - 100 * 3600_000).toISOString(), test_file: "test/gap-old.test.ts", vessel: VESSEL, mode: "new_file" } });
    await tick(later());
    expect(goalFor(id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["test_file"]).toBe(checkPathOf(id));
  });
});

describe("B′ P3: the arm step measures the landed .check.ts through P0 and judges it by the shared classifier", () => {
  it("[MUST-FAIL] a namespace-import assertion red arms; its evidence_resolve test_suite run EXECUTES the file (ran, requested_not_passing >= 1)", async () => {
    const id = T("p3-arm");
    await seed(id);
    await tick(later());
    const title = `p3 widget is two ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${title}", () => { expect(mod.widget).toBe(2); });\n`);
    await tick(later());
    const m = metaOf(await storeRow(id));
    expect(ledgerOf(await storeRow(id))["state"]).toBe("armed");
    expect(m["evidence_resolve"]).toEqual({ shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: checkPathOf(id), only_tests: [title] }, zero_field: "requested_not_passing" });
    expect(m["edit_site"]).toBe(SITE);
    expect(m["predicate_birth_verdict"]).toBe("present");
    const run = suiteRuns.find((r) => r.body["test_file"] === checkPathOf(id));
    expect(run).toBeDefined();
    expect(run!.output).toContain(`bun test v${Bun.version}`);
    expect(run!.output).toContain(title);
    expect(run!.body).toMatchObject({ ran: true, requested_not_passing: 1 });
    expect(Number(run!.body["requested_not_passing"])).toBeGreaterThanOrEqual(1);
    expect(((run!.body["red_reason"] as Row).failures as Row[])[0]).toMatchObject({ name: title, cls: "assertion" });
  });

  it("[MUST-FAIL] a named test that is red because of a refused connection is NOT armed: the shared classifier names the reason", async () => {
    const id = T("p3-net");
    await seed(id);
    await tick(later());
    const title = `p3 net red ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${title}", async () => { const r = await fetch("http://127.0.0.1:1/"); expect(r.ok && mod.widget === 2).toBe(true); });\n`);
    await tick(later());
    const m = metaOf(await storeRow(id));
    expect(m["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(await storeRow(id))["state"]).toBe("arm_refused");
    expect(String(ledgerOf(await storeRow(id))["reason"])).toMatch(/network/);
  });

  it("[MUST-FAIL] a report with no red_reason (an older test_suite) arms nothing: fail closed", async () => {
    const id = T("p3-noreason");
    await seed(id);
    await tick(later());
    const title = `p3 noreason ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import * as mod from "../../src/widget";\ntest("${title}", () => { expect(mod.widget).toBe(2); });\n`);
    stripRedReason = true;
    await tick(later());
    expect(metaOf(await storeRow(id))["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(await storeRow(id))["state"]).toBe("arm_refused");
    expect(String(ledgerOf(await storeRow(id))["reason"])).toContain("red_reason");
  });

  it("[MUST-FAIL] W2 at arm: a check importing the edit site only by a DYNAMIC import(...) counts (the verify's rule)", async () => {
    const id = T("p3-dyn");
    await seed(id);
    await tick(later());
    const title = `p3 dyn ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}test("${title}", async () => { const m = await import("../../src/widget.ts"); expect(m.widget).toBe(2); });\n`);
    await tick(later());
    expect(ledgerOf(await storeRow(id))["state"]).toBe("armed");
    expect(metaOf(await storeRow(id))["edit_site"]).toBe(SITE);
  });

  it("[MUST-FAIL] W2 at arm: a check whose only link to the edit site is a TYPE-ONLY import (erased at runtime) is NOT armed", async () => {
    const id = T("p3-typeonly");
    await seed(id);
    await tick(later());
    const title = `p3 typeonly ${RUN}`;
    // an assertion red that never touches the erased binding: only W2 can refuse it
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import type * as mod from "../../src/widget";\ntest("${title}", () => { expect(2).toBe(1); });\n`);
    await tick(later());
    expect(metaOf(await storeRow(id))["evidence_resolve"]).toBeUndefined();
    expect(ledgerOf(await storeRow(id))["state"]).toBe("arm_refused");
    expect(String(ledgerOf(await storeRow(id))["reason"])).toMatch(/test_writing_check_misses_edit_site/);
  });

  it("[CONTROL] W2 at arm: a type import PLUS a separate value import of the edit site arms", async () => {
    const id = T("p3-typeplus");
    await seed(id);
    await tick(later());
    const title = `p3 typeplus ${RUN}`;
    writeFileSync(join(CLONES, VESSEL, checkPathOf(id)), `${H}import type { widget as W } from "../../src/widget";\nimport * as mod from "../../src/widget";\ntest("${title}", () => { const w: typeof W = mod.widget; expect(w).toBe(2); });\n`);
    await tick(later());
    expect(ledgerOf(await storeRow(id))["state"]).toBe("armed");
    expect(metaOf(await storeRow(id))["edit_site"]).toBe(SITE);
  });
});
