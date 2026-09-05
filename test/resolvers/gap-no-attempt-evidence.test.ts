import { describe, it, expect } from "bun:test";
import { hasNoAttemptEvidence } from "../../src/resolvers/gap-lifecycle-scan.js";

/**
 * ATTRITION, NOT AUTHORING DIFFICULTY.
 *
 * Expiry asserts "reality stopped re-detecting this". A gap nobody ever composed has not
 * been tested against reality at all, so closing it as `expired_not_redetected` asserts a
 * test that never ran — and destroys the evidence that would show whether the category is
 * landable, while feeding updateCalibration nothing.
 *
 * Measured on the live store 2026-09-05, n=450 `missing_capability` gaps:
 *   369/450 (82.0%) closed `expired_not_redetected`
 *    18/450 ( 4.0%) ever produced a compose artifact
 * Control, n=373 `edit_intent_route`: 310/373 (83.1%) produced an artifact, 30.6% expired.
 *
 * So capability work is not losing at compose time — it never reaches compose.
 *
 * WHY TWO SIGNALS. Either alone is ambiguous. A missing `failed_attempts` counter does NOT
 * mean "never attempted": for `edit_intent_route`, 85.4% of gaps lacking that field still
 * carry a compose artifact, because the field records FAILURES and those gaps succeeded.
 * The two signals agree only in the genuinely-unattempted case, which is what makes the
 * inference safe. `approach_decisions` became trustworthy as a second signal only after
 * `joinDecisionOutcome` was fixed (dfc6d04) to record terminal outcomes instead of
 * dropping them.
 */
describe("hasNoAttemptEvidence — two signals must agree before we call a gap unattempted", () => {
  it("is TRUE for a gap with neither signal — the population that must not be expired", () => {
    expect(hasNoAttemptEvidence({ id: "g1", classification_metadata: {} })).toBe(true);
  });

  it("is TRUE when there is no classification_metadata at all", () => {
    // 341 of 450 missing_capability gaps were in roughly this state.
    expect(hasNoAttemptEvidence({ id: "g2" })).toBe(true);
  });

  it("is FALSE when failed_attempts is positive", () => {
    expect(hasNoAttemptEvidence({ classification_metadata: { failed_attempts: 1 } })).toBe(false);
    expect(hasNoAttemptEvidence({ classification_metadata: { failed_attempts: 4 } })).toBe(false);
  });

  it("is TRUE when failed_attempts is present but zero — zero failures is not evidence of an attempt", () => {
    expect(hasNoAttemptEvidence({ classification_metadata: { failed_attempts: 0 } })).toBe(true);
  });

  it("is FALSE when approach_decisions carries at least one entry", () => {
    expect(
      hasNoAttemptEvidence({
        classification_metadata: { approach_decisions: [{ at: "2026-09-01T00:00:00.000Z" }] },
      }),
    ).toBe(false);
  });

  it("is TRUE when approach_decisions exists but is EMPTY — an empty list records no attempt", () => {
    expect(hasNoAttemptEvidence({ classification_metadata: { approach_decisions: [] } })).toBe(true);
  });

  it("is FALSE when either signal fires, even if the other is absent", () => {
    // failed_attempts only
    expect(hasNoAttemptEvidence({ classification_metadata: { failed_attempts: 2 } })).toBe(false);
    // approach_decisions only — the shape a cutover landing now leaves after dfc6d04
    expect(
      hasNoAttemptEvidence({
        classification_metadata: {
          approach_decisions: [{ appended_by: "joinDecisionOutcome", outcome: { landed: true } }],
        },
      }),
    ).toBe(false);
  });

  it("does not throw on null, undefined, or a non-object", () => {
    expect(() => hasNoAttemptEvidence(null)).not.toThrow();
    expect(() => hasNoAttemptEvidence(undefined)).not.toThrow();
    expect(hasNoAttemptEvidence(null)).toBe(true);
    expect(hasNoAttemptEvidence(undefined)).toBe(true);
  });

  it("treats a non-numeric failed_attempts as no evidence rather than crashing", () => {
    // Defensive: the store is written by many callers and has carried junk before.
    expect(hasNoAttemptEvidence({ classification_metadata: { failed_attempts: "oops" } })).toBe(true);
  });

  it("treats a non-array approach_decisions as no evidence", () => {
    expect(hasNoAttemptEvidence({ classification_metadata: { approach_decisions: "nope" } })).toBe(true);
  });
});
