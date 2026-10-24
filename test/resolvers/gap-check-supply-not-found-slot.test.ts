// A DISPATCH ITS GOAL-HOST HAS NO RECORD OF HOLDS NO SLOT (2026-10-24).
//
// The demand gate (gap-check-supply-demand-due) marks the family due only while fewer than max_per_tick of this node's
// goals are in flight. A goal this node sent whose goal-host answers 404 (pruned: goal-host keeps only its newest
// dispatch records, hours, well under dispatch_stale_hours) waited out the 24 h bound COUNTED in flight, so with
// max_per_tick=1 the gate read ready=0 every tick while hundreds of rows waited. The verdict is unchanged (it still
// waits, reported as not_found_on_host, and is lost only past the bound); it just no longer occupies the slot. The gap
// itself is never sent a second goal while its record waits.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-not-found-slot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/** node1's gap-check-supply rhythm after a due pass claimed its slot (staleness 0), written `ageH` hours before the pass. */
const LIVE_BODY: Row = { axis: "freshness", axis_code: 2, family: "gap-check-supply", budget: 0.05, alpha: 25.5, beta: 129, staleness: 0, transient: false };
const liveRhythm = (now: number, ageH = 1): Row => ({ id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: iso(now - ageH * H), body: { ...LIVE_BODY } });

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythms: Row[] = [];
let rhythmWrites: Row[] = [];
let executions: Record<string, { status: string; reached: boolean | null; goalReachReason?: string }> = {};
let probes: string[] = [];
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let lines: string[] = [];
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
  rhythmWrites = []; executions = {}; probes = []; goals = []; lines = [];
  process.env["SUBSTRATE_NAME"] = "node-a";
  execGuard = installCutoverExecGuard();
  g2fPolicy.__resetPolicyReadsForTests();
});
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

let writeClock = 0;
async function tick(now: number, bookkeepingOnly = false): Promise<Row> {
  writeClock = now;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now, ...(bookkeepingOnly ? { bookkeeping_only: true } : {}) } as never);
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
const dueAt = (now: number): number => rhythmDueScore(rhythms[0]!["body"] as never, rhythms[0]!["updated_at"], now).due_score;
const demandLines = (): string[] => lines.filter((l) => l.startsWith("[check-supply] demand:"));

describe("an own dispatch answered 404 holds no in-flight slot", () => {
  it("[MUST-FAIL] with max_per_tick=1, an own goal its goal-host has no record of: still waiting (not_found_on_host), yet ready > 0 and the family is marked due", async () => {
    const now = Date.parse("2032-02-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const pruned = T("gcsn-pruned");
    const did = `bf12e7f5-${RUN}`; // no executions[did]: the goal-host answers 404
    await seed(pruned, "pruned", { check_supply: inFlight(pruned, now - 2 * H, did, "node-a") });
    const fresh = T("gcsn-fresh");
    await seed(fresh, "fresh", {});
    const first = await tick(now, true);
    expect(probes).toContain(did);
    expect(ledgerOf(await storeRow(pruned))["state"]).toBe("goal_dispatched");
    expect(((first["outcomes"] as Row)["waiting"] as Row[]).some((w) => w["id"] === pruned && w["why"] === "not_found_on_host")).toBe(true);
    expect(first["demand"]).toMatchObject({ in_flight: 0, max_per_tick: 1, marked_due: true });
    expect(Number((first["demand"] as Row)["ready"])).toBeGreaterThan(0);
    expect(dueAt(now)).toBeGreaterThanOrEqual(1);
    expect(demandLines().length).toBe(1);
    // the conductor's next pass fires the due family: the waiting row is sent, the 404-waiting gap is not
    const second = await tick(now + MIN);
    expect((second["dispatched"] as Row[]).map((d) => d["id"])).toEqual([fresh]);
  });

  it("[CONTROL] the freed slot is the node's, never the gap's: the 404-waiting gap is not sent again and stays goal_dispatched, whether or not the family fires", async () => {
    const now = Date.parse("2032-03-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const pruned = T("gcsn-pruned2");
    const did = `7d0a4c11-${RUN}`;
    await seed(pruned, "pruned2", { check_supply: inFlight(pruned, now - 2 * H, did, "node-a") });
    const fresh = T("gcsn-fresh2");
    await seed(fresh, "fresh2", {});
    await tick(now, true);
    const second = await tick(now + MIN);
    expect(goals.filter((g) => g.variables?.["gap_id"] === pruned).length).toBe(0);
    expect(((second["dispatched"] as Row[] | undefined) ?? []).some((d) => d["id"] === pruned)).toBe(false);
    const led = ledgerOf(await storeRow(pruned));
    expect(led["state"]).toBe("goal_dispatched");
    expect(led["dispatch_id"]).toBe(did);
  });

  it("[CONTROL] an own goal its goal-host DOES hold, still running, counts in flight: ready=0 at max_per_tick=1, nothing marked", async () => {
    const now = Date.parse("2032-04-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const running = T("gcsn-running");
    const did = `3e9b6f02-${RUN}`;
    executions[did] = { status: "running", reached: null };
    await seed(running, "running", { check_supply: inFlight(running, now - 2 * H, did, "node-a") });
    const fresh = T("gcsn-fresh3");
    await seed(fresh, "fresh3", {});
    const first = await tick(now, true);
    expect(first["demand"]).toMatchObject({ ready: 0, in_flight: 1, max_per_tick: 1, marked_due: false });
    expect(rhythmWrites.length).toBe(0);
    expect(demandLines().length).toBe(0);
  });
});
