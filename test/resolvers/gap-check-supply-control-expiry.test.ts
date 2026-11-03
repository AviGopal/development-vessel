// THE CONTROL ARM IS TIME-BOXED (user ruling, "Time-box it").
//
// gap-check-supply's control arm marked a row gap_check_supply_arm "control", held it with CHECK_SUPPLY_DISPOSITION and
// skipped it on every later pass, with no arm timestamp and no expiry: the hold kept the row from every other arming
// route too, indefinitely. Now a control row carries gap_check_supply_arm_at, and one older than the supply rhythm's
// control_expiry_days (default 7) moves to treatment (gap_check_supply_arm_expired_at), its supply hold cleared; treatment
// is sticky; stamps and expiries share the shaped control_expiry_per_tick bound (default max_per_tick).
//   MUST-FAIL (red at the parent by assertion, no new seam): (2) a control row with no stamp is stamped and stays control;
//     (1) a control row stamped past the time-box becomes treatment, its CHECK_SUPPLY_DISPOSITION cleared, and is sent its
//     goal on the NEXT pass; an expired row whose hash still says control is never re-marked control.
//   CONTROLS: a younger control row stays control; a treatment row gets no stamp; a disposition that is not the supply's
//     is never cleared; control_expiry_days is read from the rhythm; the per-pass bound is respected.
// Harness: as gap-check-supply-order.test.ts (temp gap store, temp clones, stubbed fetch).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-ctlexp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// The shaped policies directory is this file's own temp checkout, never the live super clone's (as the order test).
process.env["SUPER_REPO_DIR"] = join(ROOT, "policy-super");
mkdirSync(join(ROOT, "policy-super", ".git"), { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const EDIT = `repos/${VESSEL}/src/widget.ts`;
const DAY = 86_400_000;
const NOW = Date.now();

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let rhythms: Row[] = [];
let logs: string[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date(NOW).toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 5, backoff_hours: 24, max_attempts: 3, control_fraction: 1, ...extra },
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
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) { goals.push({ goal: String(body.goal ?? ""), variables: body.variables }); return Response.json({ dispatchId: `d-${RUN}-${goals.length}` }, { status: 202 }); }
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"], require_falsifier_classes: ["class2"] } }], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); restoreCutoverExecModules(); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(async () => { goals = []; logs = []; rhythms = [dueRhythm()]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); await closeAllOpen(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

/** An id in the requested hash arm at control_fraction 0.5 (at 1 every id is control). */
function idIn(prefix: string, arm: "control" | "treatment"): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id, 0.5) === arm) return id; }
  throw new Error(`no ${arm} id`);
}
/** One open, unarmed gap whose check can be written (edit site in the clone, a stated falsifier): a supply candidate. */
async function seed(id: string, meta: Row = {}): Promise<void> {
  const summary = `control-expiry fixture ${RUN}: ${EDIT} widget returns 1; it must return 2`;
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2026-09-01T00:00:00Z", summary,
    classification_metadata: { edit_site: EDIT, falsifier_spec: "must-fail: widget() === 2 at HEAD is false", ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
const control = (armAtMs: number | null, extra: Row = {}): Row => ({ gap_check_supply_arm: "control", disposition: "needs_localization", ...(armAtMs === null ? {} : { gap_check_supply_arm_at: new Date(armAtMs).toISOString() }), ...extra });
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-control-expiry.test.ts" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
async function metaOf(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`seeded gap ${id} not in the store`);
  return (row["classification_metadata"] ?? {}) as Row;
}
const goalsFor = (id: string) => goals.filter((g) => g.variables?.["gap_id"] === id);

describe("the check-supply control arm is time-boxed", () => {
  it("MUST-FAIL (2): a control row with no arm stamp gets one this pass and stays control (its clock starts now)", async () => {
    const id = idIn("ctl-nostamp", "control");
    await seed(id, control(null));
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm_at"]).toBe(new Date(NOW).toISOString());
    expect(m["gap_check_supply_arm"]).toBe("control");
    expect(m["disposition"]).toBe("needs_localization");
    expect(m["gap_check_supply_arm_expired_at"]).toBeUndefined();
    expect(goalsFor(id)).toEqual([]);
  });

  it("MUST-FAIL (1): a control row stamped past control_expiry_days becomes treatment, its supply hold cleared, and is sent its goal on the next pass", async () => {
    const id = idIn("ctl-old", "control");
    await seed(id, control(NOW - 8 * DAY));
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("treatment");
    expect(m["gap_check_supply_arm_expired_at"]).toBe(new Date(NOW).toISOString());
    expect(m["disposition"]).toBe("");
    expect(supply.checkSupplyDisposition({ id, status: "open", category: "systematic_failure", classification_metadata: m })).not.toBeNull();
    expect(logs.some((l) => l === `[check-supply] control arm expired: ${id} after 8.0 days`)).toBe(true);
    expect(goalsFor(id)).toEqual([]); // the expiry pass touched it: supply work from the next pass
    await tick(NOW + 60_000);
    expect(goalsFor(id).length).toBe(1);
    expect((await metaOf(id))["gap_check_supply_arm"]).toBe("treatment");
  });

  it("MUST-FAIL: an expired row is treatment for good: its hash says control (control_fraction 1), it is not re-marked and is sent its goal", async () => {
    const id = idIn("ctl-sticky", "control");
    await seed(id, { gap_check_supply_arm: "treatment", gap_check_supply_arm_at: new Date(NOW - 9 * DAY).toISOString(), gap_check_supply_arm_expired_at: new Date(NOW - DAY).toISOString(), disposition: "" });
    await tick(NOW);
    expect((await metaOf(id))["gap_check_supply_arm"]).toBe("treatment");
    expect(goalsFor(id).length).toBe(1);
  });

  it("CONTROL: a control row younger than control_expiry_days stays control and held", async () => {
    const id = idIn("ctl-young", "control");
    await seed(id, control(NOW - 3 * DAY));
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("control");
    expect(m["disposition"]).toBe("needs_localization");
    expect(m["gap_check_supply_arm_at"]).toBe(new Date(NOW - 3 * DAY).toISOString());
    expect(m["gap_check_supply_arm_expired_at"]).toBeUndefined();
    expect(goalsFor(id)).toEqual([]);
  });

  it("CONTROL: control_expiry_days is read from the rhythm: the same 3-day-old row expires at 2 days", async () => {
    rhythms = [dueRhythm({ control_expiry_days: 2 })];
    const id = idIn("ctl-shaped", "control");
    await seed(id, control(NOW - 3 * DAY));
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("treatment");
    expect(m["disposition"]).toBe("");
  });

  it("CONTROL: a disposition that is not the supply's hold is kept when the row expires", async () => {
    const id = idIn("ctl-otherdisp", "control");
    await seed(id, control(NOW - 8 * DAY, { disposition: "after_run_2" }));
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("treatment");
    expect(m["gap_check_supply_arm_expired_at"]).toBe(new Date(NOW).toISOString());
    expect(m["disposition"]).toBe("after_run_2");
  });

  it("CONTROL: a treatment row is unchanged by the time-box (no stamp, no expiry)", async () => {
    rhythms = [dueRhythm({ control_fraction: 0.5 })];
    const id = idIn("ctl-treat", "treatment");
    await seed(id, { gap_check_supply_arm: "treatment" });
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("treatment");
    expect("gap_check_supply_arm_at" in m).toBe(false);
    expect("gap_check_supply_arm_expired_at" in m).toBe(false);
    expect(goalsFor(id).length).toBe(1);
  });

  it("CONTROL: a newly marked control row carries its stamp in the same write", async () => {
    const id = idIn("ctl-new", "control");
    await seed(id);
    await tick(NOW);
    const m = await metaOf(id);
    expect(m["gap_check_supply_arm"]).toBe("control");
    expect(m["gap_check_supply_arm_at"]).toBe(new Date(NOW).toISOString());
  });

  it("CONTROL: the per-pass bound: control_expiry_per_tick caps expiries and stamps together; absent, max_per_tick does", async () => {
    rhythms = [dueRhythm({ control_expiry_per_tick: 2 })];
    const olds = [idIn("ctl-cap-a", "control"), idIn("ctl-cap-b", "control"), idIn("ctl-cap-c", "control")];
    for (const [i, id] of olds.entries()) await seed(id, control(NOW - (8 + i) * DAY));
    const fresh = idIn("ctl-cap-n", "control");
    await seed(fresh, control(null));
    await tick(NOW);
    const arms1 = await Promise.all([...olds, fresh].map(async (id) => (await metaOf(id))["gap_check_supply_arm"]));
    // the two OLDEST expire first; the third and the stamp wait
    expect(arms1).toEqual(["control", "treatment", "treatment", "control"]);
    expect((await metaOf(fresh))["gap_check_supply_arm_at"]).toBeUndefined();
    await tick(NOW + 60_000);
    expect((await metaOf(olds[0]!))["gap_check_supply_arm"]).toBe("treatment");
    expect((await metaOf(fresh))["gap_check_supply_arm_at"]).toBe(new Date(NOW + 60_000).toISOString());

    await closeAllOpen();
    rhythms = [dueRhythm({ max_per_tick: 1 })];
    const d = [idIn("ctl-dflt-a", "control"), idIn("ctl-dflt-b", "control")];
    for (const id of d) await seed(id, control(NOW - 8 * DAY));
    await tick(NOW + 120_000);
    const arms2 = await Promise.all(d.map(async (id) => (await metaOf(id))["gap_check_supply_arm"]));
    expect(arms2.filter((a) => a === "treatment").length).toBe(1);
  });
});
