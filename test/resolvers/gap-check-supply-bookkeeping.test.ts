// THE RHYTHM PACES THE DISPATCH, NOT THE BOOKKEEPING (2026-10-21).
//
// gap_check_supply_tick returned {fired:false, reason:"not_due"} before any of its steps while its family was undue, so
// an undue family read back no outcome, armed no landed check, un-armed no own-check row and released no hold. Measured
// on the live store: a node's rhythm at alpha 21 / beta 55, staleness 0.3315, budget 0.3, written 7.3 h earlier, scores
// due 0.586 (threshold 1) and next comes due 18 h later; eight rows sat at goal_dispatched, among them one whose goal
// the goal-host already reported failed, five whose send recorded no dispatch id, and two another node sent.
//
// THE CONTRACT: ARM, OUTCOME, the own-check un-arm and the hold release run on every pass; DISPATCH (and localization
// and placement) only when the rhythm is due. An undue pass is not a fire: no credit and no staleness answered. A debit
// (a failed or lost goal, once per attempt by settled_attempts) is still written as the beta leg it is today, which
// persists the accrued staleness, so the family's due clock moves only by the debit itself. Each pass logs one
// `[check-supply] bookkeeping: …` line ("0 due" when it found nothing). Per cause, one row each:
//   - an ordinary pending outcome the goal-host reports failed settles BY VERDICT on the first undue pass;
//   - a dispatch that recorded no id is recovered on the first pass as the unconfirmed send it is (a non-attempt, not
//     charged), never settled as lost, and is re-dispatch eligible;
//   - a dispatch another node sent is never probed or written here (inside foreign_stale_hours); the sending node's
//     own undue pass settles it;
//   - a class2 row sited at its own check (the live row's stored shape) is un-armed, with no rhythm write at all.
// CONTROL: the same fixture with the rhythm DUE settles and dispatches exactly as before.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-bookkeeping-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
async function seed(id: string, what: string, meta: Row): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2029-12-01T00:00:00.000Z", summary: summaryFor(what), classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
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
const bookkeepingLines = (): string[] => lines.filter((l) => l.startsWith("[check-supply] bookkeeping:"));
const debits = (): number => (Number((rhythms[0]!["body"] as Row)["beta"]) - Number(LIVE_BODY["beta"])) / 0.5;
const settledKeys = (): string[] => (((rhythms[0]!["body"] as Row)["settled_attempts"] ?? []) as string[]);
/** The live row's accrued staleness at `now` (stored + age in days), the value a beta leg persists. */
const accrued = (now: number, ageH = 7.3): number => Number(LIVE_BODY["staleness"]) + ageH / 24;

// route-edit-93306110 as stored: a class2 row whose edit site is its own check's test file (the stored fields, verbatim).
const OWN_CHECK_SITE = "repos/development-vessel/test/resolvers/reachability-gap-repair.test.ts";
const ownCheckRow = (id: string): Row => ({
  id, category: "edit_intent_route", status: "open", detected_at: "2026-09-30T13:55:45.225Z",
  summary: "…: Failing test(s) in repos/development-vessel/test/resolvers/reachability-gap-repair.test.ts, detected by pull-sync (red on two consecutive ticks under the checker env; not an environment failure): reachability-gap-repair resolver > reads producer id + required inputs from a gap_id when no direct override is given [error: expect(received).toBe(expected) / Expected: \"FAVORABLE\" / Received: \"UNFAVORABLE\"]. Edit repos/development-vessel/test/resolvers/reachability-gap-repair.test.ts.",
  classification_metadata: {
    disposition: "", gap_check_supply_arm: "control", edit_site: OWN_CHECK_SITE, falsifier: "class2", falsifier_classified_at: "2026-10-14T23:39:10.506Z",
    decomposed_at: "2026-10-14T23:30:21.871Z", decomposition: { children: [`${id}-step-1`], reason: "wrote the parent's own check; wrote 1 step(s)", parent_check: "written" },
    verify_shape: "",
    evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/resolvers/reachability-gap-repair.test.ts", only_tests: ["reads producer id + required inputs from a gap_id when no direct override is given"], timeout_ms: 180000 }, zero_field: "requested_not_passing" },
    predicate_source: "gap_falsify:parent_check", falsified_at: "2026-10-14T23:30:21.871Z", falsifier_position: "evidence_resolve.shape",
    predicate_birth_verdict: "present", predicate_birth_at: "2026-10-14T23:30:21.871Z",
    predicate_birth_key: "{\"evidence_resolve\":{\"input\":{\"only_tests\":[\"reads producer id + required inputs from a gap_id when no direct override is given\"],\"test_file\":\"test/resolvers/reachability-gap-repair.test.ts\",\"timeout_ms\":180000,\"vessel\":\"repos/development-vessel\"},\"shape\":\"test_suite\",\"zero_field\":\"requested_not_passing\"},\"verify_shape\":\"\"}",
  },
});

describe("an undue pass does the bookkeeping and dispatches nothing (the live rhythm: due 0.586)", () => {
  it("[CONTROL] the fixture rhythm is undue at the pass, by the conductor's own formula", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const d = rhythmDueScore(LIVE_BODY as never, iso(now - 7.3 * H), now);
    expect(d.due_score).toBeGreaterThan(0.58);
    expect(d.due_score).toBeLessThan(1);
  });

  it("[MUST-FAIL] with nothing to settle the pass still says so ('bookkeeping: 0 due') and writes nothing", async () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const body = await tick(now);
    expect(body["fired"]).toBe(false);
    expect(body["reason"]).toBe("not_due");
    expect(bookkeepingLines()).toEqual(["[check-supply] bookkeeping: 0 due armed=0 outcomes=0 unarmed=0 released=0 waiting=0 dispatch=undue node=node-a"]);
    expect(rhythmWrites.length).toBe(0);
    expect(goals.length).toBe(0);
  });

  it("[MUST-FAIL] PENDING, failed on this node's goal-host: settled by verdict on the first undue pass, ONE debit with its key, the due clock kept; a second undue pass debits nothing", async () => {
    const now = Date.parse("2030-02-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const id = T("gcsb-pending");
    const did = `a84c22ca-${RUN}`;
    const sent = inFlight(id, now - 7.3 * H, did, "node-a");
    executions[did] = { status: "failed", reached: false, goalReachReason: "the compose did not write the check" };
    await seed(id, "pending", { check_supply: sent });
    const body = await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("dispatch_failed");
    expect(String(led["reason"])).toContain("not reached");
    expect(body["fired"]).toBe(false);
    expect(body["dispatch"]).toBe("undue");
    expect(goals.length).toBe(0); // dispatched = 0
    // exactly one debit, stored with its attempt key in the same write
    expect(rhythmWrites.length).toBe(1);
    expect(debits()).toBe(1);
    expect(settledKeys()).toEqual([supply.settledAttemptKey(id, sent)]);
    // not a fire: no credit, staleness carried at its accrued value (never decayed), so the due score after the write
    // is the score the old clock gives with the debit applied
    const written = rhythms[0]!["body"] as Row;
    expect(written["alpha"]).toBe(21);
    expect(Number(written["staleness"])).toBeCloseTo(accrued(now), 9);
    const after = rhythmDueScore(written as never, rhythms[0]!["updated_at"], now).due_score;
    const oldClock = rhythmDueScore({ ...LIVE_BODY, beta: 55.5 } as never, iso(now - 7.3 * H), now).due_score;
    expect(after).toBeCloseTo(oldClock, 9);
    expect(after).toBeLessThan(1);
    expect(bookkeepingLines()).toEqual(["[check-supply] bookkeeping: armed=0 outcomes=1 unarmed=0 released=0 waiting=0 dispatch=undue node=node-a"]);
    // the settlement write lost: the store reads goal_dispatched for the same dispatch again; the next undue pass
    // re-records it and debits nothing
    await seed(id, "pending", { check_supply: sent });
    lines = [];
    const second = await tick(now + 11 * MIN);
    expect(ledgerOf(await storeRow(id))["state"]).toBe("dispatch_failed");
    expect(((second["resettled"] ?? []) as Row[]).some((r) => r["id"] === id)).toBe(true);
    expect(rhythmWrites.length).toBe(1);
    expect(debits()).toBe(1);
  });

  it("[MUST-FAIL] NO DISPATCH ID, past dispatch_stale_hours: an undue pass recovers it as an unconfirmed send (non_attempt, not charged), never dispatch_lost; a due pass past its wait re-sends it", async () => {
    const now = Date.parse("2030-03-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const id = T("gcsb-noid");
    // the live rows: the in-flight record written, the send never recorded (no id, no goal text), streak kept
    const sent = { ...inFlight(id, now - 25 * H, null, "node-a"), non_attempt_streak: 8 };
    await seed(id, "noid", { check_supply: sent, gap_check_supply_arm: "treatment" });
    const body = await tick(now);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("non_attempt");
    expect(String(led["reason"])).toStartWith("send_unconfirmed:");
    expect(led["attempts"]).toBe(0);
    expect(body["dispatch"]).toBe("undue");
    expect(goals.length).toBe(0);
    // re-dispatch eligible: once the family is due and the attempt's backoff (24 h) has passed, it is sent again
    const later = now + 30 * H;
    rhythms = [{ ...rhythms[0], updated_at: iso(later - 60 * H) }];
    await tick(later);
    expect(goals.filter((g) => g.variables?.["gap_id"] === id).length).toBe(1);
    const again = ledgerOf(await storeRow(id));
    expect(again["state"]).toBe("goal_dispatched");
    expect(again["attempts"]).toBe(1);
    expect(String(again["dispatch_id"])).toStartWith(`d-${RUN}-sent-`);
  });

  it("[MUST-FAIL] DISPATCHED BY ANOTHER NODE: this node's undue pass neither probes nor writes it; the sending node's own undue pass settles it by verdict", async () => {
    const now = Date.parse("2030-04-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const id = T("gcsb-foreign");
    const did = `7233fc15-${RUN}`;
    executions[did] = { status: "completed", reached: false, goalReachReason: "no check written" };
    await seed(id, "foreign", { check_supply: inFlight(id, now - 19 * H, did, "node-b") });
    const before = JSON.stringify(await storeRow(id));
    const here = await tick(now);
    expect(probes).not.toContain(did);
    expect(JSON.stringify(await storeRow(id))).toBe(before);
    expect(rhythmWrites.length).toBe(0);
    // the sending node's pass (its own rhythm, also undue)
    process.env["SUBSTRATE_NAME"] = "node-b";
    await tick(now + 11 * MIN);
    expect(probes).toContain(did);
    const led = ledgerOf(await storeRow(id));
    expect(led["state"]).toBe("dispatch_failed");
    expect(debits()).toBe(1);
    expect(goals.length).toBe(0);
    // and this node's pass had read it, waiting on its owner, not skipped it unread
    expect((((here["outcomes"] ?? {}) as Row)["waiting"] as Row[] | undefined)?.some((w) => w["id"] === id && w["why"] === "owning_node_never_settled")).toBe(true);
  });

  it("[MUST-FAIL] OWN CHECK (the live row's stored shape): an undue pass un-arms it, the seam re-labels it unresolvable, and the rhythm is not written", async () => {
    const now = Date.parse("2030-05-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    const id = `route-edit-93306110-${RUN}`;
    plant([ownCheckRow(id)]);
    const before = JSON.stringify(rhythms[0]);
    await tick(now);
    const m = metaOf(await storeRow(id));
    expect(m["own_check_unarmed"]).toMatchObject({ site: OWN_CHECK_SITE, reason: "edit_site_is_own_check" });
    expect(m["falsifier"]).toBe("unresolvable");
    expect(lines).toContain(`[check-supply] un-armed ${id}: edit_site_is_own_check (${OWN_CHECK_SITE})`);
    expect(bookkeepingLines()).toEqual(["[check-supply] bookkeeping: armed=0 outcomes=0 unarmed=1 released=0 waiting=0 dispatch=undue node=node-a"]);
    // the rhythm row as it was: staleness and updated_at unchanged
    expect(rhythmWrites.length).toBe(0);
    expect(JSON.stringify(rhythms[0])).toBe(before);
  });
  it("[MUST-FAIL] the pass marker is exactly one line per pass that ran: a call inside the floor logs none and does nothing; a due pass logs it with dispatch=due", async () => {
    const now = Date.parse("2030-07-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    await tick(now);
    expect(bookkeepingLines()).toEqual(["[check-supply] bookkeeping: 0 due armed=0 outcomes=0 unarmed=0 released=0 waiting=0 dispatch=undue node=node-a"]);
    const floored = await tick(now + 5 * MIN); // inside bookkeeping_min_interval_s (default 600 s)
    expect(String(floored["bookkeeping"])).toStartWith("skipped:");
    expect(floored["reason"]).toBe("not_due");
    expect(bookkeepingLines().length).toBe(1);
    rhythms = [liveRhythm(now + 6 * MIN, 40)]; // due: a due pass is never floored
    await tick(now + 6 * MIN);
    expect(bookkeepingLines()).toEqual([
      "[check-supply] bookkeeping: 0 due armed=0 outcomes=0 unarmed=0 released=0 waiting=0 dispatch=undue node=node-a",
      "[check-supply] bookkeeping: 0 due armed=0 outcomes=0 unarmed=0 released=0 waiting=0 dispatch=due node=node-a",
    ]);
    // the undue and floored calls write nothing; the due pass writes its claim (RAN_PACING) and nothing else
    // (gap-check-supply-claim-pacing.test.ts)
    expect(rhythmWrites.map((w) => (w["body"] as Row)["staleness"])).toEqual([0]);
  });
  it("[MUST-FAIL] an unreadable gap store is not an empty one: the pass logs store_unreadable, never the '0 due' marker, and writes nothing", async () => {
    const now = Date.parse("2030-08-01T00:00:00.000Z");
    rhythms = [liveRhythm(now)];
    process.env["GAP_STORE_ENDPOINT"] = UNREACHABLE_HOLDER; // a node that forwards its store to a holder that does not answer
    let body: Row;
    try { body = await tick(now); } finally { delete process.env["GAP_STORE_ENDPOINT"]; }
    expect(body["reason"]).toBe("store_unreadable");
    expect(body["fired"]).toBe(false);
    expect(bookkeepingLines()).toEqual([`[check-supply] bookkeeping: store_unreadable dispatch=undue node=node-a (gap store at ${UNREACHABLE_HOLDER} unreachable: Unable to connect. Is the computer able to access the url?)`]);
    expect(rhythmWrites.length).toBe(0);
    expect(goals.length).toBe(0);
  });
});

describe("a due pass is unchanged", () => {
  it("[CONTROL] the same fixture with the rhythm DUE: the pending row settles with one debit and a fresh row is sent its goal", async () => {
    const now = Date.parse("2030-06-01T00:00:00.000Z");
    rhythms = [liveRhythm(now, 40)]; // the same row written 40 h earlier: due ~1.8
    expect(rhythmDueScore(LIVE_BODY as never, iso(now - 40 * H), now).due_score).toBeGreaterThan(1);
    const pending = T("gcsb-due-pending");
    const did = `a84c22ca-due-${RUN}`;
    executions[did] = { status: "failed", reached: false, goalReachReason: "the compose did not write the check" };
    await seed(pending, "due-pending", { check_supply: inFlight(pending, now - 7.3 * H, did, "node-a") });
    const fresh = T("gcsb-due-fresh");
    await seed(fresh, "due-fresh", {});
    const body = await tick(now);
    expect(ledgerOf(await storeRow(pending))["state"]).toBe("dispatch_failed");
    expect(goals.filter((g) => g.variables?.["gap_id"] === fresh).length).toBe(1);
    expect(ledgerOf(await storeRow(fresh))["state"]).toBe("goal_dispatched");
    expect((body["dispatched"] as Row[]).map((d) => d["id"])).toEqual([fresh]);
    expect(body["settlement"]).toBe("beta");
    // the claim before the work (RAN_PACING, gap-check-supply-claim-pacing.test.ts), then the settlement as before
    expect(rhythmWrites.length).toBe(2);
    expect((rhythmWrites[0]!["body"] as Row)["staleness"]).toBe(0);
    expect(debits()).toBe(1);
    // the settlement credits on the claimed pacing: the debit is kept, the staleness stays reset (it used to carry
    // the accrued value, which on a claimed pass would write the family straight back to due)
    expect(Number((rhythms[0]!["body"] as Row)["staleness"])).toBe(0);
  });
});
