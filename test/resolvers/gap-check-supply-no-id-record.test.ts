// A DISPATCH WITH NO ID IS NEVER RECORDED IN FLIGHT, AND AN ID-LESS RECORD IS NEVER SETTLED AS LOST (2026-10-23).
//
// The supply wrote its record before the send (CHANGE-30) as goal_dispatched with dispatch_id null. On a node that
// forwards its gap store that write could be answered as refused and still land at the holder: five live rows sat at
// goal_dispatched with no id and no goal text (the owner's journal: "not sent: the in-flight record could not be
// written ... not yet at the holder"), read as `waiting` on every pass, then settled dispatch_lost (no_dispatch_id)
// after 24 h. A send the goal-host answered with no id was recorded the same way. Their outcomes were lost for good.
//
// THE CONTRACT (ruled: "a dispatch with no id cannot be recorded, or its outcome is recovered; never settled as lost"):
//   - goal_dispatched is written only with a dispatch id; the record before the send is send_pending;
//   - a send the goal-host answers with no id is a failed send, refused and logged, never goal_dispatched;
//   - an id-less record is recovered from its own shape by the node that wrote it: no goal text means no send was
//     confirmed (a non-attempt, not charged); with goal text it was sent and answered no id (a failed send). Another
//     node's id-less record waits for its owner. None is ever dispatch_lost.
// CONTROL: a normal dispatch records its id, and its outcome is read back and settled as before.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-no-id-record-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
let warns: string[] = [];
let runGoalNoId = false;
let ledgerAtSend: Row[] = [];
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
      // what the store holds for the row while its goal is being sent
      ledgerAtSend.push(ledgerOf(await storeRow(String(body.variables?.gap_id ?? ""))));
      return Response.json(runGoalNoId ? { status: "accepted" } : { dispatchId: `d-${RUN}-sent-${goals.length}` }, { status: 202 });
    }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    // The rhythm write is STORED as the pool stores it (the body as given, the clock reset): the next pass reads it.
    if (imp?.type === "poolImpulse_write" && imp?.shape === "timeShapedRhythm") {
      rhythmWrites.push(imp);
      rhythms = [{ ...rhythms[0], body: imp.body, updated_at: iso(writeClock) }];
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
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
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
  rhythmWrites = []; executions = {}; probes = []; goals = []; lines = []; warns = []; runGoalNoId = false; ledgerAtSend = [];
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
const NOW0 = Date.parse("2032-01-01T00:00:00.000Z");
const BOUNDS = { stale_ms: 24 * H, timeout_ms: 6 * H, title_grace_ms: 2 * H, foreign_stale_ms: 72 * H };
/** The live rows: the record before the send landed late, the send never made (no id, no goal text). */
const idless = (id: string, sentAt: number, node = "node-a"): Row => { const l = inFlight(id, sentAt, null, node); return { ...l, non_attempt_streak: 16 }; };

describe("goal_dispatched is written only with a dispatch id", () => {
  it("[MUST-FAIL] while the goal is being sent, the store holds the pre-send record, never goal_dispatched with no id", async () => {
    const now = NOW0;
    rhythms = [liveRhythm(now, 40)];
    const fresh = T("gcsn-fresh");
    await seed(fresh, "fresh", {});
    await tick(now);
    expect(goals.filter((g) => g.variables?.["gap_id"] === fresh).length).toBe(1);
    expect(ledgerAtSend.length).toBe(1);
    expect(ledgerAtSend[0]!["state"] === "goal_dispatched" && ledgerAtSend[0]!["dispatch_id"] == null).toBe(false);
    expect(ledgerAtSend[0]!["state"]).toBe("send_pending");
    // CONTROL: the sent record carries its id, and its outcome is read back and settled as before
    const led = ledgerOf(await storeRow(fresh));
    expect(led["state"]).toBe("goal_dispatched");
    const did = String(led["dispatch_id"]);
    expect(did).toStartWith(`d-${RUN}-sent-`);
    executions[did] = { status: "failed", reached: false, goalReachReason: "the compose did not write the check" };
    await tick(now + 11 * MIN);
    expect(probes).toContain(did);
    expect(ledgerOf(await storeRow(fresh))["state"]).toBe("dispatch_failed");
  });

  it("[MUST-FAIL] a send the goal-host answers with no dispatch id is a failed send, refused and logged, never goal_dispatched", async () => {
    const now = NOW0 + 1000 * H;
    rhythms = [liveRhythm(now, 40)];
    const fresh = T("gcsn-noid-send");
    await seed(fresh, "noid-send", {});
    runGoalNoId = true;
    await tick(now);
    expect(goals.filter((g) => g.variables?.["gap_id"] === fresh).length).toBe(1);
    const led = ledgerOf(await storeRow(fresh));
    expect(led["state"]).not.toBe("goal_dispatched");
    expect(led["state"]).toBe("dispatch_failed");
    expect(String(led["reason"])).toContain("send_without_id");
    expect(warns.some((w) => w.includes(fresh) && w.includes("send_without_id"))).toBe(true);
  });
});

describe("an id-less record is recovered by its own node, never settled as lost", () => {
  it("[MUST-FAIL] the live shape (no id, no goal text), young: recovered on the first pass as an unconfirmed send, not charged, and no longer waiting", async () => {
    const now = NOW0 + 2000 * H;
    rhythms = [liveRhythm(now)];
    const id = T("gcsn-young");
    await seed(id, "young", { check_supply: idless(id, now - H), gap_check_supply_arm: "treatment" });
    const body = await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("non_attempt");
    expect(String(led["reason"])).toStartWith("send_unconfirmed:");
    expect(led["attempts"]).toBe(0); // the attempt given back
    expect(((body["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === id)).toBe(false);
  });

  it("[MUST-FAIL] the live shape past dispatch_stale_hours: recovered the same way, never dispatch_lost", async () => {
    const now = NOW0 + 3000 * H;
    rhythms = [liveRhythm(now)];
    const id = T("gcsn-stale");
    await seed(id, "stale", { check_supply: idless(id, now - 30 * H), gap_check_supply_arm: "treatment" });
    await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).not.toBe("dispatch_lost");
    expect(led["state"]).toBe("non_attempt");
  });

  it("[MUST-FAIL] the verdict on an id-less record: owner, no goal text -> non_attempt; owner, goal text -> failed; another node's, however old -> wait for its owner; never lost", () => {
    const base = { last_dispatch_at: iso(NOW0 - 30 * H), test_file: "test/checks/x.check.ts" };
    expect(supply.dispatchVerdict({ ...base, dispatch_node: "node-a" }, null, NOW0, BOUNDS, "node-a").kind).toBe("non_attempt");
    const sentNoId = supply.dispatchVerdict({ ...base, dispatch_node: "node-a", goal: "Write ONE failing test" }, null, NOW0, BOUNDS, "node-a");
    expect(sentNoId.kind).toBe("failed");
    expect(String(sentNoId.reason)).toContain("send_without_id");
    const foreign = supply.dispatchVerdict({ ...base, dispatch_node: "node-b", last_dispatch_at: iso(NOW0 - 200 * H) }, null, NOW0, BOUNDS, "node-a");
    expect(foreign.kind).toBe("wait");
    expect(foreign.why).toBe("owning_node_never_settled");
  });

  it("[CONTROL] a record WITH an id still waits while its outcome is unreadable (young), as before", () => {
    const v = supply.dispatchVerdict({ dispatch_id: "d-1", dispatch_node: "node-a", last_dispatch_at: iso(NOW0 - H) }, { http: 404 }, NOW0, BOUNDS, "node-a");
    expect(v.kind).toBe("wait");
    expect(v.why).toBe("not_found_on_host");
  });
});
