// A DRAFT WHOSE OWN CHECK STAYS RED IS A FIX FAILURE, NOT AN ENVIRONMENT NON-ATTEMPT (gap a-draft-whose-own-check-
// stays-red-is-recorded-as-an-environment-non-attempt).
//
// failure_kind was "environment" whenever ANY failed verify entry had a null exit code, empty output, or the text
// "timed out after <n>ms" anywhere in its output. A failed own_check entry carries the WHOLE-suite log of its vessel
// (runVerifySuite: output = raw + detail), and a large suite (activity-api, ~1700 tests) routinely prints bun's
// per-test "this test timed out after 20000ms" line for some slow, unrelated test. So a draft that left its gap's
// own defect tests red was reported as an environment failure, and gap-to-feature's isNonAttemptComposeResult
// treated it as a NON-ATTEMPT: no failed_attempts, no failure lesson, cooldown cleared, the same wrong draft again.
// The own check ran and judged the defect tests red: that is the evidence the environment could run them.

import { describe, it, expect } from "bun:test";
import { composeFailureKind, type VerifyResult } from "../../src/resolvers/feature-compose.js";
import { isNonAttemptComposeResult } from "../../src/judge/gap-eligibility.js";

const SUITE_WITH_A_SLOW_UNRELATED_TEST = [
  "== typecheck ==",
  "TC_EXIT=0",
  "== tests ==",
  "(fail) learner rollup > folds a large window [20001.12ms]",
  "  ^ this test timed out after 20000ms.",
  " 1688 pass",
  " 12 fail",
].join("\n");

const ownRedEntry = (output: string): VerifyResult => ({
  vessel: "activity-api",
  errors: "verify",
  exit_code: 0,
  ok: false,
  output: `${output} | THE GAP'S OWN CHECK IS STILL RED on this draft (its test file run alone): defect A`,
  stage: "own_check",
  own: { test_file: "test/defect.test.ts", failing: [] },
  draft: { own_red: ["defect suite > defect A", "defect suite > defect B"], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK IS STILL RED" },
});

const unrunStage = (vessel: string): VerifyResult => ({ vessel, errors: "verify", exit_code: null, ok: false, output: "", stage: "typecheck" });

const timedOutStage = (vessel: string): VerifyResult => ({
  vessel, errors: "verify", exit_code: 0, ok: false, stage: "tests",
  output: "== tests ==\n(fail) slow > one [240000ms]\n  ^ this test timed out after 240000ms | TEST SUITE PRODUCED NO SUMMARY on two runs",
});

const kind = (verify: VerifyResult[], verdict = "UNFAVORABLE", terminal_refusal: string | null = null, cutover_env_class: string | null = null) =>
  composeFailureKind({ verdict, terminal_refusal, cutover_env_class, verify });

describe("composeFailureKind own check red", () => {
  it("own check red with a timed-out unrelated test in the same suite log is a fix failure", () => {
    expect(kind([ownRedEntry(SUITE_WITH_A_SLOW_UNRELATED_TEST)])).toBe("fix");
  });

  it("own check red plus another vessel stage that never ran is a fix failure", () => {
    expect(kind([ownRedEntry("== tests ==\n 40 pass\n 2 fail"), unrunStage("goal-host")])).toBe("fix");
  });

  it("own check red is an attempt for the lane, not a non-attempt", () => {
    const failure_kind = kind([ownRedEntry(SUITE_WITH_A_SLOW_UNRELATED_TEST), timedOutStage("goal-host")]);
    expect(isNonAttemptComposeResult({ ok: false, verdict: "UNFAVORABLE", failure_kind })).toBe(false);
  });
});

describe("composeFailureKind controls", () => {
  it("own check that did not run plus a timed-out stage stays environment", () => {
    expect(kind([timedOutStage("activity-api")])).toBe("environment");
  });

  it("own check that ran but printed no result plus an unrun stage stays environment", () => {
    const unjudged: VerifyResult = { ...ownRedEntry(""), output: "", exit_code: null, draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK PRODUCED NO RESULT" } };
    expect(kind([unjudged])).toBe("environment");
  });

  it("no own check and a stage that failed to run stays environment", () => {
    expect(kind([unrunStage("activity-api")])).toBe("environment");
    expect(isNonAttemptComposeResult({ failure_kind: kind([unrunStage("activity-api")]) })).toBe(true);
  });

  it("a cutover environment class stays environment without an own check", () => {
    expect(kind([], "UNFAVORABLE", null, "env_change_window_held")).toBe("environment");
  });

  it("a favorable compose has no failure kind", () => {
    expect(kind([], "FAVORABLE")).toBeNull();
  });

  it("a terminal refusal stays terminal_refusal even with the own check red", () => {
    expect(kind([ownRedEntry(SUITE_WITH_A_SLOW_UNRELATED_TEST)], "UNFAVORABLE", "gap_closed")).toBe("terminal_refusal");
  });

  it("a typecheck failure with real error text and no own check is a fix failure", () => {
    expect(kind([{ vessel: "activity-api", errors: "verify", exit_code: 2, ok: false, output: "src/a.ts(1,1): error TS2304: Cannot find name x", stage: "typecheck" }])).toBe("fix");
  });
});
