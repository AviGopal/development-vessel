import { describe, it, expect } from "bun:test";
import { conditionGoneVerdict, conditionGoneWindows } from "../../src/resolvers/condition-gone.js";

/** Fail-closed edges of the condition-gone verdict beyond the check-first test. */
const ADDR = { input_hash: "sha256:sig", org: "organizations:substrate" };
const m = (matched_total: number | null, measured = true) => ({ matched_total, measured, window_hours: 72, address: ADDR });
const BASE = { min_before: 3, min_after_hours: 72, after_window_hours: 72, address: ADDR, signature_kind: "reason_contains" as const, control: { ...m(9043), population: "failed_with_failure_mode" } };

describe("conditionGoneVerdict — fail closed", () => {
  it("invalid policy inputs never close", () => {
    expect(conditionGoneVerdict({ ...BASE, min_before: 0, before: m(6711), after: m(0) }).reason).toBe("policy_invalid");
    expect(conditionGoneVerdict({ ...BASE, after_window_hours: Number.NaN, before: m(6711), after: m(0) }).close).toBe(false);
  });

  it("a missing control is not a positive control", () => {
    const { control: _c, ...noControl } = BASE;
    expect(conditionGoneVerdict({ ...noControl, before: m(6711), after: m(0) }).reason).toBe("unmeasured");
  });

  it("a NaN count is unmeasured, not zero", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(6711), after: m(Number.NaN) }).reason).toBe("unmeasured");
  });

  it("a recorded baseline below the floor does not stand in for the before-window", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: { count: 2, address: ADDR } }).reason).toBe("signature_never_matched");
  });

  it("a close records the numbers it decided on", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(6711), after: m(0) });
    expect(v.before_count).toBe(6711);
    expect(v.after_count).toBe(0);
  });
});

describe("conditionGoneWindows", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  it("the before-window covers everything retained before the after-window, not created_at onward", () => {
    expect(conditionGoneWindows("2026-09-22T07:15:00Z", 72, now)).toEqual({
      after: { window_hours: 72 },
      before: { until_hours_ago: 72, window_hours: 233 + 72 },
    });
  });
  it("an unusable created_at or window gives no windows (the closer reads nothing)", () => {
    expect(conditionGoneWindows("garbage", 72, now)).toBeNull();
    expect(conditionGoneWindows("2026-09-22T07:15:00Z", 0, now)).toBeNull();
  });
});
