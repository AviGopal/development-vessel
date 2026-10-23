// A DUE PASS CLAIMS ITS SLOT BEFORE THE WORK (gap row gap-check-supply-tick-settles-only-on-alpha-or-beta-…).
//
// gap_check_supply_tick settled its rhythm only on an alpha or beta leg. A due pass that dispatched nothing, armed
// nothing and was refused nothing wrote no leg, so the family stayed due and every caller (the conductor's direct fire,
// the boredom selector's tagged template) passed the due gate again and re-read the whole gap store. Measured on one
// node: from the minute the family came due, one to two passes a minute where there had been one per 29 min, each
// logging the same 564 per-gap "no falsifiable anchor" lines and reading the store twice.
//
// THE CONTRACT (the scope-earn-in claim-before-work pattern, scope-earn-in.ts RAN_PACING): right after the due gate a
// due pass writes RAN_PACING onto the rhythm row it read, as a compare-and-set on its updated_at. A caller within the
// cadence then reads not_due; a caller that read the same row and loses the CAS returns not_due; neither reads the gap
// store. Credit is the separate settlement write after the work, as before. The pass logs ONE compact dispatch line.
//   [MUST-FAIL] a due pass with nothing to dispatch refreshes the pacing: the stored rhythm scores below its threshold.
//   [MUST-FAIL] two calls a minute apart: the second is not_due and reads no gap store.
//   [MUST-FAIL] two callers that read the same due row (two processes): exactly one runs; the other is not_due and
//               reads no gap store.
//   [MUST-FAIL] a due pass logs one compact dispatch line with its skips by reason; a no-anchor row's own line is
//               logged once, when its ledger first records it, and the ledger keeps the fact.
//   [MUST-FAIL] a due pass that settles a debit keeps the claimed pacing (the credit leg leaves staleness reset).
//   [CONTROL]   a due pass after the cadence runs and dispatches as today.
//   [CONTROL]   two overlapping calls in this process: the second is in_progress, as today.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUBSTRATE_NAME"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
process.env["SUBSTRATE_NAME"] = "node-a";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, any>;
const { rhythmDueScore } = await import("../../src/resolvers/rhythm-conductor-tick.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const H = 3_600_000;
const MIN = 60_000;
/** A gap-store holder that counts every call and answers none: set as GAP_STORE_ENDPOINT, it makes a store read seen. */
const COUNTING_HOLDER = "http://holder.counting/v2/impulses/resolve";
const iso = (ms: number): string => new Date(ms).toISOString();

/** The live node's gap-check-supply rhythm as stored (the bookkeeping test's LIVE_BODY), written `ageH` hours earlier. */
const LIVE_BODY: Row = { axis: "freshness", axis_code: 2, family: "gap-check-supply", budget: 0.3, alpha: 21, beta: 55, staleness: 0.3315043440464263, transient: false };
const rhythmAt = (now: number, ageH: number): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: iso(now - ageH * H), body: { ...LIVE_BODY } });

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
/** The pool's rhythm row, stored as the pool stores it: a write replaces the body and resets updated_at to writeClock;
 *  a write naming if_updated_at that no longer matches is refused (the pool's compare-and-set, pool-impulse.ts). */
let rhythm: Row = {};
/** Rows served to the NEXT rhythm reads instead of the stored one: a caller that read before another's write. */
let staleReads: Row[] = [];
let rhythmWrites: Row[] = [];
let holderCalls = 0;
/** Dispatch ids this node's goal-host reports failed (everything else: not found). */
const executionsFailed = new Set<string>();
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let lines: string[] = [];
let warns: string[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
let writeClock = 0;
const storeFile = (): string => join(sg.gapStoreRootForTest(), "gaps", "gaps.json");

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src"), join(CLONES, VESSEL, "test", "checks"), join(RUNTIME, VESSEL, "src")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(RUNTIME, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (url === COUNTING_HOLDER) { holderCalls += 1; throw new TypeError("Unable to connect (counting holder)"); }
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) return executionsFailed.has(decodeURIComponent(exec[1]!)) ? Response.json({ dispatchId: exec[1], status: "failed", reached: false }) : new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") {
      const served = staleReads.length > 0 ? staleReads.shift()! : rhythm;
      return Response.json({ body: { impulses: [served], count: 1 } });
    }
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") {
      if (imp.if_updated_at !== undefined && imp.if_updated_at !== rhythm["updated_at"]) return Response.json({ body: { ok: false, conflict: true } });
      rhythmWrites.push(imp);
      rhythm = { ...rhythm, body: imp.body, updated_at: iso(writeClock) };
      return Response.json({ body: { ok: true, id: imp.id } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const rows = [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"], require_falsifier_classes: ["class2"] } }];
      return Response.json({ body: { impulses: rows, count: rows.length } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "unknown");
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
beforeEach(async () => {
  await sg.__settleBirthEvaluationsForTests();
  writeFileSync(storeFile(), "[]"); // each case reads only its own rows
  rhythmWrites = []; staleReads = []; holderCalls = 0; goals = []; lines = []; warns = [];
  process.env["SUBSTRATE_NAME"] = "node-a";
  delete process.env["GAP_STORE_ENDPOINT"];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { delete process.env["GAP_STORE_ENDPOINT"]; expect(execGuard?.restore() ?? []).toEqual([]); });

async function tick(now: number, opts: { countStoreReads?: boolean } = {}): Promise<Row> {
  writeClock = now;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  if (opts.countStoreReads) process.env["GAP_STORE_ENDPOINT"] = COUNTING_HOLDER;
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    await sg.__settleBirthEvaluationsForTests();
    return r.body as Row;
  } finally {
    delete process.env["GAP_STORE_ENDPOINT"];
    console.log = () => {};
    console.warn = () => {};
  }
}
const dueNow = (now: number): number => rhythmDueScore(rhythm["body"] as never, rhythm["updated_at"], now).due_score;
const passLines = (): string[] => lines.filter((l) => l.startsWith("[check-supply] bookkeeping:"));
async function seed(id: string, summary: string): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary, classification_metadata: {} } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id, 0) === "treatment") return id; }
  throw new Error("no treatment id");
}
async function ledgerOf(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  return (((row?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row;
}

describe("a due pass claims its slot before the work", () => {
  it("[CONTROL] the fixture rhythm written 40 h earlier is due by the conductor's own formula", () => {
    const now = Date.parse("2031-01-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    expect(dueNow(now)).toBeGreaterThan(1);
  });

  it("[MUST-FAIL] a due pass with nothing to dispatch refreshes the pacing: the stored rhythm scores below its threshold", async () => {
    const now = Date.parse("2031-02-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    const body = await tick(now);
    expect((body["dispatched"] as Row[] | undefined)?.length ?? 0).toBe(0);
    expect(passLines()).toEqual(["[check-supply] bookkeeping: 0 due armed=0 outcomes=0 unarmed=0 released=0 waiting=0 dispatch=due node=node-a"]);
    expect(rhythmWrites.length).toBe(1);
    expect((rhythmWrites[0]!["body"] as Row)["staleness"]).toBe(0);
    expect(rhythmWrites[0]!["if_updated_at"]).toBe(iso(now - 40 * H));
    // credit and the posterior are untouched by the claim
    expect((rhythm["body"] as Row)["alpha"]).toBe(21);
    expect((rhythm["body"] as Row)["beta"]).toBe(55);
    expect(dueNow(now)).toBeLessThan(1);
  });

  it("[MUST-FAIL] two calls a minute apart: the second is not_due and reads no gap store", async () => {
    const now = Date.parse("2031-03-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    await tick(now);
    expect(passLines().length).toBe(1);
    const second = await tick(now + MIN, { countStoreReads: true });
    expect(second["reason"]).toBe("not_due");
    expect(holderCalls).toBe(0);
    expect(passLines().length).toBe(1);
  });

  it("[MUST-FAIL] two callers that read the same due row: exactly one runs; the other is not_due and reads no gap store", async () => {
    const now = Date.parse("2031-04-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    const before = { ...rhythm };
    await tick(now); // caller A: claims and runs
    staleReads = [before]; // caller B read the row before A's claim landed (another process)
    const b = await tick(now + 1_000, { countStoreReads: true });
    expect(b["reason"]).toBe("not_due");
    expect(String(b["detail"] ?? "")).toContain("claimed");
    expect(holderCalls).toBe(0);
    expect(passLines().length).toBe(1);
    expect(rhythmWrites.length).toBe(1); // A's claim only: B's compare-and-set was refused
  });

  it("[MUST-FAIL] a due pass logs one compact dispatch line; a no-anchor row's own line comes once, its ledger keeps the fact", async () => {
    const now = Date.parse("2031-05-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    const ids = [T("gcs-claim-noanchor-a"), T("gcs-claim-noanchor-b")];
    for (const id of ids) await seed(id, `noanchor fixture ${RUN}: something in local-tools-vessel is wrong somewhere`);
    await tick(now);
    for (const id of ids) {
      expect((await ledgerOf(id))["state"]).toBe("no_anchor");
      expect(warns.filter((w) => w.includes(id) && w.includes(supply.NO_ANCHOR_REASON)).length).toBe(1);
    }
    const compact = lines.filter((l) => l.startsWith("[check-supply] dispatch pass:"));
    expect(compact.length).toBe(1);
    expect(compact[0]).toContain("sent=0");
    expect(compact[0]).toContain("no_anchor=2");
    // the next due pass: the ledgers already say so, so no per-gap line again; the compact line still counts them
    rhythm = rhythmAt(now + 50 * H, 40);
    warns = []; lines = [];
    await tick(now + 50 * H);
    for (const id of ids) expect(warns.filter((w) => w.includes(id) && w.includes(supply.NO_ANCHOR_REASON)).length).toBe(0);
    expect(lines.filter((l) => l.startsWith("[check-supply] dispatch pass:") && l.includes("no_anchor=2")).length).toBe(1);
  });

  it("[MUST-FAIL] a due pass that settles a debit keeps the claimed pacing: the beta leg does not write it back to due", async () => {
    const now = Date.parse("2031-05-20T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    const id = T("gcs-claim-debit");
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z",
      summary: `debit fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`,
      classification_metadata: { check_supply: { state: "goal_dispatched", attempts: 3, last_dispatch_at: iso(now - 7 * H), test_file: `test/checks/${id}.check.ts`, vessel: VESSEL, mode: "check_file",
        baseline_titles: [], edit_site: `repos/${VESSEL}/src/widget.ts`, dispatch_id: `d-debit-${RUN}`, dispatch_node: "node-a", dispatch_host: "http://goal-host.fixture", reason: "", outcome: {}, history: [], non_attempt_streak: 0 } } } } as never);
    if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
    await sg.__settleBirthEvaluationsForTests();
    executionsFailed.add(`d-debit-${RUN}`);
    const body = await tick(now);
    expect(body["settlement"]).toBe("beta");
    expect((rhythm["body"] as Row)["beta"]).toBe(55.5);
    expect(dueNow(now)).toBeLessThan(1);
  });

  it("[CONTROL] a due pass after the cadence runs and dispatches as today", async () => {
    const now = Date.parse("2031-06-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    await tick(now); // claims; nothing to send
    const id = T("gcs-claim-fresh");
    await seed(id, `fresh fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`);
    // the cadence later: the claimed row (staleness 0) has aged past its threshold again
    const later = now + 200 * H;
    expect(dueNow(later)).toBeGreaterThan(1);
    const body = await tick(later);
    expect((body["dispatched"] as Row[]).map((d) => d["id"])).toEqual([id]);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    expect((await ledgerOf(id))["state"]).toBe("goal_dispatched");
  });

  it("[CONTROL] two overlapping calls in this process: the second is in_progress, as today", async () => {
    const now = Date.parse("2031-07-01T00:00:00.000Z");
    rhythm = rhythmAt(now, 40);
    writeClock = now;
    const [a, b] = await Promise.all([
      supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never),
      supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never),
    ]);
    await sg.__settleBirthEvaluationsForTests();
    expect([String((a.body as Row)["reason"]), String((b.body as Row)["reason"])]).toContain("in_progress");
  });
});
