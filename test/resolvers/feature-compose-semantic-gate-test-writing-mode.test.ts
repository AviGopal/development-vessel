// A TEST-WRITING COMPOSE IS JUDGED BY THE TEST-WRITING CONTRACT, NOT THE FIX STANDARD (gap feature-compose-semantic-
// gate-judges-a-test-writing-check-supply-compose-by-the-fix-standard-…).
//
// Measured (a check-supply dispatch on a live node): a test_writing compose whose only op created the gap's
// test/checks/<gap>.check.ts, and whose test-writing check passed at verify (the same assertion red at the parent, each
// run), was refused at the semantic gate: the LLM judge answered addresses:false, "Patch only adds a test". The gate
// (verifyPatchAddressesGap) never read compose_mode, so it asked the fix question, "does this patch change behaviour?",
// of a compose whose contract is to change none.
//
// Expected:
//   - MUST-FAIL (replay): that draft (one created check file, a passed TestWritingJudgement, a judge stub answering
//     addresses:false "Patch only adds a test") is NOT refused: addresses:true, skipped "test_writing", the judgement as
//     evidence, and the judge is not consulted;
//   - MUST-FAIL (wiring): feature_compose's gate call hands verifyPatchAddressesGap the compose mode, verify's
//     test-writing judgement and every written path;
//   - CONTROL: the same draft in fix mode (no compose_mode) is still refused by the judge, as today;
//   - CONTROL: in test_writing mode, a failed judgement or a written src path does not skip the judge.
// No LLM (the judge is a stub), no network, no writes outside this file's temp root.
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT } = await isolateRuntimeRoot("fc-semgate-tw-mode", { superRepo: true, who: "feature-compose-semantic-gate-test-writing-mode.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

const VESSEL = "development-vessel";
const GAP = "observe-mode-dispatches-still-mint-templates";
const CHECK_REL = csa.checkSupplyCheckPath(GAP) as string;
const CHECK_ABS = `/vessels/${VESSEL}/${CHECK_REL}`;
const CHECK_SRC = [
  'import { describe, it, expect } from "bun:test";',
  'import * as mod from "../../src/index";',
  "describe(\"observe mode\", () => {",
  "  it(\"does not mint a template\", () => {",
  "    expect(mod.observeMintsTemplate({ observe: true })).toBe(false);",
  "  });",
  "});",
].join("\n");
const DIFF = `### NEW FILE ${CHECK_ABS}\n` + CHECK_SRC.split("\n").map((l) => `+${l}`).join("\n");
const PASSED = {
  ok: true, stage: null, reason: "red at the parent, the same assertion each run",
  check_file: CHECK_REL, edit_site: "src/index.ts",
  runs: [1, 2, 3].map(() => ({ verdict: "red", keys: ["observe mode > does not mint a template"], red: ["observe mode > does not mint a template"], unhandled: false })),
};

let judgeCalls = 0;
const judge = async (): Promise<string> => { judgeCalls++; return JSON.stringify({ addresses: false, on_live_path: true, reason: "Patch only adds a test" }); };
function gate(testWriting?: Record<string, unknown>): Promise<Record<string, any>> {
  return fc.verifyPatchAddressesGap({
    gapSummary: `observe-mode dispatches still mint templates (repos/${VESSEL}/src/index.ts)`,
    gapMeta: { edit_site: `repos/${VESSEL}/src/index.ts` },
    diff: DIFF,
    reachability: [],
    llm: judge,
    runSemanticJudge: true,
    ...(testWriting ? { testWriting } : {}),
  });
}

describe("semantic gate, test_writing mode: the test-writing contract, not the fix standard", () => {
  it("MUST-FAIL (replay): a passed test-writing check that only creates the gap's check is not refused by the fix judge", async () => {
    judgeCalls = 0;
    const v = await gate({ compose_mode: csa.CHECK_SUPPLY_COMPOSE_MODE, gap_id: GAP, judgement: PASSED, written_paths: [CHECK_ABS] });
    expect(v.addresses, `refused: ${String(v.reason)}`).toBe(true);
    expect(v.skipped).toBe("test_writing");
    expect(v.llm_consulted).toBe(false);
    expect(v.hard_fail ?? false).toBe(false);
    expect(v.test_writing).toEqual({ check_file: CHECK_REL, edit_site: "src/index.ts", runs: 3 });
    expect(judgeCalls, "the fix-standard judge is not consulted").toBe(0);
  });
  it("MUST-FAIL (wiring): feature_compose's gate call passes the mode, verify's test-writing judgement and the written paths", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const call = src.slice(src.indexOf("inertLiteralRefusal ?? await verifyPatchAddressesGap({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toMatch(/testWriting: \{\s*compose_mode: \(pointer as \{ compose_mode\?: unknown \}\)\.compose_mode,/);
    expect(args).toContain("judgement: verify.find((vr) => vr.test_writing)?.test_writing ?? null,");
    expect(args).toContain("written_paths: [...applied.filter((a) => a.ok).map((a) => a.path), ...edited, ...created],");
  });
  it("CONTROL: the same draft in fix mode is still refused by the judge", async () => {
    judgeCalls = 0;
    const v = await gate({ compose_mode: undefined, gap_id: GAP, judgement: null, written_paths: [CHECK_ABS] });
    expect(v.addresses).toBe(false);
    expect(String(v.reason)).toContain("Patch only adds a test");
    expect(v.skipped).toBeUndefined();
    expect(judgeCalls).toBe(1);
    const bare = await gate();
    expect(bare.addresses).toBe(false);
    expect(String(bare.reason)).toContain("Patch only adds a test");
  });
  it("CONTROL: test_writing mode with a failed judgement, or a written src path, still goes to the judge", async () => {
    const failed = await gate({ compose_mode: csa.CHECK_SUPPLY_COMPOSE_MODE, gap_id: GAP, judgement: { ...PASSED, ok: false, stage: "test_writing_check_not_red" }, written_paths: [CHECK_ABS] });
    expect(failed.addresses).toBe(false);
    expect(failed.skipped).toBeUndefined();
    const strayed = await gate({ compose_mode: csa.CHECK_SUPPLY_COMPOSE_MODE, gap_id: GAP, judgement: PASSED, written_paths: [CHECK_ABS, `/vessels/${VESSEL}/src/index.ts`] });
    expect(strayed.addresses).toBe(false);
    expect(strayed.skipped).toBeUndefined();
  });
});
