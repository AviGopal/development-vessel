// A DRAIN THAT ABANDONS AN IN-FLIGHT COMPOSE GIVES BACK THAT COMPOSE'S LANDING LEASE (2026-10-30).
//
// A restart drained the vessel while a compose held a gap's landing lease. The drain exits the process, so the
// compose's exit (releaseOrKeepLandingLease in its finally) never ran and the lease stayed on the row until its TTL.
// The restarted process is a new attempt, so this node's own acquire was refused held_by_prior_attempt and the armed
// gap idled about 90 min. The drain (index.ts) now releases, best-effort and bounded, the leases of the composes still
// running in its process, through the compose exit's own release (releaseAbandonedLandingLeases).
// CONTRACT pinned here (the fixture store behind GAP_STORE_ENDPOINT decides leases with the holder's own rule):
//   - a compose in flight (held at its slot claim) holds the lease; the drain's release clears it, and this node's
//     next acquire as a new attempt is granted (the must-fail);
//   - CONTROL: with no compose in flight the release touches nothing, a lease left by an earlier process included;
//   - CONTROL: a lease another node holds on another gap is untouched.
// Harness: compose-landing-lease-admission.test.ts's (fixture store, fetch/fs/exec guards).
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const ROOT = join(tmpdir(), `drain-landing-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
await isolateRuntimeRoot("drain-releases-abandoned-landing-lease", { who: "drain-releases-abandoned-landing-lease.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.js");
const sg = await import("../../src/resolvers/substrate-gap.js");
const { __setComposeCapacityReaderForTests } = await import("../../src/compose-slots.js");
const { thisNode } = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveFeatureCompose } = fc;
const releaseAbandoned = (fc as unknown as { releaseAbandonedLandingLeases?: () => Promise<number> }).releaseAbandonedLandingLeases;

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-30T10:00:00Z";
const EDIT = "repos/activity-api/src/lib/successor-features.ts";
const GAP = "drain-lease-fixture-armed";
const GAP_B = "drain-lease-fixture-other-node";
const OTHER = "node-other";
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

const row = (id: string, meta: Record<string, unknown>) => ({ id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", classification_metadata: { falsifier: "class2", edit_site: EDIT, ...meta }, created_at: AT, updated_at: AT });
const composeGap = { id: GAP, summary: `fixture ${GAP}`, category: "systematic_failure", status: "open", classification_metadata: { edit_site: EDIT } };
const compose = () => resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${GAP}`, gap: composeGap, directed: true } as never);

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];
let store: Map<string, Record<string, any>>;

beforeEach(() => {
  __setComposeCapacityReaderForTests(async () => null);
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  savedSlotDir = process.env["COMPOSE_SLOT_DIR"];
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  rmSync(SLOTS, { recursive: true, force: true });
  logs = [];
  spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")].map((s) => s.mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  store = routeFixtureGapStore(fetchGuard);
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
  __setComposeCapacityReaderForTests(null);
  restoreCutoverFetch();
  restoreCutoverFsModules();
  restoreCutoverExecModules();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const leaseOn = (id: string) => (store.get(id)?.["classification_metadata"] as Record<string, any> | undefined)?.["landing_lease"];
const leaseAs = async (action: string, holder: string, attempt: string, id = GAP) => (await sg.resolveSubstrateGapLease({ type: "substrateGapLease_write", action, gap_id: id, holder, attempt })).body as { granted?: boolean; held_by?: string; released?: boolean; reason?: string };
const releaseLines = () => logs.filter((l) => l.includes("[feature-compose] landing lease released="));

/** A compose that took its lease and is held at its slot claim (the shaped capacity read waits on `open`). Opening it
 *  answers a cap of 0, so the compose then ends BUSY at the slot without drafting. */
async function composeInFlight(): Promise<{ open: () => void; done: Promise<unknown> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let entered = false;
  __setComposeCapacityReaderForTests(async () => { entered = true; await gate; return { max_concurrent: 0, reserved_for_armed: 0 } as never; });
  const done = compose();
  for (let i = 0; i < 500 && !entered; i++) await new Promise((r) => setTimeout(r, 10));
  expect(entered).toBe(true);
  return { open, done };
}

describe("a drain that abandons an in-flight compose releases that compose's landing lease", () => {
  it("[MUST-FAIL] a drained in-flight compose's lease is released, so this node's next acquire (a new attempt) is granted", async () => {
    store.set(GAP, row(GAP, {}));
    const run = await composeInFlight();
    expect(leaseOn(GAP)?.holder).toBe(thisNode());
    // What the restarted process met: its own new attempt refused while the dead attempt's lease is live.
    expect((await leaseAs("acquire", thisNode(), "restarted-attempt")).reason).toBe("held_by_prior_attempt");
    expect(typeof releaseAbandoned).toBe("function");
    expect(await releaseAbandoned!()).toBe(1);
    expect(leaseOn(GAP)).toBeUndefined();
    expect((await leaseAs("acquire", thisNode(), "restarted-attempt")).granted).toBe(true);
    expect((await leaseAs("release", thisNode(), "restarted-attempt")).released).toBe(true);
    run.open();
    await run.done;
  });

  it("[CONTROL] with no compose in flight the drain releases nothing (a lease left by an earlier process stays)", async () => {
    store.set(GAP, row(GAP, { landing_lease: { holder: thisNode(), attempt: "earlier-process", acquired_at: AT, until: FUTURE() } }));
    expect(typeof releaseAbandoned).toBe("function");
    expect(await releaseAbandoned!()).toBe(0);
    expect(leaseOn(GAP)?.attempt).toBe("earlier-process");
    expect(releaseLines()).toEqual([]);
  });

  it("[CONTROL] a lease ANOTHER node holds is untouched by the drain's release", async () => {
    store.set(GAP, row(GAP, {}));
    store.set(GAP_B, row(GAP_B, { landing_lease: { holder: OTHER, attempt: "x", acquired_at: AT, until: FUTURE() } }));
    const run = await composeInFlight();
    expect(typeof releaseAbandoned).toBe("function");
    expect(await releaseAbandoned!()).toBe(1);
    expect(leaseOn(GAP)).toBeUndefined();
    expect(leaseOn(GAP_B)?.holder).toBe(OTHER);
    expect((await leaseAs("acquire", thisNode(), "t", GAP_B)).held_by).toBe(OTHER);
    run.open();
    await run.done;
  });
});
