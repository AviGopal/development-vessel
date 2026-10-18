// AN OBSERVE COMPOSE NEVER LANDS AND WRITES NO LEARNED STATE (src/resolvers/compose-observe.ts).
//
// Measured: goal-host's observe probe was handed to feature_compose with land:true; the compose grounded, planned,
// drafted and ran the suite, and only an admission refusal stood between the probe and a commit. goal-host now sends
// learning_mode "observe" with land:false + skip_push:true. CONTRACT pinned here:
//   - [MUST-FAIL] the observe pointer is ADMITTED exactly as the landing compose it measures: an unarmed store gap is
//     refused at stage ineligible before the slot claim (a plain land:false compose is not, and stays so: control);
//   - [CONTROL] an armed store gap passes admission the same way (stops at the pre-claimed slot) — and the observe
//     compose takes no landing lease, while the learn compose does;
//   - [MUST-FAIL] inside an observe compose every gap-store write of feature-compose.ts is skipped and recorded once;
//     [CONTROL] the same write in a learn compose reaches the store;
//   - [MUST-FAIL] the observe compose runs with land:false + skip_push:true, rolls its edits back even when FAVORABLE,
//     parks nothing, writes no lesson and reports the would-be ops with "observe: dry run, not landed";
//     [CONTROL] a learn compose's pointer is passed through unchanged, so it still reaches its landing step.
//   - [MUST-FAIL] the mode is the compose's own (AsyncLocalStorage run): the caller's continuation does not inherit it;
//   - [MUST-FAIL] an observe compose's traces carry learning_mode:"observe" (body field and tag) and no reach verdict,
//     and gap-to-feature's /reach for an observe report says observe; [CONTROL] a learn compose's carry neither.
// Harness: compose-landing-lease-admission.test.ts's (fixture store, fetch/fs/exec guards, a pre-claimed slot).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const ROOT = join(tmpdir(), `compose-observe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
await isolateRuntimeRoot("compose-observe", { who: "compose-observe.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.js");
const co = await import("../../src/resolvers/compose-observe.js");
const { __setComposeCapacityReaderForTests } = await import("../../src/compose-slots.js");
const { resolveFeatureCompose } = fc;

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-18T00:00:00Z";
const EDIT = "repos/activity-api/src/lib/successor-features.ts";
const UNARMED = "observe-fixture-unarmed";
const ARMED = "observe-fixture-armed";
const FC_SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");

const row = (id: string, meta: Record<string, unknown>) => ({ id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", classification_metadata: meta, created_at: AT, updated_at: AT });
/** goal-host's edit-intent pointer, verbatim, with the observe fields spread after land:true (observe-mode.ts). */
const observePointer = (id: string) => ({ type: "feature_compose", directed: true, authoring_execution_id: "dispatch-fixture", spec: `fixture ${id}`,
  verify_vessels: ["repos/activity-api"], land: true, learning_mode: "observe", ...{ land: false, skip_push: true },
  gap: { id, summary: `fixture ${id}`, category: "edit_intent_route", classification_metadata: { edit_site: EDIT } } });
type Report = { ok?: boolean; verdict?: string; stage?: string; error?: string };

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];
let store: Map<string, Record<string, any>>;
let gapWrites = 0;

beforeEach(() => { __setComposeCapacityReaderForTests(async () => null); });
afterAll(() => { __setComposeCapacityReaderForTests(null); });
beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  savedSlotDir = process.env["COMPOSE_SLOT_DIR"];
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  rmSync(SLOTS, { recursive: true, force: true });
  logs = [];
  gapWrites = 0;
  spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")].map((s) => s.mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  store = routeFixtureGapStore(fetchGuard);
  const fixture = store;
  fetchGuard.route({ name: "gap write counter", match: (u, b) => u.startsWith("http://gap-store.fixture") && b?.impulse?.pointer?.type === "substrateGap_write", respond: (_u, b) => { gapWrites++; const id = String(b.impulse.pointer.gap?.id ?? ""); fixture.set(id, { ...(fixture.get(id) ?? {}), ...b.impulse.pointer.gap }); return Response.json({ shape: "substrateGapWriteResult", body: { id } }); } });
  store.set(UNARMED, row(UNARMED, { falsifier: "unresolvable", edit_site: EDIT }));
  store.set(ARMED, row(ARMED, { falsifier: "class2", edit_site: EDIT }));
});
afterEach(() => {
  const fetchV = fetchGuard?.restore() ?? [];
  const fsV = fsGuard?.restore() ?? [];
  const execV = execGuard?.restore() ?? [];
  fetchGuard = fsGuard = execGuard = null as never;
  for (const s of spies) s.mockRestore();
  spies = [];
  if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint;
  if (savedSlotDir === undefined) delete process.env["COMPOSE_SLOT_DIR"]; else process.env["COMPOSE_SLOT_DIR"] = savedSlotDir;
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
const slotFiles = (): string[] => (existsSync(SLOTS) ? readdirSync(SLOTS).sort() : []);
const leaseLogged = (): boolean => logs.some((l) => l.includes("[feature-compose] landing lease"));

describe("an observe compose is admitted exactly as the landing compose it measures", () => {
  it("[MUST-FAIL] the observe pointer (land:false + learning_mode observe) for an UNARMED store gap is refused ineligible before the slot", async () => {
    preClaimSlot(UNARMED);
    const b = (await resolveFeatureCompose(observePointer(UNARMED) as never)).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("unarmed");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(gapWrites).toBe(0);
  });
  it("[CONTROL] a plain non-landing compose (land:false, no learning_mode) of the same gap is not refused for eligibility", async () => {
    preClaimSlot(UNARMED);
    const { learning_mode: _m, ...plain } = observePointer(UNARMED);
    const b = (await resolveFeatureCompose(plain as never)).body as Report;
    expect(b.stage).not.toBe("ineligible");
  });
  it("[CONTROL] an ARMED store gap passes admission either way; only the learn compose takes the landing lease", async () => {
    preClaimSlot(ARMED);
    const obs = (await resolveFeatureCompose(observePointer(ARMED) as never)).body as Report;
    expect(obs.stage).toBe("gap_in_flight");
    expect(leaseLogged()).toBe(false);
    const { learning_mode: _m, land: _l, skip_push: _s, ...rest } = observePointer(ARMED);
    const learn = (await resolveFeatureCompose({ ...rest, land: true } as never)).body as Report;
    expect(learn.stage).toBe("gap_in_flight");
    expect(leaseLogged()).toBe(true);
  });
});

describe("inside an observe compose no gap-store write reaches the store", () => {
  const dissent = { reason: "fixture dissent", gate_verdict: "UNFAVORABLE", at: AT, later_outcome: null } as never;
  it("[MUST-FAIL] observe: the dissent writer (the store's own writer, default deps) writes nothing; the skip is recorded once", async () => {
    await co.composeObserveContext.run({ observe: true, announced: new Set() }, async () => {
      await fc.recordSemanticDissent(ARMED, dissent);
      await fc.recordSemanticDissent(ARMED, dissent);
    });
    expect(gapWrites).toBe(0);
    expect(logs.filter((l) => l === "[observe] skipped gap_store_write (compose observe)").length).toBe(1);
  });
  it("[MUST-FAIL] a compose runs inside its own mode: its later, awaited writers read it, and it ends with the compose", async () => {
    await co.runComposeObserve({ learning_mode: "observe" }, async (observe) => {
      expect(observe).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(co.composeObserveActive()).toBe(true);
      await (async () => { await Promise.resolve(); expect(co.composeObserveSkip("gap_store_write")).toBe(true); })();
    });
    expect(co.composeObserveActive()).toBe(false);
    await co.runComposeObserve({ learning_mode: "learn" }, async (observe) => {
      expect(observe).toBe(false);
      await new Promise((r) => setTimeout(r, 5));
      expect(co.composeObserveActive()).toBe(false);
      expect(co.composeObserveSkip("gap_store_write")).toBe(false);
    });
  });
  it("[MUST-FAIL] the caller's continuation after an observe compose does not inherit its mode (run, not enterWith)", async () => {
    preClaimSlot(UNARMED);
    expect(co.composeObserveActive()).toBe(false);
    const b = (await resolveFeatureCompose(observePointer(UNARMED) as never)).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(co.composeObserveActive()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(co.composeObserveActive()).toBe(false);
    expect(co.composeObserveSkip("gap_store_write")).toBe(false);
  });
  it("[CONTROL] learn: the same write reaches the store", async () => {
    await co.composeObserveContext.run({ observe: false, announced: new Set() }, async () => { await fc.recordSemanticDissent(ARMED, dissent); });
    expect(gapWrites).toBe(1);
  });
});

describe("an observe compose never lands", () => {
  it("[MUST-FAIL] the compose body runs with land:false + skip_push:true; a learn pointer passes through unchanged", () => {
    const p = { type: "feature_compose", spec: "x", land: true, learning_mode: "observe" as const };
    expect(co.observeComposePointer(p)).toEqual({ ...p, land: false, skip_push: true, keep_on_fail: false });
    // keep_on_fail would keep an observe compose's edits in the tree: an observe compose keeps none
    expect(co.observeComposePointer({ ...p, keep_on_fail: true }).keep_on_fail).toBe(false);
    const learn = { type: "feature_compose", spec: "x", land: true };
    expect(co.observeComposePointer(learn)).toBe(learn);
    expect(co.admissionLandOf({ land: false, learning_mode: "observe" })).toBe(true);
    expect(co.admissionLandOf({ land: false })).toBe(false);
    expect(co.admissionLandOf({})).toBe(true);
    expect(FC_SRC).toContain("const outcome = await resolveFeatureComposeUncapped(observeComposePointer(pointer));");
    expect(FC_SRC).toContain("return await runComposeObserve(pointer, (observeRun) => resolveFeatureComposeInMode(pointer, observeRun));");
    expect(FC_SRC).not.toContain("enterWith");
    expect(FC_SRC).toContain("const admissionLand = admissionLandOf(pointer);");
    expect(FC_SRC).toContain("if (landingLeaseGap && !observeRun) {");
  });
  it("[MUST-FAIL] an observe compose's traces are tagged observe and carry no reach verdict; /reach of an observe report says so", async () => {
    await co.runComposeObserve({ learning_mode: "observe" }, async () => {
      expect(co.observeTraceFields()).toEqual({ learning_mode: "observe", tags: ["learning_mode:observe"] });
    });
    // both feature_compose trace POSTs (the plan-refusal trace and the compose trace) spread the fields
    expect(FC_SRC.match(/\.\.\.observeTraceFields\(\), \/\/ OBSERVE: recorded ungraded \(compose-observe\.ts\)/g)?.length).toBe(2);
    expect(FC_SRC).toContain('refusal_reason: refusalReason, ...(composeObserveActive() ? { learning_mode: "observe" } : {}) },');
    expect(FC_SRC).toContain('...(composeObserveActive() ? { learning_mode: "observe" } : { reached: verdict === "FAVORABLE" && landedVessels.length > 0 }), landed_vessels:');
    expect(FC_SRC).not.toContain("          reached: verdict === \"FAVORABLE\" && landedVessels.length > 0, landed_vessels:");
    const G2F = readFileSync(join(import.meta.dir, "../../src/resolvers/gap-to-feature.ts"), "utf8");
    for (const id of ["reachId", "reachId2"]) expect(G2F).toContain(`body: JSON.stringify({ execution_id: ${id}, reached: cb["ok"] === true, ...(cb["observe"] === true ? { learning_mode: "observe" } : {}) }),`);
  });
  it("[CONTROL] a learn compose's traces carry no observe field", async () => {
    await co.runComposeObserve({ learning_mode: "learn" }, async () => { expect(co.observeTraceFields()).toEqual({}); });
    expect(co.observeTraceFields()).toEqual({});
  });
  it("[CONTROL] the landing step is unchanged for a learn compose (FAVORABLE && pointer.land)", () => {
    expect(FC_SRC).toContain('if (verdict === "FAVORABLE" && pointer.land) {');
  });
  it("[MUST-FAIL] the edits are rolled back even when FAVORABLE, nothing is parked or taught, and the report says why with the ops", () => {
    expect(FC_SRC).toContain('if (((verdict as string) === "UNFAVORABLE" || composeObserveActive()) && !pointer.keep_on_fail) {');
    expect(FC_SRC).toContain("...(composeObserveActive() ? observeReportFields(ops) : {}),");
    expect(FC_SRC).toMatch(/export async function writeParkedLanding\(park: ParkedLanding\): Promise<void> \{\n\s*if \(composeObserveSkip\("parked_landing"\)\) return;/);
    expect(FC_SRC).toMatch(/export async function appendComposeLesson\([^\n]*\n\s*if \(composeObserveSkip\("compose_lesson"\)\) return;/);
    expect(FC_SRC).toContain('if (composeObserveSkip("gap_store_write")) break;');
    // every gap-store write in the file goes through the observe-aware writer
    expect(FC_SRC.match(/resolveSubstrateGapWriteStore\(/g)?.length).toBe(1);
    expect(co.observeReportFields([{ op: "edit", path: EDIT }])).toEqual({ observe: true, landed: false, reason: "observe: dry run, not landed", would_be_ops: [{ op: "edit", path: EDIT }] });
  });
});
