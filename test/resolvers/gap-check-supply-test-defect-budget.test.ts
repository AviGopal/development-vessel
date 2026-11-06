// gap-check-supply TEST-DEFECT PASS BUDGET (development-vessel:test-defect-localization-budget, testDefectPass).
// The test-defect pass counted every decision against max_per_tick, so decisions that write nothing (variant-0 of the
// localization, a mixed row) spent the budget on every pass: the same first rows in store order filled it forever and a
// candidate behind them was never decided.
//   (a) MUST-FAIL: under variant-1, with max_per_tick 3 and four candidates whose first three are decided without a
//       write, one pass decides all four and leaves none undecided.
//   (b) MUST-FAIL: under variant-1 writes stay bounded by max_per_tick, and decisions by test_defect_decide_max.
//   (c) MUST-FAIL: variant-1 posts the pass as a trace (output testDefectLocalizationBudget); variant-0 posts none.
//   CONTROL: variant-0 (no mask) decides as before, three of four, and counts the fourth as an undecided candidate.
//   (d) MUST-FAIL (source pin): the tick's due pass runs testDefectPass with the rhythm's max_per_tick.
// The localization's decision is a stub (the decide seam); the rows are built here and never written to a store.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gcs-td-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
const saved = { WORKSPACE_ROOT: process.env["WORKSPACE_ROOT"], VESSELS_CLONE_ROOT: process.env["VESSELS_CLONE_ROOT"] };
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
const supply = await import("../../src/resolvers/gap-check-supply.js");

type Row = Record<string, unknown>;
const NOW = "2099-01-01T00:00:00.000Z";
const VESSEL = "fixture-vessel", TEST_FILE = "test/resolvers/child.test.ts", ONLY = ["child > one via child"];
const candidate = (n: number): Row => ({
  id: `failing-test-fixture-${n}`, status: "open",
  classification_metadata: {
    falsifier: "class2",
    evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: TEST_FILE, only_tests: ONLY } },
    edit_site: `repos/${VESSEL}/src/resolvers/child.ts`,
    own_check_baseline: { verdict: "red_code_reachable", test_file: TEST_FILE, only_tests: ONLY, failing: [{ name: ONLY[0], error: "error: Unterminated string literal" }] },
  },
});
const mask = (variant: number): Row => ({ id: "mask-tdb", body: { activity_id: supply.TEST_DEFECT_BUDGET_ACTIVITY, active_variant: variant, from: "2000-01-01T00:00:00Z", until: "2099-12-31T00:00:00Z", by: "operator:test", reason: "fixture" } });
let masks: Row[] = [];
let traces: Row[] = [];
const origLog = console.log;
let logs: string[] = [];

beforeEach(() => {
  masks = []; traces = []; logs = [];
  supply.__setTestDefectLocalizationDepsForTests({ readMasks: () => masks as never, postTrace: async (t) => { traces.push(t); return 201; } });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  supply.__setTestDefectLocalizationDepsForTests(null);
  console.log = origLog;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

const noWrite = async () => ({ verdict: "test_defect" as const, variant: 0, wrote: false });
const writes = async () => ({ verdict: "test_defect" as const, variant: 1, wrote: true });
const pass = (open: Row[], decide: typeof noWrite, perTick = 3, decideMax = 20) =>
  supply.testDefectPass({ open, touched: new Set<string>(), perTick, decideMax, nowIso: NOW, dryRun: false, decide });

describe("the test-defect pass budget", () => {
  it("[CONTROL] the fixture rows are localization candidates", () => {
    expect(supply.testDefectCandidate(candidate(1))).not.toBeNull();
  });
  it("[CONTROL] variant-0: every decision counts, three of four decided, the fourth an undecided candidate, no trace", async () => {
    const r = await pass([1, 2, 3, 4].map(candidate), noWrite);
    expect(r.decisions.map((d) => d.id)).toEqual([1, 2, 3].map((n) => `failing-test-fixture-${n}`));
    expect(r.budget).toMatchObject({ variant: 0, per_tick: 3, decided: 3, wrote: 0, undecided_candidates: 1 });
    expect(logs.some((l) => l.includes(supply.TEST_DEFECT_BUDGET_ACTIVITY) && l.includes("counts=decisions") && l.includes("undecided_candidates=1"))).toBe(true);
    expect(traces).toEqual([]);
  });
  it("[MUST-FAIL] variant-1: three decisions without a write do not spend the budget, the fourth candidate is decided", async () => {
    masks = [mask(1)];
    const r = await pass([1, 2, 3, 4].map(candidate), noWrite);
    expect(r.decisions).toHaveLength(4);
    expect(r.budget).toMatchObject({ variant: 1, decided: 4, wrote: 0, undecided_candidates: 0 });
  });
  it("[MUST-FAIL] variant-1: writes stay bounded by max_per_tick, decisions by test_defect_decide_max", async () => {
    masks = [mask(1)];
    const w = await pass([1, 2, 3, 4, 5].map(candidate), writes);
    expect(w.budget).toMatchObject({ decided: 3, wrote: 3, undecided_candidates: 2 });
    const many = Array.from({ length: 25 }, (_, i) => candidate(100 + i));
    const d = await pass(many, noWrite, 3, 20);
    expect(d.budget).toMatchObject({ decide_max: 20, decided: 20, undecided_candidates: 5 });
  });
  it("[MUST-FAIL] variant-1 posts the pass as a trace with the budget record", async () => {
    masks = [mask(1)];
    await pass([1, 2].map(candidate), noWrite);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ activity_id: `${supply.TEST_DEFECT_BUDGET_ACTIVITY}-v1`, input_shapes: ["substrateGap"], output_shapes: ["testDefectLocalizationBudget"] });
    expect((traces[0]!.metadata as Row)["testDefectLocalizationBudget"]).toMatchObject({ variant: 1, decided: 2, wrote: 0 });
  });
});

describe("wiring (source pin)", () => {
  it("[MUST-FAIL] the tick's due pass runs testDefectPass with max_per_tick and the rhythm's decide bound", () => {
    const src = readFileSync(new URL("../../src/resolvers/gap-check-supply.ts", import.meta.url), "utf8");
    expect(src).toMatch(/const testDefects: TestDefectPassEntry\[\] = dispatchDue\n\s+\? \(await testDefectPass\(\{ open, touched, perTick, decideMax: Math\.floor\(posNum\(rhythm\.body\["test_defect_decide_max"\], TEST_DEFECT_DECIDE_MAX\)\)/);
  });
});
