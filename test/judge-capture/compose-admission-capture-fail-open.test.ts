// THE ADMISSION CAPTURE NEVER CHANGES ADMISSION (routing capture, build 7 part 1).
//
// feature_compose writes a composeAdmission record at every admission decision. The recorder must be inert: when it
// throws (its line writer fails), the compose returns exactly what it returns with a working recorder, the slot and
// the store are left exactly as they are, and the failure is a counted capture_error. Pinned through
// resolveFeatureCompose itself, on the compose-admission harness (in-memory fixture gap store, fetch/fs/exec guards,
// a pre-claimed slot so an admitted compose stops at gap_in_flight before any workspace, LLM or edit):
//   - a refused compose (an unarmed store gap) records decision "refused", drafting_started false, why "unarmed";
//   - an admitted compose (an armed store gap) records decision "admitted", drafting_started false (it stopped at the
//     slot), why null;
//   - with a throwing recorder both return the identical report, leave the identical slot directory and store rows,
//     and the capture_error count rises by exactly one per decision;
//   - the refusals before the admission block are recorded the same way, with their stage: operator_hold (a held
//     store gap; it applies to a non-landing compose too) and hold_state_unreadable (the gap store unreachable);
//   - every record carries the lane (an undirected refusal says "undirected");
//   - a land:false compose past the hold check (admission does not run) records nothing.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "../resolvers/cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "../resolvers/cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "../resolvers/cutover-exec-guard.js";

const ROOT = join(tmpdir(), `admission-capture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
const { resolveFeatureCompose } = await import("../../src/resolvers/feature-compose.js");
const rc = await import("../../src/judge/routing-capture.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-03T10:00:00Z";
const EDIT = "repos/fixture-vessel/src/compute.ts";
const UNARMED = "capture-fixture-unarmed";
const ARMED = "capture-fixture-armed";
const HELD = "capture-fixture-held";
const DOWN_STORE = "http://gap-store-down.fixture/resolve";
const row = (id: string, meta: Record<string, unknown>): Record<string, unknown> =>
  ({ id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", classification_metadata: meta, created_at: AT, updated_at: AT });

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let saved: Record<string, string | undefined> = {};
let logSpy: ReturnType<typeof spyOn> | null = null;
let warnSpy: ReturnType<typeof spyOn> | null = null;
let errSpy: ReturnType<typeof spyOn> | null = null;
let logs: string[] = [];
let store: Map<string, Record<string, any>>;

beforeEach(() => {
  saved = { GAP_STORE_ENDPOINT: process.env["GAP_STORE_ENDPOINT"], COMPOSE_SLOT_DIR: process.env["COMPOSE_SLOT_DIR"] };
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  rmSync(SLOTS, { recursive: true, force: true });
  __resetPolicyReadsForTests();
  rc.__resetComposeAdmissionCaptureErrorsForTests();
  logs = [];
  const sink = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  logSpy = spyOn(console, "log").mockImplementation(sink);
  warnSpy = spyOn(console, "warn").mockImplementation(sink);
  errSpy = spyOn(console, "error").mockImplementation(sink);
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  store = routeFixtureGapStore(fetchGuard);
  store.set(UNARMED, row(UNARMED, { falsifier: "unresolvable", edit_site: EDIT }));
  store.set(ARMED, row(ARMED, { falsifier: "class2", edit_site: EDIT }));
  store.set(HELD, row(HELD, { falsifier: "class2", edit_site: EDIT, operator_hold: true, operator_hold_reason: "fixture hold" }));
  // A gap store declared unreachable: its route throws (the guard's outage convention; not a violation).
  fetchGuard.route({ name: "unreachable gap store", match: (u) => u.startsWith("http://gap-store-down.fixture"), respond: () => { throw new Error("fixture: gap store unreachable"); } });
});
afterEach(() => {
  rc.__setComposeAdmissionSinkForTests(null);
  const fetchV = fetchGuard?.restore() ?? [];
  const fsV = fsGuard?.restore() ?? [];
  const execV = execGuard?.restore() ?? [];
  fetchGuard = fsGuard = execGuard = null as never;
  logSpy?.mockRestore(); warnSpy?.mockRestore(); errSpy?.mockRestore();
  logSpy = warnSpy = errSpy = null;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(fetchV).toEqual([]);
  expect(fsV).toEqual([]);
  expect(execV).toEqual([]);
});
afterAll(() => {
  restoreCutoverFetch();
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

function preClaimSlot(gapId: string): void {
  mkdirSync(SLOTS, { recursive: true });
  writeFileSync(join(SLOTS, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "pre-claimed", gap_id: gapId }));
}
/** Directed by default, so neither path reads the spend envelope over the network (the compose-admission controls' rule). */
const compose = (id: string, extra: Record<string, unknown> = {}) =>
  resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${id}`, directed: true, ...extra, gap: { id, summary: `fixture ${id}`, category: "systematic_failure", status: "open", classification_metadata: { edit_site: EDIT } }, ...extra } as never);
/** The store rows as admission leaves them (the landing lease's own bookkeeping timestamps aside). */
const storeState = (): unknown => [...store.values()].map((r) => {
  const { landing_lease: _l, ...meta } = (r.classification_metadata ?? {}) as Record<string, unknown>;
  return { ...r, classification_metadata: meta };
});

/** One compose with a recording sink, then the same compose with a throwing sink, each on a fresh slot directory. */
async function runBoth(id: string, extra: Record<string, unknown> = {}) {
  const lines: string[] = [];
  rc.__setComposeAdmissionSinkForTests((l) => { lines.push(l); });
  preClaimSlot(id);
  const ok = (await compose(id, extra)).body;
  const okSlots = readdirSync(SLOTS).sort();
  const okStore = storeState();
  const errorsBefore = rc.composeAdmissionCaptureErrors();

  rmSync(SLOTS, { recursive: true, force: true });
  rc.__setComposeAdmissionSinkForTests(() => { throw new Error("fixture: the recorder's writer fails"); });
  preClaimSlot(id);
  const thrown = (await compose(id, extra)).body;
  return { lines, ok, okSlots, okStore, thrown, thrownSlots: readdirSync(SLOTS).sort(), thrownStore: storeState(), errorsAdded: rc.composeAdmissionCaptureErrors() - errorsBefore };
}
const recordOf = (line: string): Record<string, unknown> => JSON.parse(line.slice(rc.COMPOSE_ADMISSION_LINE_TAG.length + 1)) as Record<string, unknown>;

describe("the admission capture is inert: a throwing recorder leaves admission unchanged", () => {
  it("[MUST-FAIL] a refused compose: recorded as refused, and identical when the recorder throws (counted)", async () => {
    const r = await runBoth(UNARMED);
    expect((r.ok as { stage?: string }).stage).toBe("ineligible");
    expect(r.lines.length).toBe(1);
    expect(recordOf(r.lines[0]!)).toMatchObject({ entry: "composeAdmission", gap_id: UNARMED, decision: "refused", drafting_started: false, why: "unarmed", armed: false, edit_site: EDIT, scope: null, scope_reason: rc.SCOPE_NOT_CONSULTED });
    expect(r.thrown).toEqual(r.ok);
    expect(r.thrownSlots).toEqual(r.okSlots);
    expect(r.thrownStore).toEqual(r.okStore);
    expect(r.errorsAdded).toBe(1);
    expect(logs.some((l) => l.includes(`${rc.COMPOSE_ADMISSION_LINE_TAG} capture_error`) && l.includes(UNARMED))).toBe(true);
  });

  it("[MUST-FAIL] an admitted compose: recorded as admitted (stopped at the slot), and identical when the recorder throws (counted)", async () => {
    const r = await runBoth(ARMED);
    expect((r.ok as { stage?: string }).stage).toBe("gap_in_flight");
    expect(r.lines.length).toBe(1);
    expect(recordOf(r.lines[0]!)).toMatchObject({ entry: "composeAdmission", gap_id: ARMED, decision: "admitted", drafting_started: false, why: null, armed: true, falsifier_class: "class2" });
    expect(r.thrown).toEqual(r.ok);
    expect(r.thrownSlots).toEqual(r.okSlots);
    expect(r.thrownStore).toEqual(r.okStore);
    expect(r.errorsAdded).toBe(1);
  });

  it("[MUST-FAIL] an operator_hold refusal (before the admission block, non-landing too) is recorded with its stage, and identical when the recorder throws", async () => {
    for (const extra of [{}, { land: false }]) {
      rc.__resetComposeAdmissionCaptureErrorsForTests();
      const r = await runBoth(HELD, extra);
      expect((r.ok as { stage?: string }).stage).toBe("operator_hold");
      expect(r.lines.length).toBe(1);
      expect(recordOf(r.lines[0]!)).toMatchObject({ entry: "composeAdmission", gap_id: HELD, lane: "directed", decision: "refused", drafting_started: false, stage: "operator_hold", stored: "present", operator_hold: true, land: !("land" in extra), edit_site: EDIT, armed: true });
      expect(r.thrown).toEqual(r.ok);
      expect(r.thrownSlots).toEqual(r.okSlots);
      expect(r.thrownStore).toEqual(r.okStore);
      expect(r.errorsAdded).toBe(1);
    }
  });

  it("[MUST-FAIL] a hold_state_unreadable refusal (the store unreachable) is recorded with the caller's edit site, and identical when the recorder throws", async () => {
    process.env["GAP_STORE_ENDPOINT"] = DOWN_STORE;
    const r = await runBoth(UNARMED);
    expect((r.ok as { stage?: string }).stage).toBe("hold_state_unreadable");
    expect(r.lines.length).toBe(1);
    expect(recordOf(r.lines[0]!)).toMatchObject({ gap_id: UNARMED, lane: "directed", decision: "refused", stage: "hold_state_unreadable", stored: "unreadable", operator_hold: false, edit_site: EDIT, falsifier_class: null, armed: false, why: null });
    expect(r.thrown).toEqual(r.ok);
    expect(r.thrownSlots).toEqual(r.okSlots);
    expect(r.errorsAdded).toBe(1);
  });

  it("[MUST-FAIL] an undirected refusal records lane undirected", async () => {
    const r = await runBoth(UNARMED, { directed: false });
    expect((r.ok as { stage?: string }).stage).toBe("ineligible");
    expect(recordOf(r.lines[0]!)).toMatchObject({ lane: "undirected", stage: "ineligible", stored: "present", supply_marker: false, supply_verdict: null });
    expect(r.thrown).toEqual(r.ok);
  });

  it("[CONTROL] a non-landing compose does not run admission and records nothing", async () => {
    const r = await runBoth(UNARMED, { land: false });
    expect((r.ok as { stage?: string }).stage).not.toBe("ineligible");
    expect(r.lines).toEqual([]);
    expect(r.errorsAdded).toBe(0);
  });
});
