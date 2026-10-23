// A NARROWED CHILD CARRYING ITS PARENT'S ARMED LEDGER IS GIVEN ITS OWN (2026-10-23).
//
// Before the inherit fix (narrowedChildRecord, NARROWED_INHERIT_NEVER), a narrowed child was minted with a copy of
// its parent's check_supply ledger: it reads armed, with the parent's armed_at and dispatch id, though its own falsifier
// is none. The dispatch step skips armed rows, so such a child is never supplied a check and cannot close. The fix
// covered future narrowing only. Live, two open children still carry the copy:
// the-ribosome-replay-judge-...-dissent-narrowed (armed_at 14:13:39Z, narrowed 15:11:44Z, dispatch c2935f30) and
// the-trace-store-keeps-only-...-dissent-narrowed (armed_at 09:31:00Z, narrowed 11:22:00Z).
//
// THE CONTRACT: on every pass (due or not), an open child (parent_gap_id) whose ledger is armed BEFORE the child was
// narrowed, and whose own falsifier is not class1/class2, has the copy cleared with its reason recorded on the row; the
// next due pass supplies it its own check. CONTROL: a child armed after its narrowing keeps its ledger; nothing is sent.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-inherited-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
/** A row planted as the store holds it (no write seam), as the live own-check row sits. */
function plant(rows: Row[]): void {
  let all: Row[] = [];
  try { all = JSON.parse(readFileSync(storeFile(), "utf8")) as Row[]; } catch { all = []; }
  writeFileSync(storeFile(), JSON.stringify([...all.filter((r) => !rows.some((x) => x["id"] === r["id"])), ...rows], null, 2));
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
/** The live child as stored: narrowed from a semantic dissent, the parent's armed ledger copied onto it. */
const child = (id: string, narrowedAt: number, armedAt: number): Row => ({
  id, category: "systematic_failure", source: "substrate_detected", status: "open", detected_at: iso(narrowedAt), created_at: iso(narrowedAt),
  summary: summaryFor("dissent-narrowed"),
  classification_metadata: {
    parent_gap_id: `parent-${id}`, narrowed_at: iso(narrowedAt), narrowed_from: "semantic_dissent", falsifier: "none", falsifier_classified_at: iso(narrowedAt),
    check_supply: { state: "armed", attempts: 1, last_dispatch_at: iso(armedAt - H), test_file: `test/checks/parent-${id}.check.ts`, vessel: VESSEL, mode: "check_file",
      baseline_titles: [], edit_site: `repos/${VESSEL}/src/widget.ts`, dispatch_id: `c2935f30-${RUN}`, dispatch_node: "node-a", armed_at: iso(armedAt), red_at_head: true, last_verdict: "present" },
  },
});

describe("a narrowed child's copied armed ledger is cleared", () => {
  it("[MUST-FAIL] armed before its narrowing (the live ribosome child): an undue pass clears the copy with its reason, and the next due pass supplies the child", async () => {
    const now = Date.parse("2033-01-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const id = T("gcsi-ribosome-dissent-narrowed");
    plant([child(id, now - 10 * H, now - 11 * H)]);
    const body = await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).not.toBe("armed");
    expect(String(led["reason"])).toStartWith("inherited_armed_ledger_cleared:");
    expect((led["inherited"] as Row)["dispatch_id"]).toBe(`c2935f30-${RUN}`);
    expect(body["cleared_inherited"]).toEqual([id]);
    expect(goals.length).toBe(0); // undue: nothing sent
    rhythms = [liveRhythm(now + 11 * MIN, 40)];
    await tick(now + 11 * MIN);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    expect(ledgerOf(await storeRow(id))["test_file"]).toBe(supply.checkSupplyTestFile(id));
  });

  it("[CONTROL] a child armed after its narrowing keeps its ledger, and nothing is sent", async () => {
    const now = Date.parse("2033-02-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)];
    const id = T("gcsi-own-arm-narrowed");
    plant([child(id, now - 10 * H, now - 9 * H)]);
    await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("armed");
    expect(led["dispatch_id"]).toBe(`c2935f30-${RUN}`);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(0);
  });
});
