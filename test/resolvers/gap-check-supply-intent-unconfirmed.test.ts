// AN IN-FLIGHT RECORD THE STORE REPORTS UNWRITTEN MAY STILL HAVE LANDED; NOTHING WAS SENT, SO THE ROW IS PUT BACK.
//
// Measured on a node that forwards its gap store: under load the forwarded intent write ("record before send") came
// back "gap store at <holder> unreachable: The operation timed out." The supply logged "not sent: the in-flight record
// could not be written" and sent nothing, but the holder had applied the write: five rows sat at goal_dispatched with
// dispatch_id null and no goal text, for a send that never happened, until the no_dispatch_id bound (24 h) settled
// them as lost attempts.
//
// THE CONTRACT: when the in-flight record is refused (or times out), nothing is sent; if the store holds this pass's
// intent (it landed), the row's ledger is written back as it was read, and if it does not, nothing is written (the
// store has no conditional write; a write could only race the late intent). ORDER-SAFE BY THE BACKSTOP: an intent that
// lands after that check leaves the pre-send record (send_pending, no dispatch id), which the next pass recovers as the
// unconfirmed send it is (a non-attempt, never dispatch_lost), on an undue pass too; it never stays. CONTROL: an intent write that
// succeeds sends the goal and records its dispatch id exactly as before.
//
// The two nodes are one process: GAP_STORE_ENDPOINT names a holder URL answered by the in-process substrate-gap
// resolvers with the endpoint unset for their turn.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-intent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const HOLDER = "http://holder.test/v2/impulses/resolve";
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

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const H = 3_600_000;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let warnings: string[] = [];
/** The forwarded intent write answered as this side's timeout: applied by the holder first ("landed"), or held back
 *  and applied only when the test says ("late"). */
let intentMode: "ok" | "landed" | "late" = "ok";
let deferred: Row[] = [];
let rhythmNow: () => Row = () => dueRhythm();
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
const dueRhythm = (): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 24, max_attempts: 3 },
});

async function asHolder<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  try { return await fn(); } finally { if (was === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = was; }
}
const isIntent = (p: Row): boolean => {
  const cs = (((p["gap"] ?? {}) as Row)["classification_metadata"] as Row | undefined)?.["check_supply"] as Row | undefined;
  return p["type"] === "substrateGap_write" && cs?.["state"] === "send_pending" && cs?.["dispatch_id"] === null && cs?.["goal"] === undefined;
};

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
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url === HOLDER) {
      const p = (imp.pointer ?? {}) as Row;
      if (intentMode === "late" && isIntent(p)) { deferred.push(p); throw new DOMException("The operation timed out.", "TimeoutError"); }
      const r = await asHolder(async () => (p["type"] === "substrateGap" ? sg.resolveSubstrateGap(p as never) : sg.resolveSubstrateGapWrite(p as never)));
      await asHolder(() => sg.__settleBirthEvaluationsForTests());
      if (intentMode === "landed" && isIntent(p)) throw new DOMException("The operation timed out.", "TimeoutError");
      return Response.json(r);
    }
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      return Response.json({ dispatchId: `d-${RUN}-sent-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: [rhythmNow()], count: 1 } });
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
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
});
afterAll(async () => {
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
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
  goals = []; warnings = []; intentMode = "ok"; deferred = []; rhythmNow = () => dueRhythm();
  process.env["GAP_STORE_ENDPOINT"] = HOLDER; // this node forwards its gap store
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  expect(execGuard?.restore() ?? []).toEqual([]);
});

async function seedAtHolder(id: string, ledger: Row): Promise<void> {
  const summary = `intent fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
  const w = await asHolder(() => sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary, classification_metadata: { check_supply: ledger, gap_check_supply_arm: "treatment" } } } as never));
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await asHolder(() => sg.__settleBirthEvaluationsForTests());
}
async function holderLedger(id: string): Promise<Row> {
  const r = await asHolder(() => sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never));
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  return (((row?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row;
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id, 0) === "treatment") return id; }
  throw new Error("no treatment id");
}
/** A row whose last send was a non-attempt (the live rows' prior state: streak 8), its shaped wait over. */
const priorLedger = (id: string, now: number): Row => ({
  state: "non_attempt", attempts: 0, last_dispatch_at: new Date(now - 7 * H).toISOString(), test_file: `test/checks/${id}.check.ts`, vessel: VESSEL, mode: "check_file",
  baseline_titles: [], edit_site: `repos/${VESSEL}/src/widget.ts`, dispatch_id: `d-${RUN}-earlier`, dispatch_node: "node-a",
  not_before: new Date(now - H).toISOString(), non_attempt_streak: 8, reason: "send not taken (non-attempt): the compose lane is at capacity",
});

describe("record before send, on a node that forwards its gap store", () => {
  it("[MUST-FAIL] an intent write answered as a timeout (but applied by the holder) sends nothing and leaves the row as it was read, not at goal_dispatched", async () => {
    const now = Date.now() + 4000 * H;
    const id = T("gcs-intent-timeout");
    const prior = priorLedger(id, now);
    await seedAtHolder(id, prior);
    intentMode = "landed";
    await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
    expect(warnings.some((w) => w.includes(`${id}: not sent: the in-flight record could not be written`) && w.includes("The operation timed out."))).toBe(true);
    const led = await holderLedger(id);
    expect(led["state"]).toBe("non_attempt");
    expect(led).toEqual(prior);
  });

  it("[MUST-FAIL] the LATE order (the intent lands after the check): nothing is put back, and the pre-send record the late intent leaves is recovered as an unconfirmed send (non_attempt), never dispatch_lost, by an undue bookkeeping pass", async () => {
    const now = Date.now() + 4200 * H;
    const id = T("gcs-intent-late");
    await seedAtHolder(id, priorLedger(id, now));
    intentMode = "late";
    await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
    expect(warnings.some((w) => w.includes(`${id}: the unsent in-flight record had landed`))).toBe(false);
    // the intent lands now, after the check
    const late = deferred.find((p) => ((p["gap"] ?? {}) as Row)["id"] === id);
    expect(late).toBeDefined();
    await asHolder(() => sg.resolveSubstrateGapWrite(late as never));
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    expect((await holderLedger(id))["dispatch_id"]).toBeNull();
    // the backstop: the family undue (the live rhythm: due 0.586), one bookkeeping pass past dispatch_stale_hours
    intentMode = "ok";
    const later = now + 25 * H;
    rhythmNow = () => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date(later - 7.3 * H).toISOString(), body: { axis: "freshness", axis_code: 2, family: "gap-check-supply", budget: 0.3, alpha: 21, beta: 55, staleness: 0.3315043440464263 } });
    await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: later } as never);
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    const led = await holderLedger(id);
    expect(led["state"]).toBe("non_attempt");
    expect(String(led["reason"])).toStartWith("send_unconfirmed:");
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
  });

  it("[CONTROL] an intent write that succeeds sends the goal and records its dispatch id, as before", async () => {
    const now = Date.now() + 4100 * H;
    const id = T("gcs-intent-ok");
    await seedAtHolder(id, priorLedger(id, now));
    await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    await asHolder(() => sg.__settleBirthEvaluationsForTests());
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    const led = await holderLedger(id);
    expect(led["state"]).toBe("goal_dispatched");
    expect(String(led["dispatch_id"])).toStartWith(`d-${RUN}-sent-`);
    expect(led["attempts"]).toBe(1);
  });
});
