// Check supply's outcome ledger keeps the test-writing refusal and tells the next test-writing goal.
// goal-host's reach_reason for a refused check_supply compose opens with a routing prefix and carries the test-writing
// judgement (`test_writing=<stage>: <reason>`) after the verify text; cut at 240 characters from the start, the stage
// was lost, and the next goal was sent the same text. Pure functions of src/resolvers/gap-check-supply.ts; no I/O.
import { describe, expect, test } from "bun:test";
import * as cs from "../../src/resolvers/gap-check-supply.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const LEDGER = { dispatch_id: "d1", last_dispatch_at: new Date(NOW - 3_600_000).toISOString(), test_file: "test/checks/g.check.ts", attempts: 1 };
const PREFIX = "early edit-intent routed to feature_compose; check_supply compose refused at (none) (verdict=UNFAVORABLE): verify failed (development-vessel): ";
const verdictFor = (reach_reason: string) =>
  cs.dispatchVerdict(LEDGER as never, { http: 200, status: "failed", reached: false, reach_reason } as never, NOW, cs.outcomeBoundsOf({}), "node-a") as { kind: string; reason?: string };

describe("check supply: the test-writing refusal reaches the ledger and the next goal", () => {
  test("a long test-writing refusal reason is not truncated", () => {
    const v = verdictFor(PREFIX + "x".repeat(200) + " test_writing=test_writing_check_not_red: MARKER the check passes at HEAD");
    expect(v.kind).toBe("failed");
    expect(v.reason).toContain("test_writing_check_not_red");
    expect(v.reason).toContain("MARKER");
  });

  test("CONTROL: a short reach_reason naming the stage already carries it, and one naming no stage is cut as before", () => {
    const short = verdictFor("check_supply compose refused: test_writing=test_writing_check_wrong_reason: SHORT reason");
    expect(short.reason).toContain("test_writing_check_wrong_reason: SHORT reason");
    const plain = verdictFor(PREFIX + "y".repeat(400));
    expect(plain.reason).toBe(`the goal ended failed, not reached: ${(PREFIX + "y".repeat(400)).trim().slice(0, 240)}`);
  });

  test("a dispatch refused at a test-writing stage is told to the next goal", () => {
    const reason = verdictFor(PREFIX + "x".repeat(200) + " test_writing=test_writing_check_not_red: MARKER the check passes at HEAD").reason!;
    const s = cs.priorAttemptSentence([{ attempt: 1, state: "dispatch_failed", reason, outcome: {} }]);
    expect(s).toBe("An earlier attempt was refused at test-writing: test_writing_check_not_red: MARKER the check passes at HEAD: write a different test that avoids that. ");
  });

  test("CONTROL: a dispatch_failed whose reason names no test-writing stage adds nothing", () => {
    expect(cs.priorAttemptSentence([{ attempt: 1, state: "dispatch_failed", reason: "send_without_id: the goal was sent and the goal-host answered no dispatch id", outcome: {} }])).toBe("");
    const arm = { attempt: 1, state: "arm_refused", reason: "check_no_control: every new test is red at HEAD", titles: ["t1"] };
    const withPlain = [arm, { attempt: 2, state: "dispatch_failed", reason: "the goal ended failed, not reached: lane at capacity", outcome: {} }];
    expect(cs.priorAttemptSentence(withPlain)).toBe(cs.priorAttemptSentence([arm]));
  });

  test("CONTROL: the arm-refusal sentence is unchanged", () => {
    const arm = { attempt: 1, state: "arm_refused", reason: "check_no_control: every new test is red at HEAD", titles: ["t1"] };
    expect(cs.priorAttemptSentence([arm])).toBe('An earlier attempt wrote "t1", which was not accepted (check_no_control: every new test is red at HEAD): write a different test that avoids that. ');
    expect(cs.priorAttemptSentence([{ attempt: 1, state: "green_at_head", reason: "", titles: ["t2"] }])).toBe('An earlier attempt wrote "t2", which already PASSES at HEAD, so it does not reproduce the defect: write a different test whose assertion fails because of the defect. Tests already in the file do not count. ');
  });
});
