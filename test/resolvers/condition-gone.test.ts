import { describe, it, expect } from "bun:test";
import { conditionGoneVerdict } from "../../src/resolvers/condition-gone.js";

/**
 * CHECK-FIRST (slice Y, step Y3a): a gap closes when its failure SIGNATURE has disappeared over
 * a window, recorded close_basis "condition_gone" — and that close is never counted as a fix.
 *
 * Gaps outlive their failures: the "fetch() URL is invalid" signature matched 6,853 `execution`
 * rows 09-25 17:10Z → 09-28 13:05Z and 0 in the 72h before 10-02, yet its gaps are still open,
 * because every closer reads gap AGE (expired_not_redetected, stale_low_value) or a LANDING
 * (landed_verified). A fix that works is indistinguishable from one that did not.
 *
 * This is the pure verdict; the wiring (gap_lifecycle_scan, autonomy-excluded) is an operator
 * step. Inputs are two traceAggregateReport answers for the gap's own class2 signature: the
 * BEFORE window and the AFTER window, plus a CONTROL (the filtered population's count through the same
 * address, restricted to the population the signature is drawn from) so a mis-scoped read cannot
 * pass for absence.
 */

// Every read echoes its window and the address it was read through (input hash + org); the
// verdict refuses reads that do not match the caller's window and address (qa15).
const ADDR = { input_hash: "sha256:url-is-invalid", org: "organizations:substrate" };
const m = (matched_total: number | null, measured = true, window_hours = 72) => ({ matched_total, measured, window_hours, address: ADDR });
// control: the FILTERED population through the same call over the after-window: failed rows that
// carry a failure_mode (this signature is a reason_contains signature), not raw traffic.
const ctl = (matched_total: number | null, measured = true) => ({ ...m(matched_total, measured), population: "failed_with_failure_mode" as const });
const BASE = { min_before: 3, min_after_hours: 72, after_window_hours: 72, address: ADDR, signature_kind: "reason_contains" as const, control: ctl(9043) };

describe("conditionGoneVerdict", () => {
  it("POSITIVE CONTROL: the URL-is-invalid signature (6,711 before, 0 after) closes as condition_gone", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(6711), after: m(0) });
    expect(v.close).toBe(true);
    expect(v.close_basis).toBe("condition_gone");
    expect(v.closed_reason).toBe("condition_gone");
  });

  it("a condition_gone close is NEVER labelled a fix (only landing:<sha> counts, and only the landing sweep writes it)", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(6711), after: m(0), landing_sha: "6c98916cbcaf8d056ee59a04eb58ce51d99395a3" });
    expect(v.closed_reason).not.toBe("landed_verified");
    expect(v.counts_as_fix).toBe(false);
    expect(v.close_basis).toBe("condition_gone");
  });

  it("MUST-FAIL: a signature that never matched (address fault) does not close", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(0), after: m(0) });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("signature_never_matched");
  });

  it("an unmeasured window (query failed, dead table) does not close — a silent zero is not absence", () => {
    expect(conditionGoneVerdict({ ...BASE, before: m(6711), after: m(null, false) }).close).toBe(false);
    expect(conditionGoneVerdict({ ...BASE, before: m(null, false), after: m(0) }).close).toBe(false);
  });

  it("a signature still present does not close", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(6711), after: m(1) });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("still_present");
  });

  it("an after-window shorter than the policy minimum does not close", () => {
    const v = conditionGoneVerdict({ ...BASE, after_window_hours: 6, before: m(6711), after: m(0, true, 6), control: { ...ctl(9043), window_hours: 6 } });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("after_window_too_short");
  });

  it("an evicted before-window falls back to the baseline the gap recorded at filing", () => {
    const v = conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: { count: 6853, address: ADDR }, control: ctl(9043) });
    expect(v.close).toBe(true);
    expect(v.before_basis).toBe("recorded_baseline");
  });

  it("MUST-FAIL: a zero after-window through an address that sees NO traces at all (wrong org, dead table) does not close, even with a recorded baseline", () => {
    // The closer reads through an ApiKey (org-scoped) path; a mis-scoped read answers 0 measured:true.
    // A positive control through the SAME call — failed rows carrying a failure_mode over the after-window — must be > 0.
    const v = conditionGoneVerdict({ ...BASE, before: m(0), after: m(0), recorded_baseline: { count: 6853, address: ADDR }, control: ctl(0) });
    expect(v.close).toBe(false);
    expect(v.reason).toBe("control_saw_nothing");
    expect(conditionGoneVerdict({ ...BASE, before: m(6711), after: m(0), control: ctl(null, false) }).close).toBe(false);
  });
});
