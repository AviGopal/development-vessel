// A NON-ATTEMPT AND A REFUSAL ARE NOT FAILED ATTEMPTS (CHANGE-30: ONE classification in check-supply).
//
// check-supply settled every not-reached outcome as dispatch_failed and backed off 24 h (a deferred landing's park,
// kept 24 h, then expired just before the retry), and a send the receiver REFUSED (the spend-rate breaker's 429) left
// NO record at all, so the next tick sent it again: 455 sends of one goal in a day, while the accepted sends of the
// same gaps could not be recorded either (the write gate refused the full ledger: the goal text quotes a placeholder).
// goal-host now names a non-success structurally (`outcome` {kind non_attempt | refused, retry_after_s?}) on
// GET /executions/:id and on its 429 body; check-supply records BEFORE it sends and classifies once.
//
//   [MUST-FAIL] (1) a probe-time NON-ATTEMPT (a deferred landing) is not charged: no dispatch_failed, the attempt given
//               back, and no re-send before the shaped non_attempt_delay_s; after it, it is sent again.
//   [MUST-FAIL] (2) the write gate refuses the full ledger write (the goal text carries an unquoted placeholder):
//               a 429 REFUSAL at tick 1 is recorded as send_refused with the receiver's retry_after_s, and tick 2
//               does not re-send it.
//   [MUST-FAIL] (3) the non-attempt wait is BOUNDED: 10 consecutive non-attempts give <= 24 sends in any 24 h window,
//               with each wait longer than the last up to the shaped cap (max_non_attempt_delay_s).
//   [CONTROL]   a settled outcome (a genuine failure) after a non-attempt resets the streak.
//   [CONTROL]   a genuine not-reached outcome is dispatch_failed, as today.
//   [CONTROL]   an accepted send records goal_dispatched with its dispatch id (and its goal), as today.
//   [CONTROL]   dispatch_goal's error detail text is unchanged for its other callers ("run-goal HTTP 429").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-notattempt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
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
let executions: Record<string, { status: string; reached: boolean | null; outcome?: Record<string, unknown> }> = {};
/** What /run-goal answers: null => 202 with a dispatch id; else this status and body. */
let runGoalAnswer: { status: number; body: Record<string, unknown> } | null = null;
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
      if (runGoalAnswer) return Response.json(runGoalAnswer.body, { status: runGoalAnswer.status });
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
  goals = []; executions = {}; runGoalAnswer = null; excluded = ["repos/some-other-vessel/"]; rhythms = [dueRhythm()];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
async function seed(id: string, what: string): Promise<void> {
  const summary = `${what} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
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

const MIN = 60_000;
async function seedRaw(id: string, summary: string): Promise<void> {
  // A row as the LIVE store holds a pre-gate one (written before 2026-10-03's binding gate): straight into the
  // scratch store, the way another process's writer replaces it (tmp + rename), keeping every row already there.
  const { readFileSync, renameSync } = await import("node:fs");
  const file = join(sg.gapStoreRootForTest(), "gaps", "gaps.json");
  if (!sg.isScratchGapStoreRoot(sg.gapStoreRootForTest())) throw new Error("not a scratch store");
  let rows: Row[] = [];
  try { rows = JSON.parse(readFileSync(file, "utf8")) as Row[]; } catch { rows = []; }
  rows.push({ id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary, classification_metadata: { edit_site: `repos/${VESSEL}/src/widget.ts`, disposition: "needs_localization" } });
  writeFileSync(`${file}.seed.tmp`, JSON.stringify(rows, null, 2));
  renameSync(`${file}.seed.tmp`, file);
}

describe("check-supply: a non-attempt and a refusal are recorded as what they are", () => {
  it("[MUST-FAIL] (1) a probe-time non-attempt (a deferred landing) is not charged and waits its shaped delay", async () => {
    const id = T("gcs-na");
    await seed(id, "non-attempt");
    const t0 = Date.now();
    await tick(t0);
    expect(goalsFor(id).length).toBe(1);
    const sent = ledgerOf(await storeRow(id));
    expect(sent["state"]).toBe("goal_dispatched");
    const did = String(sent["dispatch_id"]);
    executions[did] = { status: "failed", reached: false, outcome: { kind: "non_attempt", failure_kind: "environment", refuse_class: "gap_store_unavailable" } };
    await tick(t0 + 1 * MIN);
    const held = ledgerOf(await storeRow(id));
    expect(held["state"]).toBe("non_attempt");
    expect(Number(held["attempts"])).toBe(0);
    expect(Date.parse(String(held["not_before"]))).toBeGreaterThanOrEqual(t0 + 1 * MIN + 1800_000 - 5_000);
    await tick(t0 + 10 * MIN);
    expect(goalsFor(id).length).toBe(1); // inside the non-attempt delay: not sent
    await tick(t0 + 40 * MIN);
    expect(goalsFor(id).length).toBe(2); // past it: sent again, with no 24 h attempt backoff
  });

  it("[MUST-FAIL] (2) the write gate refuses the full ledger write: a 429 refusal at tick 1 is recorded and tick 2 does not re-send", async () => {
    const id = T("gcs-429");
    // the gap's own text quotes a placeholder outside backticks: any goal built from it fails the binding gate
    await seedRaw(id, `placeholder fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` sends {{your api key}} as the credential`);
    runGoalAnswer = { status: 429, body: { dispatchId: "refused-1", status: "failed", reached: false, refused: true, goalReachReason: "deterministic:spend-rate-refused - 6 dispatches of goal g in the last 3600 s", outcome: { kind: "refused", refuse_class: "spend_rate", retry_after_s: 1200 } } };
    const t0 = Date.now();
    await tick(t0);
    expect(goalsFor(id).length).toBe(1);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("send_refused");
    expect(Number(l["attempts"] ?? 0)).toBe(0);
    expect(Date.parse(String(l["not_before"]))).toBeGreaterThanOrEqual(t0 + 1200_000 - 5_000);
    await tick(t0 + 1 * MIN);
    expect(goalsFor(id).length).toBe(1);
    await tick(t0 + 25 * MIN); // past the receiver's own retry_after_s
    expect(goalsFor(id).length).toBe(2);
  });

  it("[MUST-FAIL] (3) 10 consecutive non-attempts: <= 24 sends in any 24 h window, and each wait longer than the last up to the cap", async () => {
    const id = T("gcs-bound");
    await seed(id, "never-taking receiver");
    let t = Date.now();
    const sendTimes: number[] = [];
    const waits: number[] = [];
    for (let n = 0; n < 10; n++) {
      const before = goalsFor(id).length;
      await tick(t);
      if (goalsFor(id).length > before) sendTimes.push(t);
      const did = String(ledgerOf(await storeRow(id))["dispatch_id"]);
      executions[did] = { status: "failed", reached: false, outcome: { kind: "non_attempt", failure_kind: "capacity" } };
      await tick(t + 30_000); // settles the probe as a non-attempt
      const held = ledgerOf(await storeRow(id));
      expect(held["state"]).toBe("non_attempt");
      const nb = Date.parse(String(held["not_before"]));
      waits.push(nb - (t + 30_000));
      t = nb + 60_000; // the first tick after its wait
    }
    expect(sendTimes.length).toBe(10);
    for (const s0 of sendTimes) expect(sendTimes.filter((x) => x >= s0 && x < s0 + 24 * 3600_000).length).toBeLessThanOrEqual(24);
    for (let i = 1; i < waits.length; i++) expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    expect(waits[waits.length - 1]!).toBeGreaterThan(waits[0]! * 4);
    expect(Math.max(...waits)).toBeLessThanOrEqual(6 * 3600_000 + 1000); // the default cap
    // the pure rule: doubling from the base, capped, never under what a receiver asked for
    const f = (supply as Record<string, any>)["nonAttemptDelayMs"] as (b: number, n: number, m: number, r?: number) => number;
    expect([1, 2, 3, 4, 5, 6].map((n) => f(1800_000, n, 6 * 3600_000))).toEqual([1800_000, 3600_000, 7200_000, 14_400_000, 21_600_000, 21_600_000]);
    expect(f(1800_000, 1, 6 * 3600_000, 2400_000)).toBe(2400_000);
  });

  it("[CONTROL] a settled outcome (a genuine failure) after a non-attempt resets the streak", async () => {
    // Reset is on a SETTLED outcome, not on an accepted send: a deferred/BUSY compose is ALWAYS an accepted send that
    // only reads as a non-attempt at probe time, so resetting on acceptance would void the bound for that very case.
    const id = T("gcs-reset");
    await seed(id, "reset");
    let t = Date.now();
    await tick(t);
    executions[String(ledgerOf(await storeRow(id))["dispatch_id"])] = { status: "failed", reached: false, outcome: { kind: "non_attempt" } };
    await tick(t + 30_000);
    expect(Number(ledgerOf(await storeRow(id))["non_attempt_streak"])).toBe(1);
    t = Date.parse(String(ledgerOf(await storeRow(id))["not_before"])) + 60_000;
    await tick(t);
    executions[String(ledgerOf(await storeRow(id))["dispatch_id"])] = { status: "failed", reached: false };
    await tick(t + 30_000);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("dispatch_failed");
    expect(Number(l["non_attempt_streak"])).toBe(0);
  });

  it("[CONTROL] a genuine not-reached outcome is dispatch_failed, as today", async () => {
    const id = T("gcs-fail");
    await seed(id, "genuine failure");
    const t0 = Date.now();
    await tick(t0);
    const did = String(ledgerOf(await storeRow(id))["dispatch_id"]);
    executions[did] = { status: "failed", reached: false };
    await tick(t0 + 1 * MIN);
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("dispatch_failed");
    expect(Number(l["attempts"])).toBe(1);
  });

  it("[CONTROL] an accepted send records goal_dispatched with its dispatch id and goal", async () => {
    const id = T("gcs-ok");
    await seed(id, "accepted");
    await tick(Date.now());
    const l = ledgerOf(await storeRow(id));
    expect(l["state"]).toBe("goal_dispatched");
    expect(String(l["dispatch_id"] ?? "")).toMatch(/^d-/);
    expect(String(l["goal"] ?? "")).toContain("Write ONE failing test");
    expect(Number(l["attempts"])).toBe(1);
  });

  it("[CONTROL] dispatch_goal's error detail is unchanged for its other callers", async () => {
    runGoalAnswer = { status: 429, body: { refused: true, outcome: { kind: "refused" } } };
    const { resolveDispatchGoal } = await import("../../src/resolvers/dispatch-goal.js");
    const r = await resolveDispatchGoal({ type: "dispatch_goal", goal: "control goal", timeout_ms: 2_000 } as never);
    expect(r.shape).toBe("structuredError");
    expect((r.body as Row)["detail"]).toBe("run-goal HTTP 429");
  });
});
