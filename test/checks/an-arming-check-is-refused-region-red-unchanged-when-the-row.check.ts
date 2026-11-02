import * as mod from "../../src/resolvers/gap-check-supply";
import { describe, expect, test } from "bun:test";
import type { Row } from "../../src/resolvers/types";

describe("region_red_unchanged check refusal", () => {
  test("when gap row names a caller of the defective function, arm_refused with region_red_unchanged", () => {
    const row: Row = {
      call_path: "gap-check-supply.ts:2462",
      region: "the check's red survives replacing the gap's region",
      "red_reason": { error: "test failed", expected: "correct value", received: "wrong value" }
    };
    
    const outcome = mod.mutationGateVerdict(
      row,
      [{ mutant: { original: "test", replacement: "fix", line: 2462 }, report: row }],
      ["testName"]
    );
    
    expect(outcome).toHaveProperty("reason");
    expect(outcome.reason).toInclude("region_red_unchanged");
    expect(outcome.reason).toInclude("arm_refused");
  });

  test("CONTROL: when gap row does not name a caller, arm_allowed", () => {
    const row: Row = {
      call_path: "some-other-file.ts:42",
      region: "normal region",
      "red_reason": { error: "test failed", expected: "correct value", received: "wrong value" }
    };
    
    const outcome = mod.mutationGateVerdict(
      row,
      [{ mutant: { original: "test", replacement: "fix", line: 42 }, report: row }],
      ["testName"]
    );
    
    expect(outcome).not.toHaveProperty("reason");
    expect(outcome).toHaveProperty("changed", 1);
  });
});
