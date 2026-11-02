import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

describe("check supply settlement — an arm_refused row is not a permanent judgement", () => {
  test("an arm_refused row is NOT a settled verdict (JUDGED_NOT_ARMED excludes arm_refused)", () => {
    // The defect: arm_refused is grouped with green_at_head, so a row refused at arm is
    // never re-judged after its cause is fixed; it waits out the backoff and the check
    // is thrown away. Re-judging requires arm_refused NOT to be a settled state.
    expect(mod.JUDGED_NOT_ARMED.has("arm_refused")).toBe(false);
  });

  test("CONTROL: green_at_head remains a settled verdict", () => {
    // green_at_head is correctly settled: re-judging it would only repeat the same HEAD read.
    expect(mod.JUDGED_NOT_ARMED.has("green_at_head")).toBe(true);
  });
});
