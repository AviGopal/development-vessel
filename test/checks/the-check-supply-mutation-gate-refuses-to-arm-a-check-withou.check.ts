import { describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/gap-check-supply";

describe("check-supply mutation gate refusal is surfaced to the evaluator (REALIGNMENT §2.1, law 8)", () => {
  test("arm_refused with red_independent_of_edit_site is classified as a 'refused' outcome with its reason", () => {
    // Simulate the ledger write produced by the edit-site mutation gate's refusal path.
    const body = {
      state: "arm_refused",
      reason: "red_independent_of_edit_site",
      mutation_gate: { kind: "refuse", reason: "red_independent_of_edit_site" },
    };
    const k = mod.outcomeKindOf(body);
    // EXPECTATION: the evaluator can SEE a refusal now, with its reason.
    expect(k).not.toBeNull();
    expect(k!.kind).toBe("refused");
    expect(k!.refuse_class).toBe("red_independent_of_edit_site");
  });
});
