// feature-compose TEST-DEFECT ADMISSION (development-vessel:test-defect-admission, testDefectAdmissionDecision). A row the
// test-defect localization re-sited to its test file can only be fixed by editing the file its own check runs; a green
// own check cannot certify that alone (a draft could delete what it measures). Variant-1 admits such a draft only when
// it edits nothing but that file and the child-parse certifier is red on the parent and green on the draft.
//   (a) MUST-FAIL: under variant-1 a certified test-only draft is admitted, its decision traced, and the localization's
//       credit is posted in its composition chain, reached:true; the semantic gate's self_certification veto does not
//       apply to it (semanticGateDisposition test_defect_certified).
//   (b) MUST-FAIL: under variant-1 a draft that also edits src, removes a case, removes a child script, adds a skip mark,
//       leaves a child script unparseable, or edits a parent whose scripts all parse is refused; the credit is
//       reached:false.
//   (c) MUST-FAIL: under variant-1 a test-defect row's own-check block names the file as its edit site and lists the
//       child scripts that do not parse; under variant-0 it is today's read-only block.
//   CONTROL: variant-0 and no mask refuse as before and post nothing; a non-test-defect row's block is byte-identical
//       under variant-0 and variant-1; a record whose certifier names another file is no record; without
//       test_defect_certified the test-only draft is still vetoed as self_certification; the expect( site count the
//       compose's own contract check reads (staticExpectCount) sees an assertion removed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const RUN = Math.random().toString(36).slice(2, 8);
const ROOT = join(tmpdir(), `fc-test-defect-${Date.now()}-${RUN}`);
const VESSEL = `tda-fixture-${RUN}-vessel`;
const TEST_FILE = "test/resolvers/child.test.ts";
const NOW_ISO = "2099-01-01T00:00:00.000Z";
const DECISION = "test-defect-localization-fixture-1";

const BT = "`";
const childCase = (title: string, body: string, mark = ""): string =>
  `  it${mark}("${title}", async () => {\n    const child = Bun.spawn([process.execPath, "--eval", ${BT}\n      const { f } = await import('\${import.meta.url}');\n${body}\n      process.stdout.write("ok");\n    ${BT}]);\n    expect(await new Response(child.stdout).text()).toBe("ok");\n  });\n`;
const plainCase = (title: string): string => `  it("${title}", () => {\n    expect(1).toBe(1);\n  });\n`;
const file = (...cases: string[]): string => `import { describe, expect, it } from "bun:test";\ndescribe("child", () => {\n${cases.join("")}});\n`;
const BAD = "      const b = new Blob(['active\\n']);";
const GOOD = "      const b = new Blob(['active\\\\n']);";
const PARENT = file(childCase("one via child", BAD), childCase("two via child", GOOD), plainCase("three plain"));
const FIXED = file(childCase("one via child", GOOD), childCase("two via child", GOOD), plainCase("three plain"));

const mask = (variant: number) => ({ id: `mask-tda-${RUN}`, body: { activity_id: "development-vessel:test-defect-admission", active_variant: variant, from: "2000-01-01T00:00:00Z", until: "2099-12-31T00:00:00Z", by: "operator:test", reason: "fixture" } });
let masks: unknown[] = [];
let traces: Array<Record<string, unknown>> = [];
let logs: string[] = [];
const origLog = console.log;
const origWarn = console.warn;

const record = { decision_id: DECISION };
const decide = (o: Partial<{ editedRel: string[]; createdRel: string[]; parentSrc: string; draftSrc: string; baseRed: string[] | null }> = {}) =>
  fc.testDefectAdmissionDecision({ gap_id: `gap-${RUN}`, vessel: VESSEL, test_file: TEST_FILE, record, editedRel: o.editedRel ?? [TEST_FILE], createdRel: o.createdRel ?? [], parentSrc: o.parentSrc ?? PARENT, draftSrc: o.draftSrc ?? FIXED, baseRed: o.baseRed === undefined ? ["child > one via child"] : o.baseRed, nowIso: NOW_ISO });
const credit = () => traces.filter((t) => t["activity_id"] === "development-vessel:test-defect-localization-credit");
const tdMeta = (testFile = TEST_FILE) => ({
  evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: TEST_FILE, only_tests: ["child > one via child"] }, zero_field: "requested_not_passing" },
  edit_site: `repos/${VESSEL}/${TEST_FILE}`,
  test_defect: { decision_id: DECISION, certifier: { shape: "test_defect_child_parse", vessel: VESSEL, test_file: testFile } },
});

beforeAll(() => {
  mkdirSync(join(ROOT, VESSEL, "test", "resolvers"), { recursive: true });
  writeFileSync(join(ROOT, VESSEL, TEST_FILE), PARENT);
  fc.__setTestDefectAdmissionDepsForTests({ readMasks: () => masks, postTrace: async (t: Record<string, unknown>) => { traces.push(t); return 201; } });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  fc.__setTestDefectAdmissionDepsForTests(null);
  console.log = origLog; console.warn = origWarn;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { masks = []; traces = []; logs = []; });

describe("the admission decision", () => {
  it("[MUST-FAIL] variant-1: a certified test-only draft is admitted; decision traced; the localization credited reached:true", async () => {
    masks = [mask(1)];
    const d = decide();
    expect(d.breach).toBeNull();
    expect(d.variant).toBe(1);
    await Promise.resolve();
    expect(traces.map((t) => t["activity_id"])).toEqual(["development-vessel:test-defect-admission-v1", "development-vessel:test-defect-localization-credit"]);
    expect(credit()[0]!["composition_chain"]).toEqual([DECISION]);
    expect(credit()[0]!["success"]).toBe(true);
    expect(logs.some((l) => l.includes("[development-vessel:test-defect-admission]") && l.includes("variant=1") && l.includes("admitted: certified by the child-parse check"))).toBe(true);
  });
  const refusals: Array<[string, Parameters<typeof decide>[0], string]> = [
    ["also edits src", { editedRel: [TEST_FILE, "src/resolvers/child.ts"] }, "may edit only its test file"],
    ["creates a file", { createdRel: ["test/resolvers/helper.ts"] }, "may edit only its test file"],
    ["removes a case", { draftSrc: file(childCase("one via child", GOOD), plainCase("three plain")) }, "removes test cases"],
    ["removes a child script", { draftSrc: file(childCase("one via child", GOOD), plainCase("two via child"), plainCase("three plain")) }, "removes child scripts"],
    ["adds a skip mark", { draftSrc: file(childCase("one via child", GOOD, ".skip"), childCase("two via child", GOOD), plainCase("three plain")) }, "adds skip/todo/only"],
    ["leaves a child script unparseable", { draftSrc: PARENT }, "still do not parse"],
    ["edits a parent whose scripts all parse", { parentSrc: FIXED }, "not red on the parent"],
  ];
  for (const [what, o, why] of refusals) {
    it(`[MUST-FAIL] variant-1: a draft that ${what} is refused; the localization credited reached:false`, async () => {
      masks = [mask(1)];
      const d = decide(o);
      expect(String(d.breach)).toContain(why);
      await Promise.resolve();
      expect(credit()).toHaveLength(1);
      expect(credit()[0]!["success"]).toBe(false);
    });
  }
  it("[CONTROL] variant-0 and no mask: refused as before (a draft of its own check is not admitted), logged 'would certify', no trace", () => {
    for (const m of [[mask(0)], []]) {
      masks = m;
      const d = decide();
      expect(String(d.breach)).toContain("test-defect admission variant-0");
      expect(d.variant).toBe(0);
    }
    expect(traces).toEqual([]);
    expect(logs.filter((l) => l.includes("would certify (certifier passes")).length).toBe(2);
  });
  it("[CONTROL] the record: a certifier naming another file, or another shape, is no record", () => {
    expect(fc.testDefectRecordFor(tdMeta(), TEST_FILE, VESSEL)).toEqual({ decision_id: DECISION });
    expect(fc.testDefectRecordFor(tdMeta("test/other.test.ts"), TEST_FILE, VESSEL)).toBeNull();
    expect(fc.testDefectRecordFor({ test_defect: { certifier: { shape: "other", test_file: TEST_FILE } } }, TEST_FILE, VESSEL)).toBeNull();
    expect(fc.testDefectRecordFor({}, TEST_FILE, VESSEL)).toBeNull();
  });
  it("[CONTROL] the compose's own contract check sees an assertion removed from the check file (staticExpectCount)", () => {
    const fewer = FIXED.replace('    expect(1).toBe(1);\n', "");
    expect(fc.staticExpectCount(fewer)).toBeLessThan(fc.staticExpectCount(PARENT));
  });
});

describe("the semantic gate's self_certification veto", () => {
  const gate = { addresses: false, on_live_path: true, hard_fail: false, reason: "the diff only edits a test" };
  const own = { test_file: TEST_FILE, ran: true, tc_ok: true, base_red: ["child > one via child"], draft_red: [], contract_breach: null };
  const diff = [`### /vessels/${VESSEL}/${TEST_FILE}`, `--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`, "@@ -1,1 +1,1 @@", "-      const b = new Blob(['active\\n']);", "+      const b = new Blob(['active\\\\n']);"].join("\n");
  const site = `repos/${VESSEL}/${TEST_FILE}`;
  it("[MUST-FAIL] a certified test-defect draft is not vetoed as self_certification", () => {
    const d = fc.semanticGateDisposition({ gate, own_check: own, diff, edit_site: site, src_files: {}, test_defect_certified: true });
    expect(d.veto).toBeNull();
    expect(d.land).toBe(true);
  });
  it("[CONTROL] without the certification the same draft is still vetoed self_certification", () => {
    expect(fc.semanticGateDisposition({ gate, own_check: own, diff, edit_site: site, src_files: {} }).veto).toBe("self_certification");
    expect(fc.semanticGateDisposition({ gate, own_check: own, diff, edit_site: site, src_files: {}, test_defect_certified: false }).veto).toBe("self_certification");
  });
});

describe("the own-check grounding block", () => {
  const read = (meta: Record<string, unknown>) => fc.readOwnCheckGrounding(meta, () => join(ROOT, VESSEL));
  it("[MUST-FAIL] variant-1: a test-defect row's block names the file as its edit site and lists the child scripts that do not parse", () => {
    masks = [mask(1)];
    const r = read(tdMeta());
    expect(r.state).toBe("shown");
    expect(r.ctx.test_defect).toBe(true);
    expect(r.ctx.block).toContain("THE GAP'S OWN CHECK IS ITS EDIT SITE");
    expect(r.ctx.block).toContain("Unterminated string literal");
    expect(r.ctx.block).not.toContain("NOT A TARGET FILE");
  });
  it("[CONTROL] variant-0: a test-defect row is shown today's read-only block", () => {
    masks = [mask(0)];
    const r = read(tdMeta());
    expect(r.ctx.block).toContain("READ-ONLY CONTEXT; NOT A TARGET FILE");
    expect(r.ctx.test_defect).toBeUndefined();
  });
  it("[CONTROL] a non-test-defect row's block is byte-identical under variant-0 and variant-1", () => {
    const meta = { evidence_resolve: tdMeta().evidence_resolve, edit_site: `repos/${VESSEL}/src/resolvers/child.ts` };
    masks = [mask(0)];
    const v0 = read(meta);
    masks = [mask(1)];
    const v1 = read(meta);
    expect(v1.ctx.block).toBe(v0.ctx.block);
    expect(v1.ctx.test_defect).toBeUndefined();
  });
});

describe("the wiring in verify (source pin)", () => {
  it("[MUST-FAIL] verify runs the admission after the own check's expect-site contract and hands the gate its certification", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const expectSites = src.indexOf("the draft removes assertion sites from the check file itself");
    const hook = src.indexOf("const td = testDefectAdmissionDecision({");
    expect(expectSites).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(expectSites);
    expect(src.slice(hook, hook + 600)).toContain("if (td.breach) contractBreach = td.breach; else testDefectCertified.add(v);");
    expect(src).toContain("test_defect_certified: [...touched].some((v) => testDefectCertified.has(v)),");
    expect(src).toContain("if (ownCheckCtx && ownCheckVesselGrounded && ownCheckCtx.test_defect !== true) {");
  });
});
