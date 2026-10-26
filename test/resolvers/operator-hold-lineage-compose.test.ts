// A HOLD COVERS ITS LINEAGE, AT COMPOSE ADMISSION (10-26).
//
// The compose reads the STORED row by id and refuses it when it is held (operator-hold-contains.test.ts). A held
// gap's recommit child was nonetheless admitted on node 1 ([fc-admission] decision admitted, operator_hold false)
// because only the child's own row was read. Pinned here: feature_compose reads the child's ancestors by id
// (lineage keys and the recommit- id chain) and refuses at stage operator_hold, before the slot claim, when one is
// held, or when one cannot be read (a hold fails closed). An unheld lineage's child and a gap unrelated to the
// held one pass the hold check and stop at the pre-claimed slot (stage gap_in_flight), as today.
//
// SEAMS (as operator-hold-contains.test.ts): the stored rows come from the GAP_STORE_ENDPOINT in-memory fixture,
// fetch / fs / exec are guarded, and a pre-claimed compose slot for the same gap id stops a compose that gets past
// the hold check before any workspace, LLM or edit.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCutoverFetchGuard, restoreCutoverFetch, routeFixtureGapStore, FIXTURE_GAP_STORE, type FetchGuard } from "./cutover-fetch-guard.js";
import { installCutoverFsGuard, restoreCutoverFsModules, type FsGuard } from "./cutover-fs-guard.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `operator-hold-lineage-compose-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(ROOT, "gaps"), { recursive: true });
const SAVED_WR = process.env["WORKSPACE_ROOT"];
process.env["WORKSPACE_ROOT"] = ROOT; // as operator-hold-contains.test.ts: no node key file under this root
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
await isolateRuntimeRoot("operator-hold-lineage-compose", { who: "operator-hold-lineage-compose.test.ts" });
const { resolveFeatureCompose } = await import("../../src/resolvers/feature-compose.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
if (SAVED_WR === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = SAVED_WR;

const SLOTS = join(ROOT, "compose-slots");
const AT = "2026-10-26T13:00:00Z";
const SITE = "repos/goal-host-vessel/src/index.ts";
/** Armed (class2 + an edit site): compose admission refuses an unarmed store gap, so an unheld row is compose work. */
function row(id: string, meta: Record<string, unknown>): Record<string, unknown> {
  return { id, category: "systematic_failure", source: "operator_narration", summary: `fixture ${id}`, detected_at: AT, status: "open", classification_metadata: { falsifier: "class2", edit_site: SITE, ...meta }, created_at: AT, updated_at: AT };
}
const H = "lineage-fixture-held-root";
const C = `recommit-${H}-compose_execution_failure`;
const GC = `recommit-${C}-verify_failed`;
const R = "lineage-fixture-free-root";
const RC = `recommit-${R}-verify_failed`;
const U = "lineage-fixture-unrelated";
const HOLD = { operator_hold: true, operator_hold_reason: "fixture: the intent contradicts a ruling" };

let fetchGuard: FetchGuard | null = null;
let fsGuard: FsGuard | null = null;
let execGuard: ExecGuard | null = null;
let savedEndpoint: string | undefined;
let savedSlotDir: string | undefined;
let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;
let warnSpy: ReturnType<typeof spyOn> | null = null;
let store: Map<string, Record<string, any>>;
// A compose past the hold check names its node (self-fact-reconcile thisNode); a set name keeps that off the node key
// file, which the test preload refuses to read.
let savedName: string | undefined;

beforeEach(() => {
  savedEndpoint = process.env["GAP_STORE_ENDPOINT"];
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE;
  savedSlotDir = process.env["COMPOSE_SLOT_DIR"];
  process.env["COMPOSE_SLOT_DIR"] = SLOTS;
  savedName = process.env["SUBSTRATE_NAME"];
  process.env["SUBSTRATE_NAME"] = "hold-lineage-fixture-node";
  rmSync(SLOTS, { recursive: true, force: true });
  __resetPolicyReadsForTests();
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  fetchGuard = installCutoverFetchGuard();
  fsGuard = installCutoverFsGuard();
  execGuard = installCutoverExecGuard();
  store = routeFixtureGapStore(fetchGuard);
  store.set(H, row(H, { ...HOLD }));
  store.set(C, row(C, { re_commit: true, source_gap_id: H, root_gap_id: H }));
  store.set(GC, row(GC, { re_commit: true, source_gap_id: C, root_gap_id: H }));
  store.set(R, row(R, {}));
  store.set(RC, row(RC, { re_commit: true, source_gap_id: R, root_gap_id: R }));
  store.set(U, row(U, {}));
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
  if (savedEndpoint === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedEndpoint;
  if (savedSlotDir === undefined) delete process.env["COMPOSE_SLOT_DIR"]; else process.env["COMPOSE_SLOT_DIR"] = savedSlotDir;
  if (savedName === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = savedName;
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
async function compose(id: string): Promise<Report> {
  preClaimSlot(id);
  const r = await resolveFeatureCompose({ type: "feature_compose", spec: `fixture ${id}`, directed: true, gap: { id } } as never);
  return r.body as Report;
}

describe("operator_hold covers its lineage: feature_compose admission", () => {
  it("[MUST-FAIL MF2] an EXISTING unheld recommit child of a held root is refused at stage operator_hold before the slot claim, and the held ancestor is named", async () => {
    const b = await compose(C);
    expect(b.ok).toBe(false);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
    expect(logs.some((l) => l.includes(C) && l.includes(`lineage ancestor ${H}`))).toBe(true);
  });

  it("[MUST-FAIL MF3] a grandchild (recommit-recommit-...) of a held root is refused at stage operator_hold", async () => {
    const b = await compose(GC);
    expect(b.stage).toBe("operator_hold");
    expect(slotFiles()).toEqual(["slot-0.slot"]);
  });

  it("[MUST-FAIL MF3] a grandchild whose intermediate row is gone is still refused (the id chain reaches the held root)", async () => {
    store.delete(C);
    store.set(GC, row(GC, { re_commit: true, source_gap_id: C })); // no root_gap_id: only the id chain names the root
    const b = await compose(GC);
    expect(b.stage).toBe("operator_hold");
  });

  it("[MUST-FAIL] an ancestor that cannot be read counts as held (fail closed)", async () => {
    fetchGuard!.route({ name: "ancestor read down", match: (u, b) => u.startsWith("http://gap-store.fixture") && b?.impulse?.pointer?.id === H, respond: () => { throw new TypeError("Unable to connect"); } });
    const b = await compose(C);
    expect(b.stage).toBe("operator_hold");
    expect(logs.some((l) => l.includes(C) && l.includes("could not be read"))).toBe(true);
  });

  it("[CONTROL] an unheld lineage's recommit child passes the hold check and stops at the slot claim (gap_in_flight)", async () => {
    const b = await compose(RC);
    expect(b.stage).toBe("gap_in_flight");
  });

  it("[CONTROL] a gap unrelated to the held one is unaffected (gap_in_flight)", async () => {
    const b = await compose(U);
    expect(b.stage).toBe("gap_in_flight");
  });
});
