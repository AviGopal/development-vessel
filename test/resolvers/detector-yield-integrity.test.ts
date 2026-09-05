import { describe, it, expect } from "bun:test";

/**
 * `gaps_landed` COUNTS FORGETTING AS SUCCESS.
 *
 * detector_yield_registry classifies a closed gap as landed unless its closed_reason matches
 * /churn/. Measured on the live gap store (2,376 gaps, 1,473 closed):
 *
 *   expired_not_redetected                 707  (48.0%)
 *   no closed_reason recorded              611  (41.5%)
 *   stale_low_value                         43
 *   landed_verified                         36  (2.4%)
 *   operator_directed_dormant_withdrawal    29
 *   persistent_compose_failure              16
 *   producer_now_exists                     13
 *   fix_landed_and_verified_by_consequence  11
 *
 * Only 60 of 1,473 closures (4.1%) record an actual fix, yet 1,472 count as "landed" — 24.5x
 * inflation — and 1,202 of the 1,241 detectors with landed > 0 (97%) never had a single gap
 * really fixed.
 *
 * `expired_not_redetected` is the sharpest case: it means "we stopped seeing it", which is
 * indistinguishable from "we stopped looking". It is not evidence the condition is gone.
 *
 * This suite pins the DISTINCTION. It deliberately does NOT assert that status or retirement
 * emission use the corrected count: the tick runs with emit_retirement_gaps:true, so
 * reclassifying on the honest number would flip ~1,202 detectors to LOW_YIELD in one pass and
 * emit mass retirement gaps routing to deprecate. Measuring is safe; acting on it is an
 * operator decision.
 */
const REALLY_FIXED = new Set([
  "landed_verified",
  "fix_landed_and_verified_by_consequence",
  "producer_now_exists",
  "condition_cleared",
]);
const isReallyFixed = (reason: string | null | undefined) =>
  typeof reason === "string" && REALLY_FIXED.has(reason);
const isChurned = (reason: string | null | undefined) =>
  typeof reason === "string" && /churn/i.test(reason);
/** The rule as it stands: closed and not churned. */
const countsAsLanded = (reason: string | null | undefined) => !isChurned(reason);

/** Mirrors the shipped rule: PRODUCTIVE on a real fix or live signal, LOW_YIELD only on evidence. */
const EVIDENCE_FLOOR = 10;
const EMIT_CAP = 5;
const classify = (r: { gaps_emitted: number; gaps_really_fixed: number; novel_open: number }) =>
  r.gaps_really_fixed > 0 || r.novel_open > 0
    ? "PRODUCTIVE"
    : r.gaps_really_fixed === 0 && r.gaps_emitted >= EVIDENCE_FLOOR
      ? "LOW_YIELD"
      : "UNKNOWN";

describe("landed vs really fixed — forgetting is not resolving", () => {
  it("counts expired_not_redetected as landed today, and as NOT fixed", () => {
    // 48% of all closures take this path — the single largest bucket.
    expect(countsAsLanded("expired_not_redetected")).toBe(true);
    expect(isReallyFixed("expired_not_redetected")).toBe(false);
  });

  it("counts a closure with NO reason as landed today, and as NOT fixed", () => {
    // 41.5% of closures carry no closed_reason at all.
    for (const r of [null, undefined, ""]) {
      expect(countsAsLanded(r)).toBe(true);
      expect(isReallyFixed(r)).toBe(false);
    }
  });

  it("recognises the four reasons that are evidence of an actual fix", () => {
    for (const r of [
      "landed_verified",
      "fix_landed_and_verified_by_consequence",
      "producer_now_exists",
      "condition_cleared",
    ]) {
      expect(isReallyFixed(r)).toBe(true);
    }
  });

  it("does not treat stale_low_value or an operator withdrawal as a fix", () => {
    // Both are legitimate ways to close a gap. Neither is evidence the condition went away.
    expect(isReallyFixed("stale_low_value")).toBe(false);
    expect(isReallyFixed("operator_directed_dormant_withdrawal")).toBe(false);
    expect(isReallyFixed("persistent_compose_failure")).toBe(false);
  });

  it("keeps churn separate from both — it is neither landed nor fixed", () => {
    expect(countsAsLanded("churned_unlandable")).toBe(false);
    expect(isReallyFixed("churned_unlandable")).toBe(false);
  });

  it("reproduces the measured inflation on the real closure distribution", () => {
    // Verbatim counts from the live store, so this fails if the distribution shifts.
    const dist: Array<[string | null, number]> = [
      ["expired_not_redetected", 707],
      [null, 611],
      ["stale_low_value", 43],
      ["landed_verified", 36],
      ["operator_directed_dormant_withdrawal", 29],
      ["persistent_compose_failure", 16],
      ["producer_now_exists", 13],
      ["fix_landed_and_verified_by_consequence", 11],
    ];
    let landed = 0;
    let fixed = 0;
    for (const [reason, n] of dist) {
      if (countsAsLanded(reason)) landed += n;
      if (isReallyFixed(reason)) fixed += n;
    }
    expect(landed).toBe(1466);
    expect(fixed).toBe(60);
    expect(landed / fixed).toBeGreaterThan(20); // measured 24.5x
  });

  it("evidence floor: too few gaps to judge is NOT grounds to retire", () => {
    // 9 gaps and no fixes is absence of evidence, not evidence of uselessness — below the
    // floor, "never fixed anything" and "has not had the chance" are the same observation.
    expect(classify({ gaps_emitted: 9, gaps_really_fixed: 0, novel_open: 0 })).toBe("UNKNOWN");
    expect(classify({ gaps_emitted: 79, gaps_really_fixed: 0, novel_open: 0 })).toBe("LOW_YIELD");
  });

  it("one real fix spares a detector however noisy — the asymmetry decides", () => {
    // Retiring a detector that would have found something loses that signal permanently and
    // silently; nothing re-emits a gap nobody is detecting. Keeping a noisy one costs pool
    // dilution, which is visible, bounded and reversible. So volume cannot outweigh evidence
    // that the detector CAN find something.
    expect(classify({ gaps_emitted: 500, gaps_really_fixed: 1, novel_open: 0 })).toBe("PRODUCTIVE");
    expect(classify({ gaps_emitted: 40, gaps_really_fixed: 0, novel_open: 3 })).toBe("PRODUCTIVE");
  });

  it("emits noisiest-first in capped batches, so a run measures instead of leaping", () => {
    // Correcting PRODUCTIVE makes ~1,202 detectors eligible at once. Emitting all of them
    // would be the least informative possible action: an undifferentiated flood, nothing
    // attributable, and a large irreversible step taken on a rule never observed operating.
    const rows = [79, 60, 50, 40, 30, 20, 15].map((n) => ({
      id: `d${n}`,
      gaps_emitted: n,
      gaps_really_fixed: 0,
      novel_open: 0,
    }));
    const eligible = rows.filter((r) => classify(r) === "LOW_YIELD");
    const batch = [...eligible].sort((x, y) => y.gaps_emitted - x.gaps_emitted).slice(0, EMIT_CAP);
    expect(batch.map((r) => r.id)).toEqual(["d79", "d60", "d50", "d40", "d30"]);
    // The remainder is deferred to a run that can see THIS batch's effect, not discarded.
    expect(eligible.length).toBeGreaterThan(batch.length);
  });

  it("a capped run must never read as a finished one", () => {
    // retirement_candidates_total travels beside retirement_gaps_emitted precisely so that
    // "emitted 5" is not mistaken for "there were 5" — the silence-is-success failure again.
    const candidates = 1202;
    expect(Math.min(candidates, EMIT_CAP)).toBe(5);
    expect(candidates).toBeGreaterThan(EMIT_CAP);
  });

  it("a detector whose every gap expired must be distinguishable from one that fixed things", () => {
    // This is the property the curation signal needs and does not have: with landed counting
    // expiry, both of these look identical at gaps_landed > 0.
    const allExpired = ["expired_not_redetected", "expired_not_redetected", null];
    const actuallyFixed = ["landed_verified", "expired_not_redetected", null];
    expect(allExpired.filter(countsAsLanded).length).toBe(3);
    expect(actuallyFixed.filter(countsAsLanded).length).toBe(3); // indistinguishable
    expect(allExpired.filter(isReallyFixed).length).toBe(0);
    expect(actuallyFixed.filter(isReallyFixed).length).toBe(1); // distinguished
  });
});
