// gap-check-supply step 3 CANDIDATE ORDER, read from the family rhythm's own body (candidate_order).
// Today's order is: due retry > fewer attempts > has an edit site > has a stated falsifier_spec > oldest. A steady
// inflow of operator retries ranks ahead of every never-attempted row the system filed itself, so the system's own
// writable rows wait behind them. With candidate_order = "eligible_never_attempted_first" the comparator first ranks a
// band (never attempted, source substrate_detected, an edit site in the clone) and keeps today's order within each band.
// Absent, or any other value, the order is today's, exactly.
//   (a) MUST-FAIL: with the key set, the order over the corpus is band-first; a never-attempted, system-filed, sited row
//       outranks a due-retry operator row.
//   (b) GOLDEN: with the key absent, the order over the same corpus is IDENTICAL to the base comparator's. The expected
//       array was captured by running this file at the base commit (1ba9b19d), not derived from the change.
//   CONTROL: an unrecognised value orders as (b).
// THE CORPUS REACHES THE COMPARATOR WHOLE: every row is asserted a supply candidate with its vessel resolved, its age as
// intended, and every row dispatched (dry run, max_per_tick above the corpus size) with none skipped or localized, so an
// order is never compared over a silently dropped subset.
// Harness: as gap-check-supply-order.test.ts (temp gap store, temp clones, stubbed fetch).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { installCutoverExecGuard, restoreCutoverExecModules, type ExecGuard } from "./cutover-exec-guard.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-cand-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const RUNTIME = join(ROOT, "runtime");
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "local-tools-vessel";
const EDIT = `repos/${VESSEL}/src/widget.ts`;
// A file the summary names that is NOT in the clone: a detector row that names a file is not born unarmable, and has no site.
const ABSENT = `repos/${VESSEL}/src/absent-widget.ts`;
const NOW = Date.now();
const DAYS_AGO = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();
const SPEC = "must-fail: widget() === 2 at HEAD is false; control: widget is exported";

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let rhythms: Row[] = [];
let logs: string[] = [];
let execGuard: ExecGuard | null = null;
let gapStore: { restore: () => Promise<void> } | null = null;

const dueRhythm = (extra: Row = {}): Row => ({
  id: `rhythm-gap-check-supply-${RUN}`, shape: "timeShapedRhythm", updated_at: new Date(NOW).toISOString(),
  body: { axis: "load", family: "gap-check-supply", budget: 0.2, alpha: 3, beta: 1, staleness: 1, max_per_tick: 50, backoff_hours: 24, max_attempts: 3, ...extra },
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
    if (url.endsWith("/run-goal")) return Response.json({ dispatchId: `d-${RUN}` }, { status: 202 });
    if (imp?.type === "poolImpulse" && imp?.shape === "timeShapedRhythm") return Response.json({ body: { impulses: rhythms, count: rhythms.length } });
    if (imp?.type === "poolImpulse" && imp?.shape === "autonomyScope") return Response.json({ body: { impulses: [{ id: "autonomy-scope", shape: "autonomyScope", body: { excluded_paths: ["repos/some-other-vessel/"], require_falsifier_classes: ["class2"] } }], count: 1 } });
    if (imp?.type === "poolImpulse" && imp?.shape === "rhythmFamilyGoal") return Response.json({ body: { impulses: [], count: 0 } });
    if (imp?.type === "poolImpulse_write") return Response.json({ body: { ok: true } });
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    if ((body?.pointer ?? imp?.pointer)?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = () => {};
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); restoreCutoverExecModules(); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { logs = []; rhythms = [dueRhythm()]; execGuard = installCutoverExecGuard(); g2fPolicy.__resetPolicyReadsForTests(); });
afterEach(() => { expect(execGuard?.restore() ?? []).toEqual([]); });

function T(prefix: string): string {
  for (let i = 0; i < 1000; i++) { const id = `${prefix}-${RUN}-${i}`; if (supply.checkSupplyArm(id) === "treatment") return id; }
  throw new Error("no treatment id");
}
async function closeAllOpen(): Promise<void> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  for (const g of ((r.body as { gaps?: Row[] }).gaps ?? [])) {
    if (String(g["status"] ?? "open") !== "open") continue;
    const meta = { ...((g["classification_metadata"] ?? {}) as Row), closed_reason: "fixture isolation", closed_by: "gap-check-supply-candidate-order.test.ts" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...g, status: "closed", classification_metadata: meta } } as never);
  }
  await sg.__settleBirthEvaluationsForTests();
}
async function storeRow(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`seeded gap ${id} not in the store`);
  return row;
}

type Spec = { key: string; source: "operator" | "substrate_detected"; ledger?: Row; sited: boolean; spec: boolean; detected: string };
// THE CORPUS: due retries (failed, and a non-attempt past its wait), attempts 0 and 1, sited and unsited, with and
// without a stated falsifier, both sources, every age distinct (no pair falls to an insertion-order tie).
const CORPUS: Spec[] = [
  { key: "opRetry", source: "operator", ledger: { state: "dispatch_failed", attempts: 1, last_dispatch_at: DAYS_AGO(3) }, sited: true, spec: true, detected: "2026-09-05T00:00:00Z" },
  { key: "sysRetry", source: "substrate_detected", ledger: { state: "dispatch_failed", attempts: 1, last_dispatch_at: DAYS_AGO(3) }, sited: false, spec: false, detected: "2026-09-03T00:00:00Z" },
  { key: "sysNonAttemptSited", source: "substrate_detected", ledger: { state: "non_attempt", attempts: 0, not_before: DAYS_AGO(1) }, sited: true, spec: false, detected: "2026-09-25T00:00:00Z" },
  { key: "sysFreshSited", source: "substrate_detected", sited: true, spec: false, detected: "2026-10-10T00:00:00Z" },
  { key: "sysFreshSitedSpec", source: "substrate_detected", sited: true, spec: true, detected: "2026-10-01T00:00:00Z" },
  { key: "sysFreshUnsited", source: "substrate_detected", sited: false, spec: true, detected: "2026-09-01T00:00:00Z" },
  { key: "sysTriedSited", source: "substrate_detected", ledger: { state: "green_at_head", attempts: 1, last_dispatch_at: DAYS_AGO(3) }, sited: true, spec: true, detected: "2026-09-04T00:00:00Z" },
  { key: "opFreshSited", source: "operator", sited: true, spec: true, detected: "2026-09-10T00:00:00Z" },
  { key: "opFreshSitedNoSpec", source: "operator", sited: true, spec: false, detected: "2026-09-20T00:00:00Z" },
  { key: "opFreshUnsited", source: "operator", sited: false, spec: false, detected: "2026-09-02T00:00:00Z" },
  { key: "opTried", source: "operator", ledger: { state: "green_at_head", attempts: 1, last_dispatch_at: DAYS_AGO(3) }, sited: false, spec: false, detected: "2026-09-06T00:00:00Z" },
];

/** Seed the corpus; returns key -> id, after asserting every row is a candidate of the vessel with the intended site and age. */
async function seedCorpus(): Promise<Map<string, string>> {
  await closeAllOpen();
  const ids = new Map<string, string>();
  for (const c of CORPUS) {
    const id = T(`gcs-cand-${c.key}`);
    ids.set(c.key, id);
    const summary = c.sited
      ? `candidate-order fixture ${RUN} ${c.key}: ${EDIT} widget returns 1; it must return 2`
      : `candidate-order fixture ${RUN} ${c.key}: ${ABSENT} widget returns 1; it must return 2`;
    const meta: Row = { ...(c.sited ? { edit_site: EDIT } : {}), ...(c.spec ? { falsifier_spec: SPEC } : {}), ...(c.ledger ? { check_supply: c.ledger } : {}) };
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: c.source, status: "open", detected_at: c.detected, summary, classification_metadata: meta } } as never);
    if (w.shape === "structuredError") throw new Error(`seed ${c.key} refused: ${JSON.stringify(w.body)}`);
    await sg.__settleBirthEvaluationsForTests();
  }
  for (const c of CORPUS) {
    const row = await storeRow(ids.get(c.key)!);
    expect([c.key, supply.checkSupplyDisposition(row)]).not.toEqual([c.key, null]);
    expect([c.key, supply.checkSupplyVessel(row)]).toEqual([c.key, VESSEL]);
    expect([c.key, Boolean(supply.checkSupplySite(row, VESSEL))]).toEqual([c.key, c.sited]);
    expect([c.key, String(row["source"])]).toEqual([c.key, c.source]);
    expect([c.key, String(row["first_detected_at"] ?? row["detected_at"] ?? "")]).toEqual([c.key, c.detected]);
  }
  return ids;
}
/** One due dry-run pass; the dispatched keys, in the order the comparator ranked them, after asserting the whole corpus reached it. */
async function rankedKeys(ids: Map<string, string>): Promise<string[]> {
  const r = await supply.resolveGapCheckSupplyTick({ type: "gap_check_supply_tick", now_ms: NOW, dry_run: true } as never);
  await sg.__settleBirthEvaluationsForTests();
  const body = r.body as Row;
  const byId = new Map([...ids].map(([k, v]) => [v, k]));
  expect(body["skipped"]).toEqual([]);
  expect(body["localized"]).toEqual([]);
  const keys = ((body["dispatched"] ?? []) as Array<{ id: string }>).map((d) => byId.get(d.id) ?? `foreign:${d.id}`);
  expect([...keys].sort()).toEqual(CORPUS.map((c) => c.key).sort());
  return keys;
}

// TODAY'S ORDER over the corpus, captured from the base comparator (1ba9b19d) by running this file there.
const GOLDEN = ["sysNonAttemptSited", "opRetry", "sysRetry", "opFreshSited", "sysFreshSitedSpec", "opFreshSitedNoSpec", "sysFreshSited", "sysFreshUnsited", "opFreshUnsited", "sysTriedSited", "opTried"];
// BAND FIRST (never attempted, substrate_detected, sited), today's order within each band.
const ELIGIBLE_FIRST = ["sysNonAttemptSited", "sysFreshSitedSpec", "sysFreshSited", "opRetry", "sysRetry", "opFreshSited", "opFreshSitedNoSpec", "sysFreshUnsited", "opFreshUnsited", "sysTriedSited", "opTried"];

describe("gap-check-supply candidate_order, read from the family rhythm", () => {
  it("MUST-FAIL (a): with candidate_order eligible_never_attempted_first, never-attempted system-filed sited rows rank first", async () => {
    rhythms = [dueRhythm({ candidate_order: "eligible_never_attempted_first" })];
    const ids = await seedCorpus();
    const keys = await rankedKeys(ids);
    // the headline: a never-attempted, system-filed, sited row outranks a due-retry operator row
    expect(keys.indexOf("sysFreshSited")).toBeLessThan(keys.indexOf("opRetry"));
    expect(keys).toEqual(ELIGIBLE_FIRST);
    expect(logs.filter((l) => l.includes("[check-supply] candidate_order="))).toEqual(["[check-supply] candidate_order=eligible_never_attempted_first"]);
  });

  it("GOLDEN (b): with candidate_order absent, the order is today's, identical to the base comparator's", async () => {
    const ids = await seedCorpus();
    expect(await rankedKeys(ids)).toEqual(GOLDEN);
  });

  it("CONTROL: an unrecognised candidate_order orders exactly as today", async () => {
    rhythms = [dueRhythm({ candidate_order: "never_attempted_first" })];
    const ids = await seedCorpus();
    expect(await rankedKeys(ids)).toEqual(GOLDEN);
  });
});

// NEWEST FIRST WITHIN THE BAND (USER RULING 2026-10-22 "Newest first within the band (Recommended)"): the same band,
// first, ordered newest first by today's age key; the rows outside the band keep today's order and follow.
const NEWEST_FIRST = ["sysFreshSited", "sysFreshSitedSpec", "sysNonAttemptSited", "opRetry", "sysRetry", "opFreshSited", "opFreshSitedNoSpec", "sysFreshUnsited", "opFreshUnsited", "sysTriedSited", "opTried"];

describe("gap-check-supply candidate_order eligible_never_attempted_newest_first", () => {
  it("MUST-FAIL (a): newest first within the band puts a newer band row ahead of an older band row", async () => {
    rhythms = [dueRhythm({ candidate_order: "eligible_never_attempted_newest_first" })];
    const ids = await seedCorpus();
    const keys = await rankedKeys(ids);
    expect(keys.indexOf("sysFreshSited")).toBeLessThan(keys.indexOf("sysNonAttemptSited"));
    expect(keys).toEqual(NEWEST_FIRST);
    expect(logs.filter((l) => l.includes("[check-supply] candidate_order="))).toEqual(["[check-supply] candidate_order=eligible_never_attempted_newest_first"]);
  });
  it("MUST-FAIL (b): eligible_never_attempted_first keeps its old order, oldest first in the band", async () => {
    rhythms = [dueRhythm({ candidate_order: "eligible_never_attempted_first" })];
    const ids = await seedCorpus();
    const keys = await rankedKeys(ids);
    expect(keys.indexOf("sysNonAttemptSited")).toBeLessThan(keys.indexOf("sysFreshSited"));
    expect(keys).toEqual(ELIGIBLE_FIRST);
  });
  it("MUST-FAIL (c): with candidate_order absent the order is byte-identical to the golden", async () => {
    const ids = await seedCorpus();
    expect(JSON.stringify(await rankedKeys(ids))).toBe(JSON.stringify(GOLDEN));
    expect(logs.filter((l) => l.includes("[check-supply] candidate_order="))).toEqual(["[check-supply] candidate_order=default"]);
  });
});
