// FEATURE_COMPOSE ADMITS ONLY ELIGIBLE STORE GAPS ON THE AUTONOMOUS ROUTE (check-first, 2026-10-07).
//
// Measured 2026-10-06/07 (both nodes' journals): gap-env-gated-sf-discount, an UNARMED gap
// (falsifier "unresolvable", no edit_site, no evidence_resolve) that the sweep had also put on
// disposition pending_verification six times, was landed FOUR times by the lane: boredom's gap-goal
// supply -> goal-host gap-hydration -> EARLY EDIT-INTENT -> feature_compose land:true -> mitosis
// cutover (b025380, c305cce, 4c626a0, adb7d0d, all landed_unverified, own-check ran:false).
// composeEligibilitySkipReason (gap-to-feature) is THE eligibility predicate (open, armed class1/2, an
// edit site, not held), shared by the picker, the drain nudge and the gap-write nudge, but
// resolveFeatureCompose never called it, so any caller naming a store gap composed it regardless.
//
// CONTRACT pinned here:
//   - A compose that would land (land !== false), naming a gap the store holds, is refused
//     with stage "ineligible" and the predicate's reason when the STORED row is not compose work
//     (unarmed, no_edit_site, held incl. pending_verification, not_open), before the spend envelope,
//     the slot claim or any draft, and the refusal is logged with the gap id and reason.
//   - The stored row decides, not the caller's copy (goal-host's route passes only {edit_site}).
//   - DIRECTED composes too: `directed` is goal-host's operatorOrigin (trigger "operator"), set for any request
//     carrying an `operator` field, which autonomous dispatchers send for attribution.
//   - The EXACT pointer goal-host's early edit-intent route builds is refused for an unarmed store gap.
//   - CONTROLS: an armed, unheld gap passes admission (stops at the pre-claimed slot, gap_in_flight); a
//     non-landing compose and an edit-intent id the store does not hold are not refused for eligibility.
//
// SEAMS: the operator-hold-contains harness (GAP_STORE_ENDPOINT in-memory fixture store, fetch/fs/exec
// guards, a pre-claimed compose slot for the same gap id so a compose past admission stops at
// gap_in_flight without drafting, and an open spend envelope for the undirected path).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const ROOT = join(tmpdir(), `compose-admission-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"compose-admission-isolated"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
const { resolveSubstrateGap, resolveSubstrateGapWrite, gapStoreRootForTest } = sg;

const { resolveFeatureCompose } = await import("../../src/resolvers/feature-compose.js");
const { __resetPolicyReadsForTests, admitActionableGaps } = await import("../../src/resolvers/gap-to-feature.js");

const STORE = join(ROOT, "gaps", "gaps.json");
const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-03T10:00:00Z";

/** Predicate-free rows: no birth evaluation, no Class-1 arming read. */
function row(id: string, meta: Record<string, unknown>, updated = AT): Record<string, unknown> {
  return { id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", classification_metadata: meta, created_at: AT, updated_at: updated };
}
const HELD = "hold-fixture-held-gap";
const UNHELD = "hold-fixture-unheld-gap";
function seedStore(): void {
  writeFileSync(STORE, JSON.stringify([
    row(HELD, { operator_hold: true, operator_hold_reason: "redispatch livelock containment" }, "2026-10-03T10:00:02Z"),
    row(UNHELD, {}, "2026-10-03T10:00:01Z"),
  ]));
}
/** boredom-vessel goal-generation's pointer, verbatim. */
const BOREDOM_OPEN_READ = { type: "substrateGap", status: "open", limit: 100, sort: "disposition_scored" };
const ids = (r: { body: unknown }): string[] => ((r.body as { gaps?: Array<{ id: string }> }).gaps ?? []).map((g) => g.id);

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
let warnSpy: ReturnType<typeof spyOn> | null = null;
/** fs-guard violations a test declares as expected (BLOCKED by the guard, so nothing was written). */
let expectedFsBlocks: RegExp[] = [];

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  delete process.env["GAP_STORE_ENDPOINT"];
  savedSlotDir = process.env["COMPOSE_SLOT_DIR"];
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  rmSync(SLOTS, { recursive: true, force: true });
  seedStore();
  __resetPolicyReadsForTests();
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
});
afterEach(() => {
  const fetchV = fetchGuard?.restore() ?? [];
  const fsV = (fsGuard?.restore() ?? []).filter((v) => !expectedFsBlocks.some((re) => re.test(v)));
  expectedFsBlocks = [];
  const execV = execGuard?.restore() ?? [];
  fetchGuard = fsGuard = execGuard = null as never;
  logSpy?.mockRestore();
  logSpy = null;
  warnSpy?.mockRestore();
  warnSpy = null;
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

// A compose that gets past the hold check claims a slot; the pre-claimed slot for the same gap
// stops it there (stage gap_in_flight) before any workspace, LLM or edit.
function preClaimSlot(gapId: string): void {
  mkdirSync(SLOTS, { recursive: true });
  writeFileSync(join(SLOTS, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "pre-claimed", gap_id: gapId }));
}
const slotFiles = (): string[] => readdirSync(SLOTS).sort();
const composeGap = (id: string, meta: Record<string, unknown>) => ({ id, summary: `fixture ${id}`, category: "systematic_failure", status: "open", classification_metadata: meta });
type Report = { ok?: boolean; verdict?: string; stage?: string; error?: string };

const OPEN_POLICY = [
  { shape: "spendEnvelope", updated_at: AT, body: { uncapped: true, paused: false, reason: "fixture: no cap" } },
  { shape: "autonomyScope", updated_at: AT, body: { unrestricted: true, reason: "fixture: no containment" } },
];
/** The undirected path reads the spend envelope first; make it ALLOW so the hold check is what speaks. */
function routeOpenEnvelope(g: FetchGuard): void {
  const LOCAL_EP = "http://node-local:8090";
  const localRow = { vesselId: "development-vessel-local", endpoint: LOCAL_EP, resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
  g.route({ name: "discovery", match: (_u, b) => b?.pointer?.type === "vesselCapability", respond: (_u, b) => Response.json({ content: { shape: b.pointer.shape, vessels: [localRow], found: true } }) });
  g.route({ name: "pool", match: (_u, b) => b?.impulse?.type === "poolImpulse", respond: (_u, b) => Response.json({ body: { impulses: OPEN_POLICY.filter((r) => r.shape === b.impulse.shape) } }) });
  g.route({ name: "spend", match: (_u, b) => b?.impulse?.pointer?.type === "llmSpendSummaryNode", respond: () => Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: 0.1 }, previous: null } }) });
}

// THE HOLD LIVES IN THE STORE, NOT THE POINTER (round 2). A directed caller's pointer can carry {id}
// only, or metadata copied before the hold was set; deciding from the pointer is deciding from a
// stale copy. The compose reads the stored row (the same by-id read hydration uses) before the slot
// claim, and the stored row decides both ways. If it cannot be read the compose fails CLOSED with
// stage hold_state_unreadable, as the cutover defers on gap_store_unavailable.
//
// The store here is the shared in-memory fixture behind GAP_STORE_ENDPOINT (cutover-fetch-guard.ts
// routeFixtureGapStore): feature-compose reads through the SHARED substrate-gap instance, whose
// load-time root may be the checkout, so the forward is the only per-test redirect. An outage is
// that same endpoint declared unreachable (its route throws).
const STORE_ROUTE = "fixture gap store";
const nonStoreHits = (): string[] => fetchGuard!.hits.filter((h) => h !== STORE_ROUTE);

const UNARMED = "adm-fixture-unarmed";
const HELD_PV = "adm-fixture-pending-verification";
const NO_EDIT = "adm-fixture-armed-no-edit-site";
const ARMED = "adm-fixture-armed";
const ROUTE_ONLY = "route-edit-adm-fixture";
const EDIT = "repos/activity-api/src/lib/successor-features.ts";

describe("feature_compose admission: the autonomous route composes only eligible store gaps", () => {
  let store: Map<string, Record<string, any>>;
  beforeEach(() => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // the file-level afterEach restores the caller's value
    store = routeFixtureGapStore(fetchGuard!);
    store.set(UNARMED, row(UNARMED, { falsifier: "unresolvable" }));
    store.set(HELD_PV, row(HELD_PV, { falsifier: "class2", edit_site: EDIT, disposition: "pending_verification" }));
    store.set(NO_EDIT, row(NO_EDIT, { falsifier: "class1" }));
    store.set(ARMED, row(ARMED, { falsifier: "class2", edit_site: EDIT }));
    routeOpenEnvelope(fetchGuard!);
  });

  /** goal-host's edit-intent route: undirected, land defaults on, the caller's gap copy carries only {edit_site}. */
  const editIntentCompose = (id: string, extra: Record<string, unknown> = {}) =>
    resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${id}`, gap: composeGap(id, { edit_site: EDIT }), ...extra } as never);

  for (const [id, reason] of [[UNARMED, "unarmed"], [HELD_PV, "held"], [NO_EDIT, "no_edit_site"]] as const) {
    it(`[MUST-FAIL] an undirected landing compose of a store gap that is ${reason} is refused at stage ineligible before the slot claim, and logged`, async () => {
      preClaimSlot(id);
      const b = (await editIntentCompose(id)).body as Report;
      expect(b.ok).toBe(false);
      expect(b.stage).toBe("ineligible");
      expect(String(b.error)).toContain(reason);
      expect(slotFiles()).toEqual(["slot-0.slot"]);
      expect(logs.some((l) => l.includes("ineligible") && l.includes(id) && l.includes(reason))).toBe(true);
    });
  }

  // HERMETIC CONTROLS. An UNDIRECTED landing compose that passes admission next reads the spend envelope over the
  // network (discovery + pool + spend summary), so its arrival at the slot would depend on that lookup working in
  // the env running the suite (qa 2026-10-07: a stale ias-executor-ts adapter made it fail closed, stage "budget").
  // Admission runs for DIRECTED composes too and they skip the envelope, so the controls that must reach the slot
  // are directed: they still pass through admission, with no network on the path. The MUST-FAILs are refused
  // before the envelope either way.
  it("[CONTROL] an armed, unheld store gap passes admission and reaches the slot claim", async () => {
    preClaimSlot(ARMED);
    const b = (await editIntentCompose(ARMED, { directed: true })).body as Report;
    expect(b.stage).toBe("gap_in_flight");
    expect(nonStoreHits()).toEqual([]);
  });

  it("[MUST-FAIL] a DIRECTED compose of an unarmed store gap is refused too: directed is a self-declared operator field, not an authority", async () => {
    preClaimSlot(UNARMED);
    const b = (await editIntentCompose(UNARMED, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("unarmed");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[MUST-FAIL] the EXACT pointer goal-host's early edit-intent route builds (src/index.ts ~L13455) for an unarmed store gap is refused", async () => {
    preClaimSlot(UNARMED);
    const r = await resolveFeatureCompose({ type: "feature_compose",
      directed: false, authoring_execution_id: "dispatch-fixture", spec: `investigate and decompose gap ${UNARMED}`,
      verify_vessels: ["repos/activity-api"], land: true,
      gap: { id: UNARMED, summary: `investigate and decompose gap ${UNARMED}`, category: "edit_intent_route", classification_metadata: { edit_site: EDIT } },
    } as never);
    const b = r.body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("unarmed");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[CONTROL] a NON-landing compose (land:false) of an unarmed store gap is not refused for eligibility", async () => {
    preClaimSlot(UNARMED);
    const b = (await editIntentCompose(UNARMED, { land: false })).body as Report;
    expect(b.stage).not.toBe("ineligible");
  });

  it("[CONTROL] an edit-intent id the store does not hold is not refused for eligibility", async () => {
    preClaimSlot(ROUTE_ONLY);
    const b = (await editIntentCompose(ROUTE_ONLY, { directed: true })).body as Report;
    expect(b.stage).not.toBe("ineligible");
    expect(b.stage).toBe("gap_in_flight");
  });
});
