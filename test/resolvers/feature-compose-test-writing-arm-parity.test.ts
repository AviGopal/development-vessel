/**
 * test-writing-arm-parity — the inputs the test-writing verify's arm precheck judges a drafted check by
 * (src/resolvers/feature-compose.ts testWritingArmPrecheck / armParityDecision). The arm step reads the gap row from the
 * store; the verify was handed the caller's summary and a meta merged over the caller's copy, so the region gate could
 * derive a region here that the arm step cannot, cancel a refusal before landing, and leave the arm step to refuse the
 * check after it is public.
 *   (a) MUST-FAIL: the inputs that differ between the caller's copy and the row are named (summary, the meta keys the
 *       arm gates read, check_supply.edit_site); equal inputs name none.
 *   (b) MUST-FAIL: a caller summary that names a site identifier derives a region; the row's summary that names none
 *       derives no region; the decision record says the regions differ and whose inputs it judged by.
 *   (c) MUST-FAIL: the variant is the mask in force; variant-1 judges by the row, and by the caller's inputs when the
 *       row could not be read; every decision is recorded as a trace (output testWritingArmParity), not only a log line.
 *   (d) MUST-FAIL (source pin): the precheck passes the chosen inputs to the arm gates and records each run.
 * The fixtures are built here; nothing is read from the vessel's gap store.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  __setTestWritingArmParityDepsForTests,
  armInputsDiffer,
  armParityDecision,
  armRegionOf,
  TEST_WRITING_ARM_PARITY_ACTIVITY,
  testWritingArmParityVariant,
} from "../../src/resolvers/feature-compose.js";

const SITE_REL = "src/delivery.ts";
const SITE = [
  "export async function deliver(store: { read(): string[] }, drainSpool: () => Promise<void>): Promise<string[]> {",
  "  void drainSpool();",
  "  return store.read();",
  "}",
  "",
].join("\n");
const CALLER = { summary: "deliver does not await drainSpool, so the oracle re-reads a store that is not yet complete", meta: { falsifier_spec: "" } };
const ROW = { summary: "the oracle grades on truncated input with uncontrolled model derivations", meta: { falsifier_spec: "" } };
const NOW = "2000-01-01T00:00:00.000Z";
const mask = (v: unknown) => [{ id: "mask-test-writing-arm-parity", body: { activity_id: TEST_WRITING_ARM_PARITY_ACTIVITY, active_variant: v, from: "2000-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z", by: "operator:test", reason: "fixture" } }];

afterEach(() => __setTestWritingArmParityDepsForTests(null));

describe("which inputs differ", () => {
  it("[MUST-FAIL] the caller's copy and the row differ in the summary, a gate meta key and the ledger's edit site: each is named", () => {
    const caller = { summary: "a", meta: { region: "x", must_fail: "m", check_supply: { edit_site: "src/a.ts" } } };
    const row = { summary: "b", meta: { region: null, must_fail: "m", check_supply: { edit_site: "src/b.ts" } } };
    expect(armInputsDiffer(caller, row)).toEqual(["summary", "region", "check_supply.edit_site"]);
  });
  it("[CONTROL] equal inputs, and a key absent on one side and null on the other, name nothing", () => {
    expect(armInputsDiffer({ summary: "s", meta: { control: "c" } }, { summary: "s", meta: { control: "c", region: null } })).toEqual([]);
  });
});

describe("the region each side derives", () => {
  it("[MUST-FAIL] a summary naming a site identifier derives a region; one naming none derives none", () => {
    const c = armRegionOf(SITE, SITE_REL, CALLER);
    const r = armRegionOf(SITE, SITE_REL, ROW);
    expect(c.anchor).toBe("drainSpool");
    expect(r.anchor).toBeNull();
  });
  it("[CONTROL] an unreadable site derives no region on either side", () => {
    expect(armRegionOf(null, SITE_REL, CALLER)).toEqual({ anchor: null, why: "the edit site is not readable here" });
  });
});

describe("the variant", () => {
  it("[MUST-FAIL] the mask in force sets the variant; none, an unknown variant or an unreadable pool is variant-0", () => {
    __setTestWritingArmParityDepsForTests({ readMasks: () => mask(1) });
    expect(testWritingArmParityVariant(NOW).variant).toBe(1);
    __setTestWritingArmParityDepsForTests({ readMasks: () => mask(7) });
    expect(testWritingArmParityVariant(NOW)).toMatchObject({ variant: 0, why: expect.stringContaining("unknown variant") });
    __setTestWritingArmParityDepsForTests({ readMasks: () => [] });
    expect(testWritingArmParityVariant(NOW)).toEqual({ variant: 0, why: "no mask in force: variant-0" });
    __setTestWritingArmParityDepsForTests({ readMasks: () => { throw new Error("pool down"); } });
    expect(testWritingArmParityVariant(NOW).why).toContain("mask_unread");
  });
});

describe("the decision record", () => {
  const run = (variant: number, row: typeof ROW | null, rowRead = row ? "ok" : "unreadable") => {
    const posted: Array<Record<string, unknown>> = [];
    __setTestWritingArmParityDepsForTests({ postTrace: async (t) => { posted.push(t); return 201; } });
    const rec = armParityDecision({
      gap_id: "g-1", vessel: "repos/v", check_file: "test/checks/g-1.check.ts", edit_site: SITE_REL, variant: { variant, why: "fixture" },
      row_read: rowRead, caller: CALLER, row, siteSrc: SITE,
      gates: { mutation: "refuse: red_independent_of_edit_site: …", region: "measured: changed 1 anchor \"drainSpool\"", region_cancelled_refusal: true },
      refused: null, nowIso: NOW,
    });
    return { rec, posted };
  };
  it("[MUST-FAIL] variant-0 judges by the caller's inputs and records that the regions differ and that the region gate cancelled the refusal", () => {
    const { rec, posted } = run(0, ROW);
    expect(rec).toMatchObject({ variant: 0, judged_by: "caller", row_read: "ok", inputs_differ: ["summary"], region_from_caller: "drainSpool", region_from_row: null, regions_differ: true, region_cancelled_refusal: true, verify: "passed" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ activity_id: TEST_WRITING_ARM_PARITY_ACTIVITY, input_shapes: ["test_suite"], output_shapes: ["testWritingArmParity"] });
    expect((posted[0]!.tags as string[])).toContain("regions_differ:true");
    expect((posted[0]!.metadata as Record<string, unknown>)["testWritingArmParity"]).toEqual(rec);
  });
  it("[MUST-FAIL] variant-1 judges by the row, and by the caller's inputs when the row could not be read", () => {
    expect(run(1, ROW).rec).toMatchObject({ judged_by: "row" });
    expect(run(1, ROW).posted[0]).toMatchObject({ activity_id: `${TEST_WRITING_ARM_PARITY_ACTIVITY}-v1` });
    expect(run(1, null).rec).toMatchObject({ judged_by: "caller", row_read: "unreadable", inputs_differ: [], region_from_row: null, regions_differ: false });
  });
  it("[CONTROL] a trace that cannot be posted does not throw and still returns the record", () => {
    __setTestWritingArmParityDepsForTests({ postTrace: async () => { throw new Error("down"); } });
    const rec = armParityDecision({ gap_id: "", vessel: "repos/v", check_file: "c", edit_site: null, variant: { variant: 0, why: "f" }, row_read: "no_gap_id", caller: CALLER, row: null, siteSrc: null, gates: {}, refused: "red_independent_of_edit_site", nowIso: NOW });
    expect(rec).toMatchObject({ gap_id: null, row_read: "no_gap_id", mutation: "not_run", region_gate: "not_run", verify: "refused: red_independent_of_edit_site" });
  });
});

describe("wiring (source pin)", () => {
  const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function testWritingArmPrecheck("), src.indexOf("// ── development-vessel:test-writing-arm-parity"));
  it("[MUST-FAIL] the precheck reads the row, chooses the inputs by variant, passes them to the arm gates and records every run", () => {
    expect(body).toContain("const row = await readArmRow(gapId);");
    expect(body).toContain("const use = m.variant === 1 && row.inputs ? row.inputs : caller;");
    expect(body).toContain("region: regionOf(use.meta)");
    expect(body).toContain("meta: use.meta, summary: use.summary");
    expect(body).toContain("observe: seen");
    expect(body).toMatch(/armParityDecision\(\{[^\n]*\}\);\n  if \(!arm\) return tw;/);
  });
});
