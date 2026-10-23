// TWO NODES, ONE ROW: THE LOSING NODE NEVER WRITES OVER THE WINNER'S RECORD (2026-10-23).
//
// Instance 10-21 19:10-19:11Z (lifecycle-expiry-closes-armed-gaps-...): both nodes' supplies read the row; compose2
// sent its goal and recorded dispatch 8545c2bc; node1 then wrote its own intent and, its compose lane BUSY, its
// non-attempt over that record, so the ledger named node1's refused dispatch and compose2's live compose was orphaned.
//
// THE CONTRACT: every check-supply ledger write expects the ledger it replaces (expect_check_supply, checked by the store
// under its lock): the intent expects the row as this pass read it, every write after the send expects that intent.
// MUST-FAIL: the other node's record stored between this pass's read and its intent write: nothing is written and
// nothing is sent; stored during this pass's send, which comes back BUSY: the non-attempt is not written. Either way
// the winner's dispatch id stays. CONTROL: a lone node's BUSY send is recorded as its non-attempt, as before.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-two-node-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
const UNREACHABLE_HOLDER = "http://holder.unreachable/v2/impulses/resolve";
const iso = (ms: number): string => new Date(ms).toISOString();

/** The live node's gap-check-supply rhythm as stored, written `ageH` hours before the pass. */
const LIVE_BODY: Row = { axis: "freshness", axis_code: 2, family: "gap-check-supply", budget: 0.3, alpha: 21, beta: 55, staleness: 0.3315043440464263, transient: false };
const liveRhythm = (now: number, ageH = 7.3): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: iso(now - ageH * H), body: { ...LIVE_BODY } });

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythms: Row[] = [];
let rhythmWrites: Row[] = [];
let executions: Record<string, { status: string; reached: boolean | null; goalReachReason?: string }> = {};
let probes: string[] = [];
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let lines: string[] = [];
let onScope: (() => Promise<void>) | null = null;
let onRunGoal: (() => Promise<Response | null>) | null = null;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;
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
    const exec = url.match(/\/executions\/([^/?#]+)$/);
    if (exec) {
      const id = decodeURIComponent(exec[1]!);
      probes.push(id);
      const rec = executions[id];
      return rec ? Response.json({ dispatchId: id, ...rec }) : new Response("not found", { status: 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url === UNREACHABLE_HOLDER) throw new TypeError("Unable to connect. Is the computer able to access the url?");
    if (url.endsWith("/run-goal")) {
      goals.push({ goal: String(body.goal ?? ""), variables: body.variables });
      const hook = onRunGoal; onRunGoal = null;
      const answer = hook ? await hook() : null;
      if (answer) return answer;
      return Response.json({ dispatchId: `d-${RUN}-sent-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    // The rhythm write is STORED as the pool stores it (the body as given, the clock reset): the next pass reads it.
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") {
      rhythmWrites.push(imp);
      rhythms = [{ ...rhythms[0], body: imp.body, updated_at: iso(writeClock) }];
      return Response.json({ body: { ok: true, id: imp.id } });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      const hook = onScope; onScope = null;
      if (hook) await hook();
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
  rhythmWrites = []; executions = {}; probes = []; goals = []; lines = []; onScope = null; onRunGoal = null;
  process.env["SUBSTRATE_NAME"] = "node-a";
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

let writeClock = 0;
async function tick(now: number): Promise<Row> {
  writeClock = now;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
    await sg.__settleBirthEvaluationsForTests();
    return r.body as Row;
  } finally {
    console.log = () => {};
  }
}
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const metaOf = (r: Row | undefined): Row => ((r?.["classification_metadata"] ?? {}) as Row);
const ledgerOf = (r: Row | undefined): Row => ((metaOf(r)["check_supply"] ?? {}) as Row);
const summaryFor = (what: string): string => `${what} fixture ${RUN}: local-tools-vessel src/widget.ts \`widget\` returns the wrong value`;
async function seed(id: string, what: string, meta: Row): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary: summaryFor(what), classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id, 0) === "treatment") return id; }
  throw new Error("no treatment id");
}
/** A goal_dispatched ledger as the live rows carry it. */
const inFlight = (id: string, sentAt: number, dispatchId: string | null, node: string): Row => ({
  state: "goal_dispatched", attempts: 1, last_dispatch_at: iso(sentAt), test_file: `test/checks/${id}.check.ts`, vessel: VESSEL, mode: "check_file",
  baseline_titles: [], edit_site: `repos/${VESSEL}/src/widget.ts`, dispatch_id: dispatchId, dispatch_node: node, dispatch_host: "http://goal-host.fixture",
  reason: "", outcome: {}, history: [], non_attempt_streak: 0,
});
/** compose2's record, written to the store as it lands there: its goal sent, its dispatch id recorded. */
const winner = (id: string, now: number): Row => ({ ...inFlight(id, now, `8545c2bc-${RUN}`, "compose2"), goal: "Write ONE failing test" });
async function winnerWrites(id: string, now: number): Promise<void> {
  const r = await storeRow(id);
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...(r as Row), classification_metadata: { ...metaOf(r), check_supply: winner(id, now) } } } as never);
  await sg.__settleBirthEvaluationsForTests();
}
const BUSY = (): Response => Response.json({ error: "compose lane at capacity" }, { status: 503 });

describe("the losing node never writes over the winner's record", () => {
  it("[MUST-FAIL] INTENT: the other node's record stored after this pass read the row: nothing written, nothing sent, the winner's id stays", async () => {
    const now = Date.parse("2034-01-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)];
    const id = T("gcst-intent");
    await seed(id, "intent", {});
    onScope = () => winnerWrites(id, now - MIN); // between this pass's store read and its intent write
    await tick(now);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
    expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", dispatch_id: `8545c2bc-${RUN}`, dispatch_node: "compose2" });
  });

  it("[MUST-FAIL] BUSY NON-ATTEMPT: the other node's record stored during this pass's send, which comes back BUSY: the non-attempt is not written, the winner's id stays", async () => {
    const now = Date.parse("2034-02-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)];
    const id = T("gcst-busy");
    await seed(id, "busy", {});
    onRunGoal = async () => { await winnerWrites(id, now); return BUSY(); };
    await tick(now);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))).toMatchObject({ state: "goal_dispatched", dispatch_id: `8545c2bc-${RUN}`, dispatch_node: "compose2" });
  });

  it("[CONTROL] a lone node's BUSY send is recorded as its non-attempt, as before", async () => {
    const now = Date.parse("2034-03-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)];
    const id = T("gcst-lone");
    await seed(id, "lone", {});
    onRunGoal = async () => BUSY();
    await tick(now);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("non_attempt");
    expect(led["dispatch_node"]).toBe("node-a");
  });

  it("[CONTROL] a lone node's normal send records its dispatch id, as before", async () => {
    const now = Date.parse("2034-04-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)];
    const id = T("gcst-ok");
    await seed(id, "ok", {});
    await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("goal_dispatched");
    expect(String(led["dispatch_id"])).toStartWith(`d-${RUN}-sent-`);
  });
});
