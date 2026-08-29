import { describe, it, expect } from "bun:test";
import { isNonAttemptComposeResult } from "../../src/resolvers/gap-to-feature.js";

// Pins the BUSY/capacity distinction at the gap layer.
//
// feature-compose returns verdict:"BUSY" / stage:"capacity" when the compose slot cap is
// hit, and its own comment calls the distinction load-bearing: "BUSY, not REFUSED.
// Capacity is TRANSIENT — the work is fine, the host is full." goal-host honours it
// (backs off 45s and retries). gap-to-feature did not — the string BUSY appeared nowhere
// in it — so a refusal became a plain ok:false and reached bumpFailedAttempts, which BOTH
// decays the gap score and calls updateCalibration(category, false). hopeless() then
// excludes the category at attempts>=8/lands==0, so a run of refusals could seal a whole
// category with no compose ever having run.
//
// Measured 2026-08-29: reach_grounding_gap went 0 -> 5 attempts / 0 lands in ~6h on
// refusals alone; five gaps sat at failed_attempts=2 with outcome.joined_at 200-800ms
// after the pick — far too fast for a compose.
describe("isNonAttemptComposeResult", () => {
  it("treats a BUSY verdict as a non-attempt", () => {
    expect(isNonAttemptComposeResult({ ok: false, verdict: "BUSY", stage: "capacity" })).toBe(true);
  });

  it("treats stage=capacity as a non-attempt even without the verdict", () => {
    // The two are set together today, but neither should be load-bearing alone.
    expect(isNonAttemptComposeResult({ ok: false, stage: "capacity" })).toBe(true);
  });

  it("keeps excluding environment failures, which were already exempt", () => {
    // This was the pre-existing carve-out at the main call site; folding it in here must
    // not change its behaviour.
    expect(isNonAttemptComposeResult({ ok: false, failure_kind: "environment" })).toBe(true);
  });

  it("does NOT exempt a genuine compose failure", () => {
    // The whole point: real failures must still bump, or a gap that cannot be fixed
    // would be retried forever and the calibration would never learn anything.
    expect(isNonAttemptComposeResult({ ok: false, verdict: "UNFAVORABLE" })).toBe(false);
    expect(isNonAttemptComposeResult({ ok: false, verdict: "REFUSED", stage: "scope" })).toBe(false);
    expect(isNonAttemptComposeResult({ ok: false, apply_failed: true })).toBe(false);
  });

  it("does NOT exempt a success", () => {
    expect(isNonAttemptComposeResult({ ok: true, verdict: "FAVORABLE" })).toBe(false);
  });

  it("is null-safe — a missing body is not an excuse to skip the bump", () => {
    // The slice path passes `lastBody`, which is null when the loop never ran. Treating
    // null as a non-attempt would silently stop bumping on an unrelated path.
    expect(isNonAttemptComposeResult(null)).toBe(false);
    expect(isNonAttemptComposeResult(undefined)).toBe(false);
    expect(isNonAttemptComposeResult({})).toBe(false);
  });

  it("distinguishes REFUSED from BUSY — the distinction the fix exists to preserve", () => {
    // REFUSED means "this should not be done" and MUST count against the gap.
    // BUSY means "the host is full" and must not.
    expect(isNonAttemptComposeResult({ verdict: "REFUSED" })).toBe(false);
    expect(isNonAttemptComposeResult({ verdict: "BUSY" })).toBe(true);
  });
});
