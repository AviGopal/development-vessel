// FEATURE_COMPOSE TAKES THE GAP'S LANDING LEASE BEFORE IT CLAIMS A SLOT (check-first, 2026-10-08).
//
// Two nodes sharing one gap-store holder composed and landed the same gap 75 s apart (2026-10-07): every
// guard in resolveFeatureCompose (the slot directory's duplicate check, composeInFlight) is node-local.
// CONTRACT pinned here (the store holder is the shared fixture store behind GAP_STORE_ENDPOINT, which
// decides leases with the holder's own rule, substrate-gap.ts decideLandingLease):
//   - a LANDING compose of a store gap whose lease another node holds -> BUSY stage landing_lease_held, no
//     slot claimed, nothing written back to the gap, the refusal logged with the holder and counted;
//   - the lease state not knowable (the holder answers no lease verdict) -> BUSY landing_lease_unknown (abstain);
//   - CONTROL: no lease -> admission proceeds past the lease step (to the pre-claimed slot, gap_in_flight), and
//     a compose refused after the lease was taken releases it;
//   - THE LEASE OUTLIVES THE SLOT WHILE A CUTOVER IS PENDING: A's compose exits (slot released) with its cutover
//     deferred (preserve_pending / cutoverDeferred) -> B is STILL refused; with the cutover's outcome reached
//     (landed / refused) the exit releases it and B is granted.
// Harness: compose-admission.test.ts's (fixture store, fetch/fs/exec guards, a pre-claimed compose slot).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const ROOT = join(tmpdir(), `compose-landing-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
// This file drives feature_compose: give it its own temp runtime root whatever loaded the module first
// (test/helpers/runtime-root.ts); it refuses to run before any write when it cannot.
await isolateRuntimeRoot("compose-landing-lease-admission", { who: "compose-landing-lease-admission.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.js");
const sg = await import("../../src/resolvers/substrate-gap.js");
const { thisNode } = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveFeatureCompose } = fc;

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-07T10:00:00Z";
const EDIT = "repos/activity-api/src/lib/successor-features.ts";
const GAP = "lease-adm-fixture-armed";
const OTHER = "node-other";
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

const row = (meta: Record<string, unknown>) => ({ id: GAP, category: "systematic_failure", source: "operator_narration", summary: `fixture ${GAP}`, detected_at: AT, status: "open", classification_metadata: { falsifier: "class2", edit_site: EDIT, ...meta }, created_at: AT, updated_at: AT });
const composeGap = { id: GAP, summary: `fixture ${GAP}`, category: "systematic_failure", status: "open", classification_metadata: { edit_site: EDIT } };
const compose = () => resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${GAP}`, gap: composeGap, directed: true } as never);
type Report = { ok?: boolean; verdict?: string; stage?: string; error?: string; held_by?: string; landing_lease_refusals?: Record<string, number> };

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];
let store: Map<string, Record<string, any>>;
let gapWrites = 0;

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
  // Count gap writes (a refusal is a non-attempt: it writes nothing back), then let the fixture store answer.
  const fixture = store;
  fetchGuard.route({ name: "gap write counter", match: (u, b) => u.startsWith("http://gap-store.fixture") && b?.impulse?.pointer?.type === "substrateGap_write", respond: (_u, b) => { gapWrites++; const id = String(b.impulse.pointer.gap?.id ?? ""); fixture.set(id, { ...(fixture.get(id) ?? {}), ...b.impulse.pointer.gap }); return Response.json({ shape: "substrateGapWriteResult", body: { id } }); } });
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

/** A compose past admission stops at the pre-claimed slot for the same gap (gap_in_flight), before any draft. */
function preClaimSlot(): void {
  mkdirSync(SLOTS, { recursive: true });
  writeFileSync(join(SLOTS, "slot-0.slot"), JSON.stringify({ pid: process.pid, at: Date.now(), composeId: "pre-claimed", gap_id: GAP }));
}
const slotFiles = (): string[] => (existsSync(SLOTS) ? readdirSync(SLOTS).sort() : []);
const leaseOnRow = () => (store.get(GAP)?.["classification_metadata"] as Record<string, any> | undefined)?.["landing_lease"];
const leaseAs = async (action: string, holder: string) => (await sg.resolveSubstrateGapLease({ type: "substrateGapLease_write", action, gap_id: GAP, holder, attempt: `${holder}-t` })).body as { granted?: boolean; held_by?: string; released?: boolean };

describe("feature_compose admission takes the gap's landing lease at the store holder", () => {
  it("[MUST-FAIL] a landing compose of a store gap whose lease ANOTHER node holds is BUSY landing_lease_held, claims no slot, writes nothing back", async () => {
    store.set(GAP, row({ landing_lease: { holder: OTHER, attempt: "x", acquired_at: AT, until: FUTURE() } }));
    preClaimSlot();
    const b = (await compose()).body as Report;
    expect(b.verdict).toBe("BUSY");
    expect(b.stage).toBe("landing_lease_held");
    expect(b.held_by).toBe(OTHER);
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(gapWrites).toBe(0);
    expect(leaseOnRow()?.holder).toBe(OTHER);
    expect(logs.some((l) => l.includes(GAP) && l.includes("landing_lease_held") && l.includes(OTHER))).toBe(true);
    expect((b.landing_lease_refusals?.["compose_held"] ?? 0)).toBeGreaterThan(0);
  });

  it("[MUST-FAIL] the lease state not knowable (the holder answers no lease verdict) -> BUSY landing_lease_unknown, no slot", async () => {
    store.set(GAP, row({}));
    fetchGuard!.route({ name: "holder without the lease op", match: (_u, b) => b?.impulse?.pointer?.type === "substrateGapLease_write", respond: () => Response.json({ success: false, error: "unknown shape: substrateGapLease_write" }, { status: 400 }) });
    preClaimSlot();
    const b = (await compose()).body as Report;
    expect(b.verdict).toBe("BUSY");
    expect(b.stage).toBe("landing_lease_unknown");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(gapWrites).toBe(0);
  });

  it("[CONTROL] with no lease, admission proceeds past the lease step (to the slot), and the refusal there releases the lease it took", async () => {
    store.set(GAP, row({}));
    preClaimSlot();
    const b = (await compose()).body as Report;
    expect(b.stage).toBe("gap_in_flight");
    expect(leaseOnRow()).toBeUndefined();
    expect((await leaseAs("acquire", OTHER)).granted).toBe(true);
  });

  it("[CONTROL] this node's own unexpired lease does not refuse its compose (idempotent re-acquire)", async () => {
    store.set(GAP, row({ landing_lease: { holder: thisNode(), attempt: "earlier", acquired_at: AT, until: FUTURE() } }));
    preClaimSlot();
    const b = (await compose()).body as Report;
    expect(b.stage).toBe("gap_in_flight");
  });
});

describe("the landing lease outlives the compose slot while its cutover is pending", () => {
  const exit = (l: unknown, o: unknown) => (fc as unknown as { releaseOrKeepLandingLease: (l: unknown, o: unknown) => Promise<void> }).releaseOrKeepLandingLease(l, o);
  const A = () => ({ gapId: GAP, holder: thisNode(), attempt: "a-slot" });
  const report = (result: Record<string, unknown>) => ({ shape: "featureComposeReport", body: { ok: false, verdict: "UNFAVORABLE", cutovers: [{ vessel: "activity-api", result }] } });

  it("[MUST-FAIL] A's compose exits with its cutover DEFERRED (preserve_pending) -> B is still refused, held_by A", async () => {
    store.set(GAP, row({}));
    expect((await leaseAs("acquire", thisNode())).granted).toBe(true);
    await exit(A(), report({ refused: true, refuse_class: "gap_store_unavailable", deferred: true, preserve_pending: true }));
    const b = await leaseAs("acquire", OTHER);
    expect(b.granted).toBe(false);
    expect(b.held_by).toBe(thisNode());
  });

  it("[MUST-FAIL] A's compose exits with cutoverDeferred (change window held) -> B is still refused", async () => {
    store.set(GAP, row({}));
    expect((await leaseAs("acquire", thisNode())).granted).toBe(true);
    await exit(A(), report({ deferred: true, reason: "change_window lease held" }));
    expect((await leaseAs("acquire", OTHER)).granted).toBe(false);
  });

  it("[CONTROL] A's compose exits after its cutover's outcome (landed, or refused) or with nothing staged -> released, B granted", async () => {
    for (const outcome of [report({ push_status: "pushed", new_git_sha: "abc1234" }), report({ refused: true, refuse_class: "own_check_failed" }), { shape: "featureComposeReport", body: { ok: false, verdict: "UNFAVORABLE" } }]) {
      store.set(GAP, row({}));
      expect((await leaseAs("acquire", thisNode())).granted).toBe(true);
      await exit(A(), outcome);
      expect(leaseOnRow()).toBeUndefined();
      expect((await leaseAs("acquire", OTHER)).granted).toBe(true);
      expect((await leaseAs("release", OTHER)).released).toBe(true);
    }
  });
});
