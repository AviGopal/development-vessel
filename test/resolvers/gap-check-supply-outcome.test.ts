// CHECK-FIRST (gap gap-check-supply-never-reads-its-dispatch-outcome-so-a-failed-test-writing-goal-sits-goal-dispatched-forever).
//
// Bootstrap item 2 (src/resolvers/gap-check-supply.ts) dispatches a test-writing goal per needs-localization gap and
// arms the gap only when new titles appear in its test file. Measured 2026-10-06: 9 of 9 treatment gaps sat at
// state=goal_dispatched with attempts=1 after their goals ended reached:false, no test written, and the tick recorded
// alpha for every dispatch. These pin the contract the lane's fix must meet; they say WHAT the tick does, not how:
//   (i)   credit: a tick that only dispatched settles NEITHER leg (alpha only when a check arms);
//   (ii)  outcome: a dispatched gap whose goal is terminal and not reached (goal-host GET /executions/:id, the
//         contract dispatch-goal.ts already reads) with no new titles is recorded as a failed attempt, with a reason;
//   (iii) scope: a gap whose target is under an excluded path of the live autonomyScope record gets no goal and one
//         skip record (the lane can never land it);
//   (iv)  retry: a failed gap past its backoff gets its retry within two ticks even while fresh gaps keep arriving.
// Each has a CONTROL that is green at HEAD. Fixtures run on a temp gap store and temp clones; fetch is stubbed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `gcs-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let rhythms: Row[] = [];
/** goal-host's dispatch records, by dispatch id: what GET /executions/:id answers. Absent ⇒ 404. */
let executions: Record<string, { status: string; reached: boolean | null }> = {};
/** The live autonomyScope record's excluded paths (null ⇒ no record). */
let excluded: string[] | null = null;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3, ...extra },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test"), join(RUNTIME, VESSEL, "src")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const rec = executions[decodeURIComponent(exec[1]!)];
      return rec ? Response.json({ dispatchId: exec[1], ...rec }) : new Response("not found", { status: 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const rows = excluded === null ? [] : [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: excluded, require_falsifier_classes: ["class2"] } }];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  restoreCutoverExecModules();
  __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  goals = []; executions = {}; excluded = ["repos/some-other-vessel/"]; rhythms = [dueRhythm()];
  execGuard = installCutoverExecGuard();
  g2f.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
async function seed(id: string, what: string): Promise<void> {
  const summary = `${what} fixture ${RUN}: local-tools-vessel src/widget.ts widget returns the wrong value`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: {} } } as never);
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
const goalsFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);
/** Close every open fixture gap, so an ordering case sees only the gaps it seeds. */
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-outcome.test.ts" };
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
    if (w.shape === "structuredError") throw new Error("fixture close refused: " + JSON.stringify(w.body));
  }
  await sg.__settleBirthEvaluationsForTests();
}

describe("gap-check-supply (i): credit is earned by an armed check, not by a dispatch", () => {
  it("MUST-FAIL: a tick that only dispatched settles neither leg", () => {
    expect(supply.checkSupplySettlementLeg({ dispatched: 1, armed: 0, refused: 0 })).toBeNull();
  });
  it("CONTROL: an armed check is alpha, all refused is beta, nothing done is neither", () => {
    expect(supply.checkSupplySettlementLeg({ dispatched: 0, armed: 1, refused: 0 })).toBe("alpha");
    expect(supply.checkSupplySettlementLeg({ dispatched: 0, armed: 0, refused: 1 })).toBe("beta");
    expect(supply.checkSupplySettlementLeg({ dispatched: 0, armed: 0, refused: 0 })).toBeNull();
  });
});

describe("gap-check-supply (ii): a dispatched goal's outcome is read back", () => {
  it("MUST-FAIL: a goal that ended not reached, with no test written, is recorded as a failed attempt with a reason", async () => {
    const id = T("gcs-failed");
    await seed(id, "failed-goal");
    const t0 = Date.now() + 1000 * 3600_000;
    await tick(t0);
    expect(goalsFor(id).length).toBe(1);
    const dispatchId = String(ledgerOf(await storeRow(id))["dispatch_id"] ?? "");
    expect(dispatchId).not.toBe("");
    executions[dispatchId] = { status: "completed", reached: false };
    await tick(t0 + 3600_000); // inside the backoff: no new goal, but the outcome must be read
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).not.toBe("goal_dispatched");
    expect(String(led["reason"] ?? "")).not.toBe("");
    expect(Number(led["attempts"])).toBe(1);
  });
  it("CONTROL: a goal still running stays goal_dispatched", async () => {
    const id = T("gcs-running");
    await seed(id, "running-goal");
    const t0 = Date.now() + 1100 * 3600_000;
    await tick(t0);
    const dispatchId = String(ledgerOf(await storeRow(id))["dispatch_id"] ?? "");
    executions[dispatchId] = { status: "running", reached: null };
    await tick(t0 + 3600_000);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("goal_dispatched");
  });
});

describe("gap-check-supply (iii): a target the lane can never land is not dispatched", () => {
  it("MUST-FAIL: a gap whose target is under an excluded path of the live autonomyScope record gets no goal and one skip record", async () => {
    excluded = [`repos/${VESSEL}/`];
    const id = T("gcs-excluded");
    await seed(id, "excluded-target");
    await tick(Date.now() + 1200 * 3600_000);
    expect(goalsFor(id).length).toBe(0);
    const led = ledgerOf(await storeRow(id));
    expect(String(led["state"] ?? "")).not.toBe("goal_dispatched");
    expect(JSON.stringify(led)).toContain(`repos/${VESSEL}/`);
  });
  it("CONTROL: with only another vessel excluded, the gap is dispatched", async () => {
    const id = T("gcs-allowed");
    await seed(id, "allowed-target");
    await tick(Date.now() + 1300 * 3600_000);
    expect(goalsFor(id).length).toBe(1);
  });
});

describe("gap-check-supply (iv): a due retry competes with fresh gaps", () => {
  it("MUST-FAIL: a failed gap past its backoff is retried within two ticks while fresh gaps keep arriving", async () => {
    rhythms = [dueRhythm({ max_per_tick: 1 })];
    await closeAllOpen();
    const old = T("gcs-retry-old");
    await seed(old, "retry-old");
    const t0 = Date.now() + 1400 * 3600_000;
    await tick(t0);
    expect(goalsFor(old).length).toBe(1);
    executions[String(ledgerOf(await storeRow(old))["dispatch_id"] ?? "")] = { status: "completed", reached: false };
    for (const n of [1, 2, 3]) await seed(T(`gcs-retry-fresh${n}`), `retry-fresh${n}`);
    const after = t0 + 30 * 3600_000; // past the 24 h backoff
    await tick(after);
    await tick(after + 60_000);
    expect(goalsFor(old).length).toBe(2);
  });
  it("CONTROL: a fresh gap is dispatched on the first tick", async () => {
    rhythms = [dueRhythm({ max_per_tick: 1 })];
    await closeAllOpen();
    const id = T("gcs-fresh-only");
    await seed(id, "fresh-only");
    await tick(Date.now() + 1500 * 3600_000);
    expect(goalsFor(id).length).toBe(1);
  });
});
