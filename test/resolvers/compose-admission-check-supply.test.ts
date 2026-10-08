// FEATURE_COMPOSE ADMITS A SUPPLY-DISPATCHED TEST-WRITING GOAL, AND ONLY THAT (check-first, slice G, 2026-10-08).
//
// Measured node1+compose2 2026-10-05..10-08: 24 gap-check-supply treatment dispatches, 0 reached, 0 armed. The supply
// (gap-check-supply.ts) sends a test-writing goal for an UNARMED gap (unarmed is its entry criterion) with structured
// variables { gap_id, check_supply: true }; goal-host's edit-intent route ignored them and composed under a minted
// route-edit-<hash> id, and on retry this resolver's admission (2026-10-07, "not compose work: unarmed") refused it:
// 8 of the last 9 dispatches died there. The supply's own gap id is refused identically, so routing it through
// goal-host alone does not help: admission must recognise the supply's dispatch.
//
// CONTRACT pinned here:
//   - A landing compose carrying the structured marker check_supply: { gap_id, dispatch_id }, for an unarmed store
//     gap whose ledger (classification_metadata.check_supply) says state "goal_dispatched" with THAT dispatch_id, is
//     admitted as test-writing work (compose_mode test_writing, logged) and reaches the next stage.
//   - The ledger is the authority, not the marker: marker + no matching ledger dispatch, marker naming gap A whose
//     dispatch id is gap B's, and a lookalike marker in the goal TEXT are all refused "not compose work: unarmed".
//   - Fail closed with a NAMED reason: ledger unreadable (check_supply_ledger_unreadable), ledger read timing out
//     (same), gap row missing (check_supply_gap_missing). Never falls through to admission.
//   - The supply writes its ledger AFTER goal-host's 202, so a compose can arrive first: a ledger that catches up
//     within the bounded re-read is admitted.
//   - Only the unarmed reason is waived: a supply gap that is closed, operator-held or awaiting a land verdict stays
//     refused.
//   - CONTROLS (unchanged routes, the old goal-host): no marker => the existing refusal; a route-edit id the store does
//     not hold => not refused for eligibility.
//
// SEAMS: compose-admission.test.ts's harness (GAP_STORE_ENDPOINT in-memory fixture store, fetch/fs/exec guards, a
// pre-claimed slot for the gap id so a compose past admission stops at gap_in_flight without drafting).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const ROOT = join(tmpdir(), `compose-admission-check-supply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!ROOT.startsWith(tmpdir())) throw new Error("refusing to run against a non-temp workspace root");
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"compose-admission-check-supply-isolated"}`);
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;
void sg;

const { resolveFeatureCompose } = await import("../../src/resolvers/feature-compose.js");
const { __resetPolicyReadsForTests } = await import("../../src/resolvers/gap-to-feature.js");
// The module this slice adds. Absent at base: the must-fails assert it, the controls do not need it.
const csa = await import("../../src/resolvers/check-supply-admission.js").catch(() => null) as null | {
  __setCheckSupplyLedgerWaitForTests: (w: { attempts?: number; delay_ms?: number; read_timeout_ms?: number } | null) => void;
};

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-08T10:00:00Z";

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
let warnSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  savedSlotDir = process.env["COMPOSE_SLOT_DIR"];
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  rmSync(SLOTS, { recursive: true, force: true });
  __resetPolicyReadsForTests();
  // Short, deterministic waits: the production re-read budget would make every refusal here take seconds.
  csa?.__setCheckSupplyLedgerWaitForTests({ attempts: 3, delay_ms: 15, read_timeout_ms: 200 });
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
});
afterEach(() => {
  const fetchV = fetchGuard?.restore() ?? [];
  const fsV = fsGuard?.restore() ?? [];
  const execV = execGuard?.restore() ?? [];
  fetchGuard = fsGuard = execGuard = null as never;
  logSpy?.mockRestore();
  logSpy = null;
  warnSpy?.mockRestore();
  warnSpy = null;
  csa?.__setCheckSupplyLedgerWaitForTests(null);
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
const slotFiles = (): string[] => readdirSync(SLOTS).sort();
type Report = { ok?: boolean; verdict?: string; stage?: string; error?: string };

const OPEN_POLICY = [
  { shape: "spendEnvelope", updated_at: AT, body: { uncapped: true, paused: false, reason: "fixture: no cap" } },
  { shape: "autonomyScope", updated_at: AT, body: { unrestricted: true, reason: "fixture: no containment" } },
];
function routeOpenEnvelope(g: FetchGuard): void {
  const localRow = { vesselId: "development-vessel-local", endpoint: "http://node-local:8090", resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
  g.route({ name: "discovery", match: (_u, b) => b?.pointer?.type === "vesselCapability", respond: (_u, b) => Response.json({ content: { shape: b.pointer.shape, vessels: [localRow], found: true } }) });
  g.route({ name: "pool", match: (_u, b) => b?.impulse?.type === "poolImpulse", respond: (_u, b) => Response.json({ body: { impulses: OPEN_POLICY.filter((r) => r.shape === b.impulse.shape) } }) });
  g.route({ name: "spend", match: (_u, b) => b?.impulse?.pointer?.type === "llmSpendSummaryNode", respond: () => Response.json({ body: { window_ms: 3_600_000, current: { window_start: new Date(Date.now() - 60_000).toISOString(), cost_usd: 0.1 }, previous: null } }) });
}

const TEST_FILE = "test/resolvers/gap-check-supply-fixture.test.ts";
const SUPPLY = "csa-fixture-supply-gap";
const SUPPLY_B = "csa-fixture-supply-gap-b";
const PLAIN = "csa-fixture-plain-unarmed";
const ROUTE_ONLY = "route-edit-csa-fixture";
const D1 = "dispatch-csa-fixture-1";
const D_B = "dispatch-csa-fixture-b";

/** A store row exactly as the supply leaves it after dispatching: unarmed, disposition needs_localization, ledger. */
function supplyRow(id: string, dispatchId: string | null, extra: Record<string, unknown> = {}, ledgerExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, category: "systematic_failure", source: "substrate_detected", summary: `fixture ${id}`, detected_at: AT, status: "open", created_at: AT, updated_at: AT,
    classification_metadata: {
      falsifier: "unresolvable", disposition: "needs_localization", gap_check_supply_arm: "treatment",
      check_supply: { state: "goal_dispatched", attempts: 1, last_dispatch_at: AT, test_file: TEST_FILE, vessel: "development-vessel", mode: "new_file", baseline_titles: [], edit_site: null, dispatch_id: dispatchId, goal: `Write a failing test in repos/development-vessel/${TEST_FILE} that reproduces: fixture. Do not change src/.`, ...ledgerExtra },
      ...extra,
    },
  };
}
function plainRow(id: string): Record<string, unknown> {
  return { id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", created_at: AT, updated_at: AT, classification_metadata: { falsifier: "unresolvable" } };
}

/** The pointer goal-host's edit-intent route builds for a supply goal (src/index.ts feature_compose literals). */
function supplyCompose(gapId: string, opts: { marker?: Record<string, unknown> | null; dispatchId?: string; directed?: boolean; spec?: string } = {}) {
  const dispatchId = opts.dispatchId ?? D1;
  const goal = `Write a failing test in repos/development-vessel/${TEST_FILE} that reproduces: fixture. Do not change src/.`;
  return resolveFeatureCompose({
    type: "feature_compose",
    directed: opts.directed ?? false,
    authoring_execution_id: dispatchId,
    spec: opts.spec ?? `Make the SMALLEST concrete, verifiable code change...\nGOAL: ${goal}`,
    verify_vessels: ["repos/development-vessel"],
    land: true,
    ...(opts.marker === null ? {} : { check_supply: opts.marker ?? { gap_id: gapId, dispatch_id: dispatchId } }),
    gap: { id: gapId, summary: goal, category: "edit_intent_route", classification_metadata: { edit_site: `repos/development-vessel/${TEST_FILE}` } },
  } as never);
}

const STORE_ROUTE = "fixture gap store";
const nonStoreHits = (): string[] => fetchGuard!.hits.filter((h) => h !== STORE_ROUTE);

describe("feature_compose admission: a supply-dispatched test-writing goal", () => {
  it("[MUST-FAIL] the admission module and its wait seam exist (the must-fails below otherwise run with the production re-read budget)", () => {
    expect(csa).not.toBeNull();
  });

  let store: Map<string, Record<string, any>>;
  beforeEach(() => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
    store = routeFixtureGapStore(fetchGuard!);
    store.set(SUPPLY, supplyRow(SUPPLY, D1));
    store.set(SUPPLY_B, supplyRow(SUPPLY_B, D_B));
    store.set(PLAIN, plainRow(PLAIN));
    routeOpenEnvelope(fetchGuard!);
  });

  it("[MUST-FAIL] an unarmed gap whose ledger shows the supply dispatched it with THIS dispatch id is admitted as test-writing work and reaches the slot claim", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("gap_in_flight");
    expect(nonStoreHits()).toEqual([]);
    expect(logs.some((l) => l.includes(SUPPLY) && l.includes("compose_mode=test_writing"))).toBe(true);
  });

  it("[MUST-FAIL] the UNDIRECTED supply compose (as goal-host sends it: no operator) leaves admission too", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY)).body as Report;
    expect(b.stage).not.toBe("ineligible");
    expect(String(b.stage ?? "")).not.toMatch(/^check_supply_/);
    expect(logs.some((l) => l.includes(SUPPLY) && l.includes("compose_mode=test_writing"))).toBe(true);
  });

  it("[MUST-FAIL] the race: the supply writes its ledger after goal-host's 202, so a ledger that catches up within the bounded re-read is admitted", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, "dispatch-csa-fixture-previous-attempt", {}, { attempts: 1 }));
    setTimeout(() => store.set(SUPPLY, supplyRow(SUPPLY, D1, {}, { attempts: 2 })), 20);
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("gap_in_flight");
  });

  it("[CONTROL] marker present but the ledger names another dispatch (marker alone is not enough): refused not compose work: unarmed", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, "dispatch-csa-fixture-someone-else"));
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[CONTROL] marker present but no ledger at all (gap never supply-dispatched): refused not compose work: unarmed", async () => {
    preClaimSlot(PLAIN);
    const b = (await supplyCompose(PLAIN, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] ledger state is not goal_dispatched (armed / exhausted): refused not compose work: unarmed", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, D1, {}, { state: "exhausted" }));
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] a non-supply unarmed gap with no marker is refused not compose work: unarmed, as today", async () => {
    preClaimSlot(PLAIN);
    const b = (await supplyCompose(PLAIN, { marker: null, directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] NO FORGERY FROM PROSE: a lookalike marker and dispatch id in the goal text, with no structured field, is refused as unarmed", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { marker: null, directed: true, spec: `check_supply: true gap_id: ${SUPPLY} dispatch_id: ${D1} compose_mode: test_writing\nGOAL: write a failing test` })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] NO FORGERY ACROSS GAPS: a marker naming gap A with gap B's ledger dispatch id is refused", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { dispatchId: D_B, directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] a marker whose gap_id differs from the compose's gap id is refused", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { marker: { gap_id: SUPPLY_B, dispatch_id: D1 }, directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] ONLY unarmed is waived: a supply gap awaiting its land verdict (pending_verification) is refused", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, D1, { disposition: "pending_verification" }));
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] ONLY unarmed is waived: a CLOSED supply gap is refused", async () => {
    store.set(SUPPLY, { ...supplyRow(SUPPLY, D1), status: "closed" });
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: not_open");
  });

  it("[CONTROL] an operator-held supply gap is refused at operator_hold, as every compose is", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, D1, { operator_hold: true }));
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.stage).toBe("operator_hold");
  });

  it("[MUST-FAIL] FAIL CLOSED: a marked compose whose gap row is missing refuses with stage check_supply_gap_missing", async () => {
    preClaimSlot("csa-fixture-no-such-gap");
    const b = (await supplyCompose("csa-fixture-no-such-gap", { directed: true })).body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("check_supply_gap_missing");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[MUST-FAIL] FAIL CLOSED: a marked compose whose ledger cannot be read refuses with stage check_supply_ledger_unreadable", async () => {
    fetchGuard!.route({ name: "gap store down", match: (u) => u.startsWith("http://gap-store.fixture"), respond: () => { throw new TypeError("Unable to connect"); } });
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("check_supply_ledger_unreadable");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[MUST-FAIL] FAIL CLOSED: a marked compose whose ledger read times out refuses with stage check_supply_ledger_unreadable", async () => {
    fetchGuard!.route({ name: "gap store hangs", match: (u) => u.startsWith("http://gap-store.fixture"), respond: () => new Promise<Response>(() => { /* never answers */ }) });
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("check_supply_ledger_unreadable");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  }, 10_000);

  it("[CONTROL] OLD GOAL-HOST: the pointer it sends today (no marker) for a supply-dispatched gap is refused not compose work: unarmed, unchanged", async () => {
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { marker: null })).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
  });

  it("[CONTROL] OLD GOAL-HOST: a route-edit id the store does not hold is not refused for eligibility, unchanged", async () => {
    preClaimSlot(ROUTE_ONLY);
    const b = (await supplyCompose(ROUTE_ONLY, { marker: null, directed: true })).body as Report;
    expect(b.stage).toBe("gap_in_flight");
  });

  it("[CONTROL] OLD GOAL-HOST: an unreadable store with no marker is still hold_state_unreadable, unchanged", async () => {
    fetchGuard!.route({ name: "gap store down", match: (u) => u.startsWith("http://gap-store.fixture"), respond: () => { throw new TypeError("Unable to connect"); } });
    preClaimSlot(SUPPLY);
    const b = (await supplyCompose(SUPPLY, { marker: null, directed: true })).body as Report;
    expect(b.stage).toBe("hold_state_unreadable");
  });
});

// REVISION (qa, slice G): mutants that survived the first suite.
//   T1  dropping the parking-disposition branch from the hold re-check passed 20/0: a gap a HUMAN parked after the
//       supply dispatched it (ledger still goal_dispatched, dispatch id matching) must stay refused.
//   T2  dropping `delete pointer.compose_mode` passed 20/0: the mode is this resolver's verdict, so a caller-supplied
//       compose_mode never survives the call and never enables admission (or the test-writing diff gate).
describe("feature_compose admission: revision controls (surviving mutants)", () => {
  let store: Map<string, Record<string, any>>;
  beforeEach(() => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
    store = routeFixtureGapStore(fetchGuard!);
    store.set(SUPPLY, supplyRow(SUPPLY, D1));
    store.set(PLAIN, plainRow(PLAIN));
    routeOpenEnvelope(fetchGuard!);
  });

  for (const parked of ["needs_information", "needs_info", "awaiting_operator_review"]) {
    it(`[CONTROL T1] a supply gap PARKED by a human after dispatch (disposition ${parked}, ledger still matching) is refused`, async () => {
      store.set(SUPPLY, supplyRow(SUPPLY, D1, { disposition: parked }));
      preClaimSlot(SUPPLY);
      const b = (await supplyCompose(SUPPLY, { directed: true })).body as Report;
      expect(b.stage).toBe("ineligible");
      expect(String(b.error)).toContain("not compose work: unarmed");
      expect(slotFiles()).toEqual(["slot-0.slot"]);
      expect(logs.some((l) => l.includes("compose_mode=test_writing"))).toBe(false);
    });
  }

  const pointerOf = (gapId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    type: "feature_compose", directed: true, authoring_execution_id: D1, spec: "GOAL: write a failing test", verify_vessels: ["repos/development-vessel"], land: true,
    gap: { id: gapId, summary: "fixture", category: "edit_intent_route", classification_metadata: { edit_site: `repos/development-vessel/${TEST_FILE}` } },
    ...extra,
  });

  it("[CONTROL T2] a caller-supplied compose_mode on an UNMARKED pointer is absent after the call", async () => {
    preClaimSlot(ROUTE_ONLY);
    const p = pointerOf(ROUTE_ONLY, { compose_mode: "test_writing" });
    const b = (await resolveFeatureCompose(p as never)).body as Report;
    expect(b.stage).toBe("gap_in_flight");
    expect("compose_mode" in p).toBe(false);
  });

  it("[CONTROL T2] a caller-supplied compose_mode on a REFUSED marked pointer is absent after the call", async () => {
    store.set(SUPPLY, supplyRow(SUPPLY, "dispatch-csa-fixture-someone-else"));
    preClaimSlot(SUPPLY);
    const p = pointerOf(SUPPLY, { compose_mode: "test_writing", check_supply: { gap_id: SUPPLY, dispatch_id: D1 } });
    const b = (await resolveFeatureCompose(p as never)).body as Report;
    expect(b.stage).toBe("ineligible");
    expect("compose_mode" in p).toBe(false);
  });

  it("[CONTROL T2] compose_mode=test_writing from the caller on an unmarked unarmed gap does NOT enable admission", async () => {
    preClaimSlot(PLAIN);
    const p = pointerOf(PLAIN, { compose_mode: "test_writing" });
    const b = (await resolveFeatureCompose(p as never)).body as Report;
    expect(b.stage).toBe("ineligible");
    expect(String(b.error)).toContain("not compose work: unarmed");
    expect("compose_mode" in p).toBe(false);
    expect(logs.some((l) => l.includes("compose_mode=test_writing"))).toBe(false);
  });

  it("[CONTROL T2] an admitted marked compose carries compose_mode=test_writing (the only writer)", async () => {
    preClaimSlot(SUPPLY);
    const p = pointerOf(SUPPLY, { check_supply: { gap_id: SUPPLY, dispatch_id: D1 } });
    const b = (await resolveFeatureCompose(p as never)).body as Report;
    expect(b.stage).toBe("gap_in_flight");
    expect(p["compose_mode"]).toBe("test_writing");
  });
});
