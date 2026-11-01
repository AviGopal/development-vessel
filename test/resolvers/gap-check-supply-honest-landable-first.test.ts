// gap-check-supply step 3 CHECK-WRITER TARGETING (user ruling): the test-writing dispatch ("Write ONE failing test …")
// walks its candidates honest-and-landable first, then honest-not-landable, then the rest, each band in today's order.
// The bands are the own-check baseline's (landableBandOf): honest = operator-acts.ts isSystemBornLineage; landable = an
// edit_site the live autonomy scope does not exclude and no parking disposition.
//   MUST-FAIL: candidates A (honest, in-scope edit_site), B (honest, edit_site under an excluded path), C (honest, parked
//       needs_information) and D (not honest, the oldest): the first test-writing dispatch is A. Before, today's order
//       sent D (oldest) first. B is still the scope skip it always was; C is never a supply candidate (parked rows are
//       not, checkSupplyDisposition), so neither is dropped by the order: the dispatched and skipped sets are unchanged.
//   CONTROLS: all candidates honest and landable: today's order, exactly. An unreadable scope promotes nothing: two
//       honest rows keep today's order even when only the younger one has an in-scope edit_site.
//   SEMANTICS PIN: with the scope unreadable, honest rows still go ahead of the rest (the baseline's honest-first order).
// Harness: as gap-check-supply-candidate-order.test.ts (temp gap store, temp clones, stubbed fetch, dry-run passes).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-hl-first-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// The shaped policies directory is this file's own temp checkout (see gap-check-supply-candidate-order.test.ts).
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
const { isSystemBornLineage } = await import("../../src/resolvers/operator-acts.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const EDIT = `repos/${VESSEL}/src/widget.ts`;
const EXCLUDED_DIR = `repos/${VESSEL}/src/excluded/`;
const EXCLUDED_EDIT = `${EXCLUDED_DIR}widget.ts`;
const NOW = Date.now();
const SPEC = "must-fail: widget() === 2 at HEAD is false; control: widget is exported";

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythms: Row[] = [];
let scopeReadable = true;
let scopeReads = 0;
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date(NOW).toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 3 },
});

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  for (const d of [join(CLONES, VESSEL, "src", "excluded"), join(CLONES, VESSEL, "test"), join(RUNTIME, VESSEL, "src", "excluded")]) mkdirSync(d, { recursive: true });
  for (const base of [CLONES, RUNTIME]) {
    writeFileSync(join(base, VESSEL, "src", "widget.ts"), "export const widget = 1;\n");
    writeFileSync(join(base, VESSEL, "src", "excluded", "widget.ts"), "export const widget = 1;\n");
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (/\/executions\/[^/?#]+$/.test(url)) return new Response("not found", { status: 404 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}` }, { status: 202 });
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") {
      scopeReads += 1;
      if (!scopeReadable) return new Response("unavailable", { status: 503 });
      return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: [EXCLUDED_DIR], require_falsifier_classes: ["class2"] } }], count: 1 } });
    }
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
beforeEach(() => { rhythms = [dueRhythm()]; scopeReadable = true; scopeReads = 0; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
async function storeRows(): Promise<Row[]> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? []);
}
async function closeAllOpen(): Promise<void> {
  for (const g of await storeRows()) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-honest-landable-first.test.ts" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}

type Spec = { key: string; honest: boolean; site: string | null; disposition?: string; detected: string; candidate: boolean };
// Every id is <key-prefix>-<run>-<n>, and no key prefix is a "-"-prefix of another, so no row is another's id-rule
// ancestor: honesty is the row's own source alone (asserted per row below).
async function seed(specs: Spec[]): Promise<Map<string, string>> {
  await closeAllOpen();
  const ids = new Map<string, string>();
  for (const c of specs) {
    const id = T(`gcshl${c.key}`);
    ids.set(c.key, id);
    // A row with no edit_site still names an existing file in its summary, so the supply sites it (checkSupplySite).
    const summary = `honest-landable fixture ${RUN} ${c.key}: ${c.site ?? EDIT} widget returns 1; it must return 2`;
    const meta: Row = { ...(c.site ? { edit_site: c.site } : {}), falsifier_spec: SPEC, ...(c.disposition ? { disposition: c.disposition } : {}) };
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: c.honest ? "substrate_detected" : "operator", status: "open", detected_at: c.detected, summary, classification_metadata: meta } } as never);
    if (w.shape === "structuredError") throw new Error(`seed ${c.key} refused: ${JSON.stringify(w.body)}`);
    await sg.__settleBirthEvaluationsForTests();
  }
  const all = await storeRows();
  const byId = new Map(all.map((r) => [String(r["id"]), r]));
  for (const c of specs) {
    const row = byId.get(ids.get(c.key)!);
    if (!row) throw new Error(`seeded gap ${c.key} not in the store`);
    const meta = (row["classification_metadata"] ?? {}) as Row;
    expect([c.key, isSystemBornLineage(row, byId)]).toEqual([c.key, c.honest]);
    expect([c.key, meta["edit_site"] ?? null]).toEqual([c.key, c.site]);
    expect([c.key, String(row["first_detected_at"] ?? row["detected_at"] ?? "")]).toEqual([c.key, c.detected]);
    if (c.disposition) expect([c.key, meta["disposition"]]).toEqual([c.key, c.disposition]);
    expect([c.key, supply.checkSupplyDisposition(row) !== null]).toEqual([c.key, c.candidate]);
    if (c.candidate) {
      expect([c.key, supply.checkSupplyVessel(row)]).toEqual([c.key, VESSEL]);
      expect([c.key, Boolean(supply.checkSupplySite(row, VESSEL))]).toEqual([c.key, true]);
    }
  }
  return ids;
}
/** One due dry-run pass: the dispatched keys in dispatch order, and the skipped keys. */
async function pass(ids: Map<string, string>): Promise<{ dispatched: string[]; skipped: string[] }> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: NOW, dry_run: true } as never);
  await sg.__settleBirthEvaluationsForTests();
  const body = r.body as Row;
  const key = new Map([...ids].map(([k, v]) => [v, k]));
  expect(body["localized"]).toEqual([]);
  return {
    dispatched: ((body["dispatched"] ?? []) as Array<{ id: string }>).map((d) => key.get(d.id) ?? `foreign:${d.id}`),
    skipped: ((body["skipped"] ?? []) as Array<{ id: string }>).map((d) => key.get(d.id) ?? `foreign:${d.id}`),
  };
}

const MIXED: Spec[] = [
  { key: "A", honest: true, site: EDIT, detected: "2026-10-04T00:00:00Z", candidate: true },
  { key: "B", honest: true, site: EXCLUDED_EDIT, detected: "2026-10-02T00:00:00Z", candidate: true },
  { key: "C", honest: true, site: EDIT, disposition: "needs_information", detected: "2026-10-03T00:00:00Z", candidate: false },
  { key: "D", honest: false, site: EDIT, detected: "2026-10-01T00:00:00Z", candidate: true },
];

describe("gap-check-supply test-writing order: honest and landable first", () => {
  it("MUST-FAIL: of A (honest, in scope), B (honest, excluded), C (honest, parked) and D (not honest, oldest), the first test-writing dispatch is A", async () => {
    const ids = await seed(MIXED);
    const out = await pass(ids);
    expect(out.dispatched[0]).toBe("A");
    expect(out.dispatched).toEqual(["A", "D"]);
    // nothing dropped: B is the scope skip it always was, C is no candidate, and the scope was read once this tick
    expect(out.skipped).toEqual(["B"]);
    expect(scopeReads).toBe(1);
  });

  it("CONTROL: when every candidate is honest and landable, the order is today's (oldest first)", async () => {
    const ids = await seed([
      { key: "L3", honest: true, site: EDIT, detected: "2026-10-03T00:00:00Z", candidate: true },
      { key: "L1", honest: true, site: EDIT, detected: "2026-10-01T00:00:00Z", candidate: true },
      { key: "L2", honest: true, site: EDIT, detected: "2026-10-02T00:00:00Z", candidate: true },
    ]);
    expect(await pass(ids)).toEqual({ dispatched: ["L1", "L2", "L3"], skipped: [] });
  });

  it("CONTROL: an unreadable scope promotes nothing: two honest rows keep today's order", async () => {
    scopeReadable = false;
    const ids = await seed([
      { key: "Y", honest: true, site: EDIT, detected: "2026-10-04T00:00:00Z", candidate: true },
      { key: "E", honest: true, site: null, detected: "2026-10-02T00:00:00Z", candidate: true },
    ]);
    expect(await pass(ids)).toEqual({ dispatched: ["E", "Y"], skipped: [] });
  });

  it("SEMANTICS PIN: with the scope unreadable, the honest rows still go ahead of the rest (the baseline's honest-first order)", async () => {
    scopeReadable = false;
    const ids = await seed([
      { key: "Y", honest: true, site: EDIT, detected: "2026-10-04T00:00:00Z", candidate: true },
      { key: "E", honest: true, site: null, detected: "2026-10-02T00:00:00Z", candidate: true },
      { key: "D", honest: false, site: EDIT, detected: "2026-10-01T00:00:00Z", candidate: true },
    ]);
    expect(await pass(ids)).toEqual({ dispatched: ["E", "Y", "D"], skipped: [] });
  });
});
