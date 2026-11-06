// gap-check-supply TEST-DEFECT LOCALIZATION (development-vessel:test-defect-localization, testDefectLocalizationDecision).
// A failing-test row whose own check is red only because a child script the test spawns does not parse was sited on the
// src module the child imports, and the one fix (the test) could never be drafted. Variant-1 re-sites it to the test file
// in ONE write, marked test_defect with the child-parse certifier; variant-0 logs what it would do and writes nothing.
//   (a) MUST-FAIL: under variant-1 the row's edit_site becomes its test file, with test_defect, the test file out of
//       protected_files and pwt_escalated set, while its own check (evidence_resolve) and its class2 falsifier stand; the
//       write seam does not re-label it unresolvable, and compose eligibility does not skip it as its own check.
//   (b) CONTROL: a row whose test file is its edit site WITHOUT the record is still re-labelled unresolvable by the seam
//       (the exemption is the record, not the site).
//   CONTROL: variant-0 (and no mask) logs "would localize" and leaves the row as it was; a mixed row (one case fails
//       outside its child scripts) is logged mixed and left as it is under variant-1; an assertion-class row, a row on
//       operator hold and a row already marked are not decided at all (no line).
// Harness: as gap-check-supply-candidate-order.test.ts (temp gap store, stubbed fetch); the check file's text comes from
// the readCheck seam, the masks from readMasks, the trace post from postTrace.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { __resetDiscoveryForTests } from "../../src/config.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gcs-test-defect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "MITOSIS_RUNTIME_DIR", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT", "SUPER_REPO_DIR"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env["SUPER_REPO_DIR"] = join(ROOT, "policy-super");
mkdirSync(join(ROOT, "policy-super", ".git"), { recursive: true });
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
process.env["VESSELS_CLONE_ROOT"] = join(ROOT, "clones");
process.env["MITOSIS_RUNTIME_DIR"] = join(ROOT, "runtime");
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const supply = await import("../../src/resolvers/gap-check-supply.js");
const elig = await import("../../src/judge/gap-eligibility.js");

type Row = Record<string, unknown>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fixture-vessel";
const TEST_FILE = "test/resolvers/child.test.ts";
const SRC_SITE = `repos/${VESSEL}/src/resolvers/child.ts`;
const NOW_ISO = "2099-01-01T00:00:00.000Z";

const BT = "`";
const childCase = (title: string, body: string): string =>
  `  it("${title}", async () => {\n    const child = Bun.spawn([process.execPath, "--eval", ${BT}\n      const { f } = await import('\${import.meta.url}');\n${body}\n      process.stdout.write(JSON.stringify(f()));\n    ${BT}]);\n    expect(JSON.parse(await new Response(child.stdout).text())).toBe(1);\n  });\n`;
const BAD = "      const b = new Blob(['active\\n']);";
const GOOD = "      const b = new Blob(['ok']);";
const CHECK_SRC = `import { describe, expect, it } from "bun:test";\ndescribe("child", () => {\n${childCase("one via child", BAD)}${childCase("two via child", BAD)}${childCase("three via child", GOOD)}});\n`;
const ONE = "child > one via child", TWO = "child > two via child", THREE = "child > three via child";
const PARSE = "error: Unterminated string literal";

const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let logs: string[] = [];
let traces: Row[] = [];
let masks: Row[] = [];
let gapStore: { restore: () => Promise<void> } | null = null;

const mask = (variant: number): Row => ({ id: `mask-tdl-${RUN}`, body: { activity_id: "development-vessel:test-defect-localization", active_variant: variant, from: "2000-01-01T00:00:00Z", until: "2099-12-31T00:00:00Z", by: "operator:test", reason: "fixture" } });

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const imp = body?.impulse ?? {};
    if (imp?.type === "poolImpulse") return openPolicyAnswer(imp.shape);
    void input;
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  supply.__setTestDefectLocalizationDepsForTests({
    readMasks: () => masks as never,
    postTrace: async (t) => { traces.push(t); return 201; },
    readCheck: (v, f) => (v === VESSEL && f === TEST_FILE ? CHECK_SRC : null),
  });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(async () => {
  supply.__setTestDefectLocalizationDepsForTests(null);
  await gapStore?.restore();
  globalThis.fetch = originalFetch; console.log = origLog; console.warn = origWarn;
  sg.__setBirthJudgeForTests(null); __resetDiscoveryForTests();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { logs = []; traces = []; masks = []; });

let seq = 0;
async function seed(o: { only: string[]; failing: Array<{ name: string; error: string }>; site?: string; extra?: Row }): Promise<string> {
  const id = `failing-test-${VESSEL}-child-${RUN}-${++seq}`;
  const meta: Row = {
    falsifier: "class2",
    evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: TEST_FILE, only_tests: o.only, timeout_ms: 180000 }, zero_field: "requested_not_passing" },
    edit_site: o.site ?? SRC_SITE,
    protected_files: [`repos/${VESSEL}/${TEST_FILE}`],
    filed_by: "pull-sync failing-test generator",
    own_check_baseline: { gap_id: id, vessel: VESSEL, test_file: TEST_FILE, only_tests: o.only, base_sha: "a".repeat(40), verdict: "red_code_reachable", red: o.only, failing: o.failing, expect_count: null, call_path: [], call_path_source: null, env_signals: [], env_policy: "absent", dispatch_id: null, measured_at: "2000-01-01T00:00:00.000Z" },
    ...(o.extra ?? {}),
  };
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "failing_test", source: "substrate_detected", status: "open", detected_at: "2000-01-01T00:00:00.000Z", summary: `Failing test(s) in repos/${VESSEL}/${TEST_FILE}`, classification_metadata: meta } } as never);
  if (w.shape === "structuredError") throw new Error(`seed refused: ${JSON.stringify(w.body)}`);
  await sg.__settleBirthEvaluationsForTests();
  return id;
}
async function storeRow(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) throw new Error(`gap ${id} not in the store`);
  return row;
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
const falsifierOf = (r: Row): string => { const f = metaOf(r)["falsifier"] as unknown; return String(f && typeof f === "object" ? (f as Row)["class"] : f); };
const decisionLines = (): string[] => logs.filter((l) => l.includes("[development-vessel:test-defect-localization]"));

describe("test-defect localization", () => {
  it("[MUST-FAIL] variant-1: one write re-sites the row to its test file, its own check and class2 standing", async () => {
    masks = [mask(1)];
    const id = await seed({ only: [ONE, TWO], failing: [{ name: ONE, error: PARSE }, { name: TWO, error: PARSE }] });
    const before = await storeRow(id);
    expect(falsifierOf(before)).toBe("class2");
    const d = await supply.testDefectLocalizationDecision(before, NOW_ISO, false);
    expect(d).toEqual({ verdict: "test_defect", variant: 1, wrote: true });
    await sg.__settleBirthEvaluationsForTests();
    const after = await storeRow(id);
    const m = metaOf(after);
    expect(m["edit_site"]).toBe(`repos/${VESSEL}/${TEST_FILE}`);
    expect((m["test_defect"] as Row)["certifier"]).toEqual({ shape: "test_defect_child_parse", vessel: VESSEL, test_file: TEST_FILE });
    expect((m["test_defect"] as Row)["prior_edit_site"]).toBe(SRC_SITE);
    expect(m["protected_files"]).toEqual([]);
    expect(m["pwt_escalated"]).toBe(true);
    expect((m["test_defect"] as Row)["pwt_closed_by"]).toBe("test-defect-localization");
    expect(m["localized_by"]).toBe("test-defect-localization");
    expect(m["evidence_resolve"]).toEqual(metaOf(before)["evidence_resolve"]);
    expect(falsifierOf(after)).toBe("class2");
    expect(elig.editSiteIsOwnCheck(after)).toBeNull();
    expect(elig.composeEligibilitySkipReason(after)).not.toBe("edit_site_is_own_check");
    expect(decisionLines().some((l) => l.includes("variant=1") && l.includes(`gap=${id}`) && l.includes("verdict=test_defect") && l.includes(`localized to repos/${VESSEL}/${TEST_FILE}`))).toBe(true);
    expect(traces.map((t) => t["activity_id"])).toEqual(["development-vessel:test-defect-localization-v1"]);
    expect(traces[0]!["output_shapes"]).toEqual(["testDefectLocalization"]);
    // Taken once: a marked row is not decided again.
    logs = [];
    expect(await supply.testDefectLocalizationDecision(after, NOW_ISO, false)).toBeNull();
    expect(decisionLines()).toEqual([]);
  });
  it("[CONTROL] the exemption is the record: the test file as edit site without it is still re-labelled unresolvable", async () => {
    const id = await seed({ only: [ONE], failing: [{ name: ONE, error: PARSE }], site: `repos/${VESSEL}/${TEST_FILE}` });
    const row = await storeRow(id);
    expect(elig.editSiteIsOwnCheck(row)).not.toBeNull();
    expect(falsifierOf(row)).toBe("unresolvable");
  });
  it("[CONTROL] a test_defect record whose certifier names a different file does not exempt the row: still re-labelled unresolvable", async () => {
    const id = await seed({ only: [ONE], failing: [{ name: ONE, error: PARSE }], site: `repos/${VESSEL}/${TEST_FILE}`,
      extra: { test_defect: { decision_id: "x", certifier: { shape: "test_defect_child_parse", vessel: VESSEL, test_file: "test/resolvers/other.test.ts" } } } });
    const row = await storeRow(id);
    expect(elig.editSiteIsOwnCheck(row)).not.toBeNull();
    expect(falsifierOf(row)).toBe("unresolvable");
  });
  it("[CONTROL] variant-0 and no mask: logged 'would localize', the row unchanged, no trace", async () => {
    for (const m of [[mask(0)], []]) {
      masks = m;
      logs = [];
      const id = await seed({ only: [ONE], failing: [{ name: ONE, error: PARSE }] });
      const before = await storeRow(id);
      expect(await supply.testDefectLocalizationDecision(before, NOW_ISO, false)).toEqual({ verdict: "test_defect", variant: 0, wrote: false });
      const after = await storeRow(id);
      expect(metaOf(after)["edit_site"]).toBe(SRC_SITE);
      expect(metaOf(after)["test_defect"]).toBeUndefined();
      expect(metaOf(after)["protected_files"]).toEqual([`repos/${VESSEL}/${TEST_FILE}`]);
      expect(decisionLines().some((l) => l.includes("variant=0") && l.includes("would localize to the test file"))).toBe(true);
    }
    expect(traces).toEqual([]);
  });
  it("[CONTROL] a mixed row (one case fails outside its child scripts) is logged mixed and left as it is under variant-1", async () => {
    masks = [mask(1)];
    const id = await seed({ only: [ONE, THREE], failing: [{ name: ONE, error: PARSE }, { name: THREE, error: "error: Mock failure" }] });
    const before = await storeRow(id);
    expect(await supply.testDefectLocalizationDecision(before, NOW_ISO, false)).toEqual({ verdict: "mixed", variant: 1, wrote: false });
    expect(metaOf(await storeRow(id))["edit_site"]).toBe(SRC_SITE);
    expect(decisionLines().some((l) => l.includes("verdict=mixed") && l.includes("one via child=test_defect") && l.includes("three via child=src"))).toBe(true);
    expect(traces).toEqual([]);
  });
  it("[CONTROL] an assertion-class row, a SyntaxError from src, an operator hold: not decided, no line", async () => {
    masks = [mask(1)];
    const assertRow = await storeRow(await seed({ only: [ONE], failing: [{ name: ONE, error: "error: expect(received).toBe(expected)" }] }));
    const srcSyntax = await storeRow(await seed({ only: [THREE], failing: [{ name: THREE, error: "error: Unexpected token '}'" }] }));
    const held = await storeRow(await seed({ only: [ONE], failing: [{ name: ONE, error: PARSE }], extra: { operator_hold: true } }));
    for (const r of [assertRow, srcSyntax, held]) expect(await supply.testDefectLocalizationDecision(r, NOW_ISO, false)).toBeNull();
    expect(metaOf(await storeRow(String(srcSyntax["id"])))["edit_site"]).toBe(SRC_SITE);
    expect(decisionLines()).toEqual([]);
  });
});
