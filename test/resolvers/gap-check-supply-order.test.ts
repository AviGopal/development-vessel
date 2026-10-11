// CHECK-FIRST (B4, operator bootstrap under the user's 2026-10-07 ruling) for gap
// gap-check-supply-dispatches-oldest-first-so-a-new-well-specified-gap-waits-behind-the-whole-unarmed-backlog.
// EXIT: B4 ends when the supply-ordering fix lands; every later gap reaches the lane by the supply's own order.
//
// Measured 2026-10-07 on node 1: gap-check-supply step 3 orders candidates by attempts ascending, then OLDEST first, and
// a candidate whose vessel does not resolve is skipped without using the slot. Of 944 vessel-resolvable, not-in-flight
// treatment candidates (~7.2 dispatches/day), a newly detected gap with an existing edit site and a stated falsifier sat
// at position ~942 (~130 days), behind prose-only rows with no edit site, the least likely to yield a red check.
// These pin the contract the lane's fix must meet (WHAT is dispatched, not how it is scored):
//   (i)  MUST-FAIL: with one slot, a gap whose check can be written (its edit site exists in the clone, a falsifier is
//        stated) is dispatched before older prose-only gaps with no edit site;
//   (ii) CONTROL: between two equally writable gaps, the older is dispatched first (the existing tie-break stands).
// THE PROSE GAPS NAME THEIR VESSEL (as real backlog rows do): a fixture that names none is skipped as no_vessel and never
// competes, so the must-fail would pass for the wrong reason (it did, before this was added); each case asserts every
// seeded gap is a supply candidate, resolves the vessel, and that the sort's age field orders them as intended (qa).
// FIELDS ARE THE REAL ONES: edit_site and falsifier_spec are classification_metadata keys real gaps carry.
// Red at origin/dev a80b86dc (received the oldest prose gap); green with an edit_site tie-break after attempts.
// Harness: as gap-check-supply-outcome.test.ts (temp gap store, temp clones, stubbed fetch).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";

const ROOT = join(tmpdir(), `gcs-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
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
const EDIT = `repos/${VESSEL}/src/widget.ts`;

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let goals: Array<{ goal: string; variables?: Record<string, unknown> }> = [];
let rhythms: Row[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date().toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 1, backoff_hours: 24, max_attempts: 3, ...extra },
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
  console.log = () => {};
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); restoreCutoverExecModules(); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { goals = []; rhythms = [dueRhythm()]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
/** Seed one open, unarmed gap; detected_at sets its age; meta adds an edit site / a stated falsifier. */
async function seed(id: string, detectedAt: string, summary: string, meta: Row = {}): Promise<void> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: detectedAt, summary, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
}
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-order.test.ts" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}
async function tick(now: number): Promise<Row> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: now } as never);
  await sg.__settleBirthEvaluationsForTests();
  return r.body as Row;
}
const dispatchedIds = () => goals.map((g) => String(g.variables?.["gap_id"] ?? ""));
async function storeRow(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`seeded gap ${id} not in the store`);
  return row;
}
/** The age the dispatch sort reads (gap-check-supply step 3): first_detected_at ?? detected_at. */
const sortAge = (r: Row): string => String(r["first_detected_at"] ?? r["detected_at"] ?? "");
/** PRECONDITIONS (qa): every seeded gap is a supply candidate (not birth-armed, not held), and the ages the sort reads
 *  are in the intended order. Without these, a red or green could come from candidacy, not ordering. */
async function expectCandidatesInAgeOrder(idsOldestFirst: string[]): Promise<void> {
  const rows = await Promise.all(idsOldestFirst.map(storeRow));
  for (const r of rows) expect(supply.checkSupplyDisposition(r)).not.toBeNull();
  // a candidate whose vessel does not resolve is skipped without using the slot, so it could never compete (qa)
  for (const r of rows) expect(supply.checkSupplyVessel(r)).toBe(VESSEL);
  for (let i = 1; i < rows.length; i++) expect(sortAge(rows[i - 1]!) < sortAge(rows[i]!)).toBe(true);
}

describe("gap-check-supply spends its slot where a check can be written", () => {
  it("MUST-FAIL: a new gap with an existing edit site and a stated falsifier is dispatched before older prose-only gaps", async () => {
    await closeAllOpen();
    const old1 = T("gcs-order-prose-a"), old2 = T("gcs-order-prose-b"), fresh = T("gcs-order-specified");
    await seed(old1, "2026-09-01T00:00:00Z", `prose fixture ${RUN}: something in local-tools-vessel feels off around widgets`);
    await seed(old2, "2026-09-02T00:00:00Z", `prose fixture ${RUN}: the local-tools-vessel widget area could be better`);
    await seed(fresh, "2026-10-07T00:00:00Z", `specified fixture ${RUN}: ${EDIT} widget returns 1; it must return 2`,
      { edit_site: EDIT, falsifier_spec: "must-fail: widget() === 2 at HEAD is false; control: widget is exported" });
    await expectCandidatesInAgeOrder([old1, old2, fresh]);
    await tick(Date.now());
    // Red at origin/dev must read `received [old1]` (the oldest prose gap); `[]` would be a harness/candidacy fault.
    expect(dispatchedIds()).toEqual([fresh]);
  });

  it("CONTROL: between two equally writable gaps the older is dispatched first", async () => {
    await closeAllOpen();
    const older = T("gcs-order-eq-old"), newer = T("gcs-order-eq-new");
    const meta = { edit_site: EDIT, falsifier_spec: "must-fail: widget() === 2 at HEAD is false" };
    await seed(older, "2026-09-01T00:00:00Z", `specified fixture ${RUN} A: ${EDIT} widget returns 1; it must return 2`, meta);
    await seed(newer, "2026-10-07T00:00:00Z", `specified fixture ${RUN} B: ${EDIT} widget returns 1; it must return 2`, meta);
    await expectCandidatesInAgeOrder([older, newer]);
    await tick(Date.now());
    expect(dispatchedIds()).toEqual([older]);
  });
});
