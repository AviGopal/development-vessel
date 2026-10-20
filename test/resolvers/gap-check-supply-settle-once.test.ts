// A FAILED ATTEMPT IS DEBITED ONCE, HOWEVER OFTEN ITS OUTCOME IS READ BACK.
//
// Measured: the check-supply rhythm fell to alpha 16 against beta 1296 on the node that runs supply continuously, so
// its own due formula sits at the exploration floor. The OUTCOME step settled a row's dispatch as dispatch_failed and
// debited the rhythm; the next tick's ARM step judged the row's landed check 'unknown' and wrote it back to
// goal_dispatched (failure reason kept); the tick after read the same dispatch back, settled it again and debited
// again. One row was re-settled 434 times. Two parts:
//   - a settled attempt's key (row, dispatch id) is stored in the rhythm's own settlement write, beside the debit, so
//     an attempt whose ledger write does not stick is re-recorded but never debited twice;
//   - an 'unknown' verdict keeps the row's state: it never turns a settled failure back into an in-flight dispatch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-settle-once-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const H = 3_600_000;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythms: Row[] = [];
let executions: Record<string, { status: string; reached: boolean | null; goalReachReason?: string }> = {};
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  // backoff 500 h: a settled failure is never retried inside these tests, so each tick only reads it back.
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 10, backoff_hours: 500, max_attempts: 3, dispatch_stale_hours: 24, foreign_stale_hours: 72 },
});
const beta = (): number => Number((rhythms[0]!["body"] as Row)["beta"]);

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
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const id = decodeURIComponent(exec[1]!);
      const rec = executions[id];
      return rec ? Response.json({ dispatchId: id, ...rec }) : new Response("not found", { status: 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}-sent` }, { status: 202 });
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    // The rhythm write is STORED, as the pool stores it (the body as given): the next tick reads what this one wrote.
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") {
      rhythms = [{ ...rhythms[0], body: imp.body, updated_at: new Date().toISOString() }];
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
beforeEach(() => {
  executions = {}; rhythms = [dueRhythm()];
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ledgerOf = (r: Row | undefined): Row => ((((r?.["classification_metadata"] ?? {}) as Row)["check_supply"] ?? {}) as Row);
/** Write the row with this ledger: a first seed, or the store as it reads after a settlement write that did not stick. */
async function putLedger(id: string, ledger: Row): Promise<void> {
  const summary = `settle-once fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary, classification_metadata: { check_supply: ledger } } } as never);
  if (w.shape === "structuredError") throw new Error("write refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
const inFlight = (dispatchId: string, sentAt: number, testFile: string): Row => ({
  state: "goal_dispatched", attempts: 1, last_dispatch_at: new Date(sentAt).toISOString(), test_file: testFile, vessel: VESSEL,
  mode: "check_file", baseline_titles: [], dispatch_id: dispatchId, dispatch_node: "node-a",
});

describe("one debit per attempt (row, dispatch id)", () => {
  it("[MUST-FAIL] the same unsettled failure, read back on 3 consecutive ticks because its settlement write did not stick, debits the rhythm once", async () => {
    const id = `gcs-once-${RUN}`;
    const x = `d-${RUN}-x`;
    const t0 = Date.now() + 3000 * H;
    const seen = inFlight(x, t0 - H, `test/checks/${id}-none.check.ts`); // no check file: the arm step never touches it
    executions[x] = { status: "completed", reached: false, goalReachReason: "no check written" };
    await putLedger(id, seen);
    const b0 = beta();
    for (let n = 0; n < 3; n++) {
      const body = await tick(t0 + n * 60_000);
      expect((((body["outcomes"] as Row)["failed"] as Row[]) ?? []).some((f) => f["id"] === id)).toBe(true);
      expect(ledgerOf(await storeRow(id))["state"]).toBe("dispatch_failed");
      if (n < 2) await putLedger(id, seen); // the settlement write lost: the store still reads goal_dispatched for dispatch x
    }
    expect((beta() - b0) / 0.5).toBe(1);
  });

  it("[CONTROL] two different dispatch ids of one row are two attempts: two debits", async () => {
    const id = `gcs-twice-${RUN}`;
    const x = `d-${RUN}-x2`;
    const y = `d-${RUN}-y2`;
    const t0 = Date.now() + 3100 * H;
    executions[x] = { status: "completed", reached: false, goalReachReason: "no check written" };
    executions[y] = { status: "failed", reached: false, goalReachReason: "compose refused" };
    await putLedger(id, inFlight(x, t0 - H, `test/checks/${id}-none.check.ts`));
    const b0 = beta();
    await tick(t0);
    await putLedger(id, { ...inFlight(y, t0, `test/checks/${id}-none.check.ts`), attempts: 2 });
    await tick(t0 + 60_000);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("dispatch_failed");
    expect((beta() - b0) / 0.5).toBe(2);
  });
});

describe("an unknown verdict keeps the row's state", () => {
  const landed = (id: string): string => {
    const tf = `test/checks/${id}.check.ts`;
    writeFileSync(join(CLONES, VESSEL, tf), `import { expect, test } from "bun:test";\nimport * as mod from "../../src/widget";\ntest("widget is two ${RUN}", () => { expect(mod.widget).toBe(2); });\n`);
    return tf;
  };

  it("[MUST-FAIL] a settled dispatch_failed row whose landed check is judged unknown stays dispatch_failed, not goal_dispatched", async () => {
    const id = `gcs-keep-${RUN}`;
    const t0 = Date.now() + 3200 * H;
    const tf = landed(id);
    await putLedger(id, { ...inFlight(`d-${RUN}-k`, t0 - 3 * H, tf), state: "dispatch_failed", reason: "the goal ended completed and reached, but no new test title appeared" });
    const body = await tick(t0);
    expect(((body["not_armed"] as Row[]) ?? []).some((r) => r["id"] === id && r["reason"] === "verdict_unknown")).toBe(true);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("dispatch_failed");
    expect(led["last_verdict"]).toBe("unknown");
  });

  it("[CONTROL] an in-flight row whose landed check is judged unknown stays goal_dispatched", async () => {
    const id = `gcs-inflight-${RUN}`;
    const t0 = Date.now() + 3300 * H;
    const tf = landed(id);
    await putLedger(id, inFlight(`d-${RUN}-i`, t0 - H, tf));
    await tick(t0);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("goal_dispatched");
    expect(led["last_verdict"]).toBe("unknown");
  });
});
