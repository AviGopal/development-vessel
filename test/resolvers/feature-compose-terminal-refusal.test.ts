import { describe, expect, test } from "bun:test";
import { checkContractBreach, isTerminalRefusal } from "../../src/resolvers/feature-compose";
import { requeueAfterNonAttempt } from "../../src/resolvers/gap-to-feature";
import { OWN_GREEN_ADMISSION_TTL_MS, greenOnParentFresh, isNonAttemptComposeResult, isTerminalRefusalResult } from "../../src/judge/gap-eligibility";

// A refusal no repair attempt can change must stop the compose instead of re-drafting (2026-09-30:
// a fixed and closed gap was re-composed for 40 min, every draft refused "already GREEN on the parent").
describe("isTerminalRefusal", () => {
  test("a gap already closed in the store is terminal", () => {
    expect(isTerminalRefusal(null, true)).toBe("the gap is already CLOSED in the store");
  });

  test("an own check already green on the parent is terminal", () => {
    const breach = checkContractBreach([], 34, 23);
    expect(breach).not.toBeNull();
    expect(isTerminalRefusal(breach, false)).toBe(breach);
  });

  test("a draft that runs fewer assertions is NOT terminal (a repair can restore them)", () => {
    const breach = checkContractBreach(["the named test"], 34, 23);
    expect(breach).toContain("FEWER assertions");
    expect(isTerminalRefusal(breach, false)).toBeNull();
  });

  test("no breach on an open gap is not terminal", () => {
    expect(isTerminalRefusal(null, false)).toBeNull();
  });

  test("an unjudgeable parent (null) is not terminal", () => {
    expect(checkContractBreach(null, null, 12)).toBeNull();
    expect(isTerminalRefusal(null, false)).toBeNull();
  });
});


// gap-to-feature handles a terminal refusal EXPLICITLY: the compose ran, so it is not a non-attempt (no 45 s
// requeue, no cooldown release), and no repair can change it, so it never bumps, narrows or decomposes. An
// open gap whose own check is green on the parent is held out of admission for a TTL instead of re-picked.
describe("gap-to-feature and terminal refusals", () => {
  const terminal = { verdict: "UNFAVORABLE", failure_kind: "terminal_refusal", terminal_refusal: "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft" };
  test("a terminal refusal is detected", () => {
    expect(isTerminalRefusalResult(terminal)).toBe(true);
    expect(isTerminalRefusalResult({ verdict: "UNFAVORABLE", failure_kind: "fix" })).toBe(false);
  });
  test("a terminal refusal is NOT a non-attempt, so it is not short-requeued", () => {
    expect(isNonAttemptComposeResult(terminal)).toBe(false);
    const stamps = new Map<string, number>([["g", 1000]]);
    expect(requeueAfterNonAttempt(stamps, "g", terminal, { nowMs: 5000 })).toBe(false);
    expect(stamps.get("g")).toBe(1000);
  });
  test("green-on-parent marker holds a gap out of admission for the TTL only", () => {
    const at = "2026-09-30T12:00:00.000Z"; const t0 = Date.parse(at);
    expect(greenOnParentFresh({ own_check_green_on_parent: { at } }, t0 + 60_000)).toBe(true);
    expect(greenOnParentFresh({ own_check_green_on_parent: { at } }, t0 + OWN_GREEN_ADMISSION_TTL_MS + 1)).toBe(false);
    expect(greenOnParentFresh({}, t0)).toBe(false);
  });
});
