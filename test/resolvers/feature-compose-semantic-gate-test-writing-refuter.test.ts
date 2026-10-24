// A TEST-WRITING COMPOSE STILL FACES THE ADVERSARIAL LENS, WITH THE TEST-WRITING QUESTION (qa ruling on the
// test_writing skip of verifyPatchAddressesGap).
//
// The skip judges a test_writing compose by its contract (only the gap's check written, the same assertion red at the
// parent each run) instead of the fix standard. As first built it bypassed the refuter too, so a check red for an
// UNRELATED reason (its own fixture, an invented export, an impossible expectation) would be admitted on the
// deterministic judgement alone. Measured: a gamed check was admitted with only the refuter dissenting, its 1/2 split
// overruled by the fix-standard quorum.
//
// Expected:
//   - MUST-FAIL: a test_writing draft whose judgement is ok but whose refuter answers "fails for an unrelated reason"
//     (refuted, conf >= 0.8) is REFUSED, and the refuter was asked the test-writing question, not the fix question;
//   - MUST-FAIL: a refuter that cannot answer (an outage, or no parseable verdict) fails closed as infrastructure;
//   - CONTROL: the measured admitted shape (the refuter agrees the check fails on the defect) is admitted, and the
//     fix-standard "does this change behaviour" judge is still not consulted;
//   - CONTROL: a low-confidence refutation does not refuse (the fix-standard refuter's specificity bar).
// No LLM (stubs), no network, no writes outside this file's temp root.
import { afterAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT } = await isolateRuntimeRoot("fc-semgate-tw-refuter", { superRepo: true, who: "feature-compose-semantic-gate-test-writing-refuter.test.ts" });
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
const TW = { compose_mode: csa.CHECK_SUPPLY_COMPOSE_MODE, gap_id: GAP, judgement: PASSED, written_paths: [CHECK_ABS] };

type Answer = string | (() => never);
function stub(refuter: Answer) {
  const calls = { fix: 0, refuter: 0, refuterPrompts: [] as string[] };
  const llm = async (prompt: string): Promise<string> => {
    if (prompt.includes("ADVERSARIAL")) {
      calls.refuter++; calls.refuterPrompts.push(prompt);
      return typeof refuter === "function" ? refuter() : refuter;
    }
    calls.fix++;
    return JSON.stringify({ addresses: false, on_live_path: true, reason: "Patch only adds a test" });
  };
  return { calls, llm };
}
const gate = (llm: (p: string) => Promise<string>) => fc.verifyPatchAddressesGap({
  gapSummary: `observe-mode dispatches still mint templates (repos/${VESSEL}/src/index.ts)`,
  gapMeta: { edit_site: `repos/${VESSEL}/src/index.ts` },
  diff: DIFF, reachability: [], llm, runSemanticJudge: true, testWriting: TW,
}) as Promise<Record<string, any>>;
const UNRELATED = JSON.stringify({ refuted: true, confidence: 0.92, reason: "fails for an unrelated reason: observeMintsTemplate is not exported by src/index.ts, so the check is red on a missing name, not on the defect" });

describe("semantic gate, test_writing mode: the refuter still runs, asking whether the check fails because of the defect", () => {
  it("MUST-FAIL: a passed test-writing check that the refuter says fails for an unrelated reason is refused", async () => {
    const { calls, llm } = stub(UNRELATED);
    const v = await gate(llm);
    expect(v.addresses, `admitted: ${String(v.reason)}`).toBe(false);
    expect(String(v.reason)).toContain("fails for an unrelated reason");
    expect(v.skipped).toBeUndefined();
    expect(v.judge_unavailable ?? false).toBe(false);
    expect(calls.refuter).toBe(1);
    expect(calls.refuterPrompts[0]).toContain("FAILING CHECK");
    expect(calls.refuterPrompts[0]).toContain("BECAUSE of the gap's defect");
    expect(calls.fix, "the fix-standard judge is not consulted").toBe(0);
  });
  it("MUST-FAIL: a refuter outage or an unparseable answer fails closed, as infrastructure", async () => {
    for (const a of [() => { throw new Error("llm down"); }, "no verdict here"] as Answer[]) {
      const { llm } = stub(a);
      const v = await gate(llm);
      expect(v.addresses).toBe(false);
      expect(v.judge_unavailable).toBe(true);
      expect(fc.semanticGateInfraRefusal(v)).toBe(true);
    }
  });
  it("CONTROL: the measured admitted shape (the refuter agrees) is admitted, the fix judge still not consulted", async () => {
    const { calls, llm } = stub(JSON.stringify({ refuted: false, confidence: 0.1, reason: "the check fails on the defect the gap names" }));
    const v = await gate(llm);
    expect(v.addresses, `refused: ${String(v.reason)}`).toBe(true);
    expect(v.skipped).toBe("test_writing");
    expect(v.verified).toBe(true);
    expect(calls.refuter).toBe(1);
    expect(calls.fix).toBe(0);
  });
  it("CONTROL: a low-confidence refutation does not refuse", async () => {
    const { llm } = stub(JSON.stringify({ refuted: true, confidence: 0.4, reason: "perhaps the assertion is about something else entirely" }));
    const v = await gate(llm);
    expect(v.addresses).toBe(true);
    expect(v.skipped).toBe("test_writing");
  });
});
