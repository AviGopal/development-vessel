// OPERATOR_HOLD MUST CONTAIN (check-first, 2026-10-03).
//
// Measured while containing a redispatch livelock: classification_metadata.operator_hold === true,
// the gap store's containment field, did not contain. Two leaks:
//
//   (a) The substrateGap READ resolver never looked at operator_hold. The store only refused to
//       CLOSE a held gap (the falsifier_exercise guard in resolveSubstrateGapWrite), so every
//       supplier that lists open gaps still saw held gaps and dispatched them. boredom-vessel's
//       goal generation reads exactly {type:"substrateGap", status:"open", limit:100,
//       sort:"disposition_scored"}.
//   (b) feature_compose checked the hold only inside the `!isDirected && land !== false` block, so a
//       directed:true compose (goal-host's operator/edit-intent route; there is no separate
//       "operator-origin" flag on the pointer, `directed` IS that flag) of a held gap composed.
//
// CONTRACT pinned here:
//   - A held gap is ABSENT from the default open-gap list read (status:"open", no id). By-id reads
//     are unaffected (the compose gate and every by-id caller must still see the row).
//   - SubstrateGapReadPointer gains `include_held?: boolean`; include_held:true lists held gaps too
//     (operator views, and bookkeeping readers such as dedupe and landing verification).
//   - feature_compose refuses a held gap with stage "operator_hold" whether directed or not, BEFORE
//     claiming a slot or any other network call (no LLM, no edit), and logs the refusal.
//   - The hold is decided from the STORED row (read by id), not the pointer, both ways: a pointer
//     that omits the hold ({id} only, stale metadata) is still refused; a pointer that claims a
//     hold the store does not hold is not. An unreadable store fails closed with stage
//     "hold_state_unreadable" (as the cutover defers on gap_store_unavailable).
//   - Unchanged and kept green: closing a held gap still needs falsifier_exercise.passed, and the
//     lane's auto-pick admission (admitActionableGaps) still excludes operator_hold. No green test
//     pinned the latter (gap-drain-backoff.test.ts pins a different, still-open observer defect and
//     needs its own scratch WORKSPACE_ROOT), so the last describe below pins it.
//
// SEAMS. (a) uses a FRESH substrate-gap module instance (query-string import) loaded after
// WORKSPACE_ROOT points at this file's temp root, and asserts gapStoreRootForTest() before any
// write: the shared instance's root is frozen by whichever suite imported it first (the checkout,
// or the LIVE store in a container). The GAP_STORE_ENDPOINT fixture store is NOT used for (a):
// with it set the resolver forwards before its own filter runs, so the test would grade the
// fixture's filter, not the store's. GAP_STORE_ENDPOINT is cleared per test and the fetch guard
// runs with zero routes, so an accidental forward is a recorded violation.
// (b) serves the stored row from the GAP_STORE_ENDPOINT in-memory fixture (see the compose describe)
// and pre-claims a compose slot for the SAME gap id under COMPOSE_SLOT_DIR, so a compose that gets
// past the hold check stops deterministically at the next stage (stage "gap_in_flight") without
// drafting.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";

const ROOT = join(tmpdir(), `operator-hold-contains-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import(`../../src/resolvers/substrate-gap.js?${"operator-hold-isolated"}`);
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

describe("operator_hold contains: the open-gap supply read", () => {
  it("isolation: this suite's gap store is its own temp root, never the checkout or a live store", () => {
    expect(gapStoreRootForTest()).toBe(ROOT);
  });

  it("[MUST-FAIL (a)] the default open-gap read (boredom's pointer) returns the unheld gap and NOT the held one", async () => {
    const r = await resolveSubstrateGap(BOREDOM_OPEN_READ as never);
    expect(r.shape).toBe("substrateGap");
    expect(ids(r)).toContain(UNHELD);
    expect(ids(r)).not.toContain(HELD);
  });

  it("[CONTRACT (a)] include_held:true lists held gaps too (operator view)", async () => {
    const r = await resolveSubstrateGap({ ...BOREDOM_OPEN_READ, include_held: true } as never);
    expect(ids(r).sort()).toEqual([HELD, UNHELD].sort());
  });

  it("[CONTROL (a)] a by-id read still returns a held row (the compose gate and by-id callers are not blinded)", async () => {
    const r = await resolveSubstrateGap({ type: "substrateGap", id: HELD, limit: 1 } as never);
    expect(ids(r)).toEqual([HELD]);
  });

  it("[CONTROL] closing a held gap without an exercised, passed falsifier is still refused, and the row stays open", async () => {
    const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: HELD, category: "systematic_failure", source: "operator_narration", summary: `fixture ${HELD}`, detected_at: AT, status: "closed" } } as never);
    expect(w.shape).toBe("structuredError");
    expect(JSON.stringify(w.body)).toContain("falsifier_exercise.passed");
    const stored = (JSON.parse(readFileSync(STORE, "utf8")) as Array<{ id: string; status: string }>).find((g) => g.id === HELD);
    expect(stored?.status).toBe("open");
  });
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

describe("operator_hold contains: feature_compose", () => {
  let store: Map<string, Record<string, any>>;
  beforeEach(() => {
    process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // the file-level afterEach restores the caller's value
    store = routeFixtureGapStore(fetchGuard!);
    store.set(HELD, row(HELD, { operator_hold: true, operator_hold_reason: "redispatch livelock containment" }));
    store.set(UNHELD, row(UNHELD, {}));
  });

  it("[MUST-FAIL (b)] a DIRECTED compose of a held gap is refused at stage operator_hold, before any slot, network or draft, and the refusal is logged", async () => {
    preClaimSlot(HELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${HELD}`, directed: true, gap: composeGap(HELD, { operator_hold: true }) } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(nonStoreHits()).toEqual([]);
    expect(logs.some((l) => l.includes("operator_hold") && l.includes(HELD))).toBe(true);
  });

  it("[CONTROL (b)] an UNDIRECTED compose of a held gap is refused at stage operator_hold, as today", async () => {
    routeOpenEnvelope(fetchGuard!);
    preClaimSlot(HELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${HELD}`, gap: composeGap(HELD, { operator_hold: true }) } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(logs.some((l) => l.includes("operator_hold") && l.includes(HELD))).toBe(true);
  });

  it("[CONTROL] a DIRECTED compose of an UNHELD gap passes the hold check and reaches the next stage (slot claim)", async () => {
    preClaimSlot(UNHELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${UNHELD}`, directed: true, gap: composeGap(UNHELD, {}) } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("gap_in_flight");
    expect(nonStoreHits()).toEqual([]);
  });

  it("[MUST-FAIL (store)] a DIRECTED compose whose pointer is {id} only, for a gap HELD in the store, is refused at stage operator_hold before the slot claim", async () => {
    preClaimSlot(HELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${HELD}`, directed: true, gap: { id: HELD } } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(nonStoreHits()).toEqual([]);
    expect(logs.some((l) => l.includes("operator_hold") && l.includes(HELD))).toBe(true);
  });

  it("[MUST-FAIL (store)] a DIRECTED compose whose pointer carries STALE metadata without the hold, for a gap HELD in the store, is refused at stage operator_hold", async () => {
    preClaimSlot(HELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${HELD}`, directed: true, gap: composeGap(HELD, { edit_site: "repos/goal-host-vessel/src/index.ts:1" }) } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[CONTROL (store)] a stored-UNHELD gap whose pointer wrongly claims operator_hold:true is NOT refused for a hold (stored truth wins both ways)", async () => {
    preClaimSlot(UNHELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${UNHELD}`, directed: true, gap: composeGap(UNHELD, { operator_hold: true }) } as never);
    const b = r.body as Report;
    expect(b.stage).not.toBe("operator_hold");
    expect(b.stage).toBe("gap_in_flight");
  });

  it("[MUST-FAIL (outage)] when the stored row cannot be read, a DIRECTED compose refuses with stage hold_state_unreadable (fail closed) before the slot claim", async () => {
    fetchGuard!.route({ name: "gap store down", match: (u) => u.startsWith("http://gap-store.fixture"), respond: () => { throw new TypeError("Unable to connect"); } });
    preClaimSlot(UNHELD);
    const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${UNHELD}`, directed: true, gap: composeGap(UNHELD, {}) } as never);
    const b = r.body as Report;
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("hold_state_unreadable");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(logs.some((l) => l.includes("hold_state_unreadable") && l.includes(UNHELD))).toBe(true);
  });
});

// The lane's auto-pick admission already excludes operator_hold (gap-to-feature admitActionableGaps).
// No green test pinned it (gap-drain-backoff.test.ts pins a DIFFERENT, still-open observer defect),
// so it is pinned here as a pair: the held gap is excluded FOR operator_hold, and its unheld twin is
// admitted, which proves the held one got past every earlier filter and was excluded by the hold.
describe("operator_hold contains: the lane's auto-pick admission (kept green)", () => {
  const RUNTIME = join(ROOT, "runtime");
  const saved: Record<string, string | undefined> = {};
  const ENV = { MITOSIS_RUNTIME_DIR: RUNTIME, VESSELS_CLONE_ROOT: join(ROOT, "no-vessel-clones") } as const;
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    saved["MITOSIS_DIRECT_PUSH"] = process.env["MITOSIS_DIRECT_PUSH"];
    delete process.env["MITOSIS_DIRECT_PUSH"];
    mkdirSync(join(RUNTIME, "goal-host-vessel", "src"), { recursive: true });
    writeFileSync(join(RUNTIME, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(RUNTIME, "goal-host-vessel", "package.json"), JSON.stringify({ name: "goal-host-vessel" }));
  });
  afterEach(() => {
    for (const k of [...Object.keys(ENV), "MITOSIS_DIRECT_PUSH"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it("[CONTROL] admission excludes a held gap with reason operator_hold and admits its unheld twin", async () => {
    routeOpenEnvelope(fetchGuard!);
    const twin = (id: string, extra: Record<string, unknown>) => ({ id, category: "systematic_failure", source: "substrate_detected", summary: "fix the thing", status: "open", classification_metadata: { edit_site: "repos/goal-host-vessel/src/index.ts:1", falsifier: "class2", ...extra } }); // armed: admission takes only armed sited gaps
    const { admitted, excluded } = await admitActionableGaps(
      [twin("hold-admission-held", { operator_hold: true }), twin("hold-admission-unheld", {})] as unknown as Record<string, unknown>[],
      { typecheckRunner: () => ({ ran: false, clean: false }) } as never,
    );
    expect(excluded.find((e) => e.id === "hold-admission-held")?.reason).toBe("operator_hold");
    expect(admitted.map((g) => String(g.id))).toEqual(["hold-admission-unheld"]);
  });
});

// A hold survives the writers that re-file the same row, and the counters that report open gaps see
// it. Detectors re-write their findings by stable id on every scan (ui-legibility-scan, the orphaned
// capability emit loop) with a full classification_metadata that knows nothing of the hold; if the
// write path did not carry the hold forward, the next scan would silently lift it. A reporting reader
// (goal_summary) reads with include_held and must count the held gap, separately.
describe("operator_hold contains: re-writes and counters", () => {
  it("[CONTROL] a scanner re-write of a held row (same stable id, through the real substrateGap_write, metadata without the hold) leaves operator_hold true and status open", async () => {
    fetchGuard!.route({ name: "event publish", match: (u) => u.endsWith("/v2/events/publish"), respond: () => Response.json({ ok: true }) });
    // A successful gap write mirrors to the pool under config.ts's WORKSPACE_ROOT, frozen at first
    // import (the checkout in a multi-file run). The fs guard BLOCKS that mkdir (the mirror is
    // non-fatal and after the store write); it is the one expected block here, nothing else is.
    expectedFsBlocks = [/^fs\.mkdirSync .*\/pool$/];
    const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: HELD, category: "systematic_failure", source: "substrate_detected", summary: `fixture ${HELD} (re-observed by a scan)`, detected_at: new Date().toISOString(), status: "open", classification_metadata: { surface: "panel", region: "fixture", kind: "cramped", rule: "chip_density" } } } as never);
    expect(w.shape).toBe("substrateGapWriteResult");
    const stored = (JSON.parse(readFileSync(STORE, "utf8")) as Array<{ id: string; status: string; classification_metadata?: Record<string, unknown> }>).find((g) => g.id === HELD);
    expect(stored?.status).toBe("open");
    expect(stored?.classification_metadata?.["operator_hold"]).toBe(true);
    expect(stored?.classification_metadata?.["rule"]).toBe("chip_density");
    // and the re-written row is still absent from the default supply read
    expect(ids(await resolveSubstrateGap(BOREDOM_OPEN_READ as never))).not.toContain(HELD);
  });

  it("[CONTROL] a counting reader (goal_summary) reads with include_held, counts the held gap, and reports it separately", async () => {
    const { resolveGoalSummary } = await import("../../src/resolvers/goal-summary.js");
    const saved = { a: process.env["ACTIVITY_API_ENDPOINT"], d: process.env["DEV_VESSEL_ENDPOINT"] };
    process.env["ACTIVITY_API_ENDPOINT"] = "http://activity.fixture";
    process.env["DEV_VESSEL_ENDPOINT"] = "http://dev.fixture";
    try {
      fetchGuard!.route({ name: "activity", match: (u) => u.startsWith("http://activity.fixture/"), respond: () => Response.json({ templates: [], edges: [] }) });
      // The dev-vessel resolve is answered by THIS suite's real resolver over its temp store, so the
      // reader's own pointer (include_held or not) is what decides the count.
      fetchGuard!.route({ name: "dev gap read", match: (u) => u.startsWith("http://dev.fixture/"), respond: async (_u, b) => Response.json(await resolveSubstrateGap(b?.impulse?.pointer as never)) });
      const r = await resolveGoalSummary({ type: "goal_summary" });
      const sg = (r.body as { substrate_gaps?: { total_open_gaps?: number; held_open_gaps?: number } }).substrate_gaps;
      expect(sg?.total_open_gaps).toBe(2);
      expect(sg?.held_open_gaps).toBe(1);
    } finally {
      if (saved.a === undefined) delete process.env["ACTIVITY_API_ENDPOINT"]; else process.env["ACTIVITY_API_ENDPOINT"] = saved.a;
      if (saved.d === undefined) delete process.env["DEV_VESSEL_ENDPOINT"]; else process.env["DEV_VESSEL_ENDPOINT"] = saved.d;
    }
  });
});
