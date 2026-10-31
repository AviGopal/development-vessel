import { describe, test, expect } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply.js";
import type { Row } from "../../src/resolvers/compose-placement.js";

describe("gap-check-supply: green_at_head settlement defect", () => {
  test("priorAttemptSentence for green_at_head should return an empty string to allow re-judging", () => {
    const prior: readonly Row[] = [
      {
        state: "green_at_head",
        test_file_rel: "test/checks/some.check.ts",
        // other fields are not read by the part of the function under test
      },
    ];

    const sentence = mod.priorAttemptSentence(prior);

    // This fails. Currently it returns a string like:
    // "An earlier attempt wrote a test in test/checks/some.check.ts, which already PASSES at HEAD, so it does not reproduce the defect: write a dif"
    // The defect is that this message causes the check to be considered settled and not re-judged.
    // The fix should be to return an empty string, allowing the check to be re-evaluated.
    expect(sentence).toBe("");
  });

  test("CONTROL: priorAttemptSentence with no prior attempts should be empty", () => {
    const prior: readonly Row[] = [];
    const sentence = mod.priorAttemptSentence(prior);
    // This should remain true after the fix.
    expect(sentence).toBe("");
  });
});
