// UNPARK ONLY IF IT LOCATES (user ruling). A failing-test row parked needs_information waits for the fact that says where
// its fix goes. A fresh red_code_reachable own-check reading (measured at the vessel's current origin/dev, for the check
// the row names) supplies that fact only when its call path names an EXISTING, IN-SCOPE SOURCE file: not a test or check
// file, and no excluded file on the path. Admission's needs_information drain (gap-admission ownCheckLocatesPark) then
// lifts the park with a WRITE, so feature_compose, which re-reads the stored row, sees the same unparked row. Anything
// else stays parked: a call path of only tests, one through an excluded file, no reading, a green or stale one, and
// awaiting_operator_review whatever the reading says.
//
// Driven through the real write seam on a temp gap store, with a stub birth judge (as the drain's own check file).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";
import { openPolicyAnswer } from "../resolvers/explicit-open-policy.fixture.js";
import { snapshotGapStore } from "../resolvers/gap-store-snapshot.js";

const ROOT = mkdtempSync(join(tmpdir(), "own-check-unpark-"));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { admitActionableGaps } = await import("../../src/judge/gap-admission.js");
const policy = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, gapStoreRootForTest, __setBirthJudgeForTests } = sg;
const setScopeDeps = (policy as unknown as { __setAutonomyScopeDepsForTests: (d: unknown) => void }).__setAutonomyScopeDepsForTests;

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const V = "development-vessel";
const HEAD = "e".repeat(40);
const SRC = `repos/${V}/src/resolvers/widget.ts`;
const LANE_CORE = `repos/${V}/src/resolvers/lane-core.ts`;
const TEST_HELPER = `repos/${V}/test/fixtures/widget-helper.ts`;
const SRC_TEST = `repos/${V}/src/resolvers/widget.test.ts`;
const CHECK_FILE = `repos/${V}/test/checks/widget.check.ts`;
// A free-text site that names no file: the row is sited (compose eligibility) but grounded only by its call path.
const SITE_PROSE = `repos/${V}/src/resolvers (the widget path)`;
const TF = "test/resolvers/widget.test.ts";
const TITLES = ["widget > counts every widget"];
const SCOPE = { excluded: [LANE_CORE], readable: true, reason: "fixture scope", exceptions: [] };
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let gapStore: { restore: () => Promise<void> } | null = null;

beforeAll(() => {
  for (const k of ["GAP_STORE_ENDPOINT", "ACTIVITY_API_ENDPOINT", "MITOSIS_RUNTIME_DIR", "VESSELS_CLONE_ROOT", "PROPOSALS_DIR"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["ACTIVITY_API_ENDPOINT"];
  process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
  process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
  process.env["PROPOSALS_DIR"] = join(ROOT, "proposals");
  for (const d of ["gaps", "clones", "proposals"]) mkdirSync(join(ROOT, d), { recursive: true });
  for (const f of [SRC, LANE_CORE, TEST_HELPER, SRC_TEST, CHECK_FILE]) {
    const abs = join(ROOT, "runtime", f.replace(/^repos\//, ""));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "export const widget = 1;\n");
  }
  gapStore = snapshotGapStore(gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  policy.__resetPolicyReadsForTests();
  setScopeDeps({ live: async () => SCOPE, boundS: () => 0, now: Date.now });
  __setBirthJudgeForTests(async () => "present");
  if (!gapStoreRootForTest().startsWith(tmpdir()) && !gapStoreRootForTest().startsWith("/tmp/")) throw new Error(`gap store not isolated: ${gapStoreRootForTest()}`);
});
afterAll(async () => {
  await gapStore?.restore();
  __setBirthJudgeForTests(null);
  setScopeDeps(null);
  globalThis.fetch = originalFetch;
  policy.__resetPolicyReadsForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const reading = (verdict: string, call_path: string[], base_sha = HEAD) => ({
  gap_id: "widget", vessel: V, test_file: TF, only_tests: TITLES, base_sha, verdict, red: [], failing: [], expect_count: 1,
  call_path: call_path.map((path, i) => ({ path, fn: `f${i}`, line: 10 + i })), call_path_source: "static", env_signals: [], env_policy: "policy", dispatch_id: "disp-widget", measured_at: "2026-01-01T00:00:00Z",
});
async function failingTestRow(id: string, meta: Row): Promise<Row> {
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "test_failure", source: "substrate_detected", status: "open", summary: "widget counting test fails at origin/dev", detected_at: new Date().toISOString(), classification_metadata: {
    edit_site: SITE_PROSE, falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: V, test_file: TF, only_tests: TITLES }, zero_field: "requested_not_passing" }, ...meta,
  } } } as never, { vocabulary: null } as never);
  await __settleBirthEvaluationsForTests();
  return stored(id);
}
async function stored(id: string): Promise<Row> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Row[] }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error(`no row ${id}`);
  return g;
}
const metaOf = (row: Row): Row => (row.classification_metadata ?? {}) as Row;
async function admit(rows: Row[], head = HEAD) {
  const r = await admitActionableGaps(JSON.parse(JSON.stringify(rows)) as Row[], { typecheckRunner: async () => ({ ran: false, clean: false }), baseShaOf: () => head } as never) as { admitted: Row[]; excluded: Array<{ id: string; reason: string }>; groundedBy?: Record<string, string> };
  return { admittedIds: r.admitted.map((g) => String(g.id)), reasonOf: (id: string) => r.excluded.find((e) => e.id === id)?.reason, by: (id: string) => r.groundedBy?.[id] };
}
/** The row stays parked: excluded as that disposition, and the store row unchanged (no drain record written). */
async function expectParked(id: string, disposition: string, adm: Awaited<ReturnType<typeof admit>>): Promise<void> {
  expect(adm.admittedIds).not.toContain(id);
  expect(adm.reasonOf(id)).toBe(`disposition(${disposition})`);
  const after = metaOf(await stored(id));
  expect(after["disposition"]).toBe(disposition);
  expect(after["needs_information_drained"]).toBeUndefined();
}

describe("a red_code_reachable reading that locates an in-scope source file unparks a needs_information row", () => {
  it("MUST-FAIL the parked failing-test row is admitted (not excluded as needs_information), and the store row is unparked", async () => {
    const id = `unpark-locates-${RUN}`;
    const before = await failingTestRow(id, { disposition: "needs_information", own_check_baseline: reading("red_code_reachable", [SRC]) });
    // PRECONDITION: the seam kept the park and the reading.
    expect(metaOf(before)).toMatchObject({ disposition: "needs_information", own_check_baseline: { verdict: "red_code_reachable", base_sha: HEAD } });
    const adm = await admit([before]);
    expect(adm.reasonOf(id)).toBeUndefined();
    expect(adm.admittedIds).toContain(id);
    expect(adm.by(id)).toBe("own_check_baseline_call_path");
    const after = metaOf(await stored(id));
    expect(after["disposition"]).toBe("");
    expect(after["needs_information_drained"]).toMatchObject({ from: "needs_information", because: `its own check's red_code_reachable reading at ${HEAD.slice(0, 12)} locates ${SRC}` });
  });

  it("MUST-FAIL a test file before the source file on the path does not stop it: the source file locates", async () => {
    const id = `unpark-mixed-${RUN}`;
    const adm = await admit([await failingTestRow(id, { disposition: "needs_information", own_check_baseline: reading("red_code_reachable", [SRC_TEST, TEST_HELPER, SRC]) })]);
    expect(adm.admittedIds).toContain(id);
    expect(metaOf(await stored(id))["needs_information_drained"]).toMatchObject({ because: `its own check's red_code_reachable reading at ${HEAD.slice(0, 12)} locates ${SRC}` });
  });

  it("MUST-FAIL gap-lifecycle-scan's needs_info spelling is the same park, and the lift records which one it lifted", async () => {
    const id = `unpark-needs-info-${RUN}`;
    const adm = await admit([await failingTestRow(id, { disposition: "needs_info", own_check_baseline: reading("red_code_reachable", [SRC]) })]);
    expect(adm.admittedIds).toContain(id);
    expect(metaOf(await stored(id))["needs_information_drained"]).toMatchObject({ from: "needs_info" });
  });
});

describe("CONTROLS: a reading that does not locate leaves the row parked, and nothing is written", () => {
  it("CONTROL a call path of only test and check files (test/, *.test.ts, *.check.ts) stays parked", async () => {
    const id = `unpark-tests-only-${RUN}`;
    await expectParked(id, "needs_information", await admit([await failingTestRow(id, { disposition: "needs_information", own_check_baseline: reading("red_code_reachable", [TEST_HELPER, SRC_TEST, CHECK_FILE]) })]));
  });

  it("CONTROL a call path through an excluded src file stays parked, even with an in-scope src file on it", async () => {
    const id = `unpark-excluded-${RUN}`;
    await expectParked(id, "needs_information", await admit([await failingTestRow(id, { disposition: "needs_information", own_check_baseline: reading("red_code_reachable", [SRC, LANE_CORE]) })]));
  });

  it("CONTROL no reading, a green_at_parent reading, and a red reading at another sha (stale) stay parked", async () => {
    const none = `unpark-none-${RUN}`, green = `unpark-green-${RUN}`, stale = `unpark-stale-${RUN}`;
    const adm = await admit([
      await failingTestRow(none, { disposition: "needs_information" }),
      await failingTestRow(green, { disposition: "needs_information", own_check_baseline: reading("green_at_parent", [SRC]) }),
      await failingTestRow(stale, { disposition: "needs_information", own_check_baseline: reading("red_code_reachable", [SRC], "d".repeat(40)) }),
    ]);
    for (const id of [none, green, stale]) await expectParked(id, "needs_information", adm);
  });

  it("CONTROL awaiting_operator_review is never cleared, whatever the reading locates", async () => {
    const id = `unpark-review-${RUN}`;
    await expectParked(id, "awaiting_operator_review", await admit([await failingTestRow(id, { disposition: "awaiting_operator_review", own_check_baseline: reading("red_code_reachable", [SRC]) })]));
  });

  it("CONTROL a park beside an auto-revert escalation (a human's to lift) stays parked", async () => {
    const id = `unpark-escalated-${RUN}`;
    await expectParked(id, "needs_information", await admit([await failingTestRow(id, { disposition: "needs_information", auto_revert_escalation: { kind: "fixture", detail: "reverted" }, own_check_baseline: reading("red_code_reachable", [SRC]) })]));
  });

  it("CONTROL a row that is not parked is unchanged: admitted, grounded by its call path, no drain record", async () => {
    const id = `unpark-not-parked-${RUN}`;
    const adm = await admit([await failingTestRow(id, { own_check_baseline: reading("red_code_reachable", [SRC]) })]);
    expect(adm.admittedIds).toContain(id);
    expect(adm.by(id)).toBe("own_check_baseline_call_path");
    expect(metaOf(await stored(id))["needs_information_drained"]).toBeUndefined();
  });
});
