/**
 * causal-adjudication — turn an after-only reading into a before/after verdict.
 *
 * THE DEFECT THIS EXISTS FOR. A Class-2 falsifier names a shape the sweep can re-resolve and a
 * field to read. That answers "is the defect present NOW?" and nothing else. With no value
 * recorded when the gap was written, two very different worlds are indistinguishable:
 *
 *     was present, now absent   — the action changed something. The fix worked.
 *     never present at all      — the predicate was inert from the start. Closing on this is a
 *                                 FALSE CLOSE, and it looks exactly like success.
 *
 * substrate-gap.ts already records the danger in its own words: a derived literal "read
 * 'present' by construction and manufactured re-lands". The remedy it applied was to stop
 * deriving predicates. The remaining half is to stop reading them without a baseline.
 *
 * WHY THIS IS THE CAUSAL PIECE AND THE SNAPSHOT LEDGER IS NOT. A history of snapshots makes
 * CORRELATION visible: rung 3 broke at 23:43, and some composes landed near then. Correlation
 * over traces is partly effect-as-cause, because the system mints structure from its own
 * successes. What distinguishes the two is a counterfactual fixed BEFORE the action — a value
 * that could have come out either way, recorded when nobody yet knew which. That is what a
 * baseline is, and it is why the baseline must be stamped at write time rather than
 * reconstructed afterwards from whatever the store happens to hold.
 *
 * HORIZONS ARE PLURAL ON PURPOSE. An effect that appears within a minute and one that appears
 * after a day are different claims about mechanism, and a single deadline collapses them. An
 * unelapsed horizon is PENDING, never "refuted" — refusing to conclude early is the whole
 * value of having declared the horizon in advance.
 */

/** What the predicate read at a point in time. `null` means it could not be measured. */
export type Observation = { present: boolean } | null;

export type Verdict =
  | "confirmed" // present before, absent after — the action is associated with the change
  | "refuted" // present before, still present after — the action did not clear it
  | "never_present" // absent before AND after — the predicate was inert; closing here is a false close
  | "regressed" // absent before, present after — the action introduced the condition
  | "pending" // the horizon has not elapsed; concluding now would be guessing
  | "inconclusive"; // a reading is missing; absence of measurement is not a verdict

export interface Adjudication {
  verdict: Verdict;
  horizon: string;
  /** Plain statement of what was compared, so a verdict never has to be taken on trust. */
  detail: string;
  /** True only for "confirmed" — the single case that is evidence the action did something. */
  supports_causal_claim: boolean;
}

/**
 * PURE. Compare a baseline taken before the action against a reading taken after it.
 *
 * `horizonElapsed` is passed in rather than computed from a clock so the decision is testable
 * and so this file holds no hidden dependency on wall time.
 */
export function adjudicate(
  baseline: Observation,
  current: Observation,
  horizon: string,
  horizonElapsed: boolean,
): Adjudication {
  const mk = (verdict: Verdict, detail: string): Adjudication => ({
    verdict,
    horizon,
    detail,
    supports_causal_claim: verdict === "confirmed",
  });

  // Order matters. An unmeasurable reading outranks an unelapsed horizon: if we cannot see the
  // value at all, waiting longer changes nothing about THIS observation, and reporting
  // "pending" would promise a verdict that no amount of time can produce.
  if (baseline === null) {
    return mk(
      "inconclusive",
      "no baseline was recorded before the action — the after-reading alone cannot distinguish a fix from a condition that was never present",
    );
  }
  if (current === null) {
    return mk("inconclusive", "the predicate could not be measured now; absence of measurement is not a verdict");
  }
  if (!horizonElapsed) {
    return mk(
      "pending",
      `both readings exist but the ${horizon} horizon has not elapsed — concluding now would discard the reason for declaring a horizon`,
    );
  }
  if (baseline.present && !current.present) {
    return mk("confirmed", `present before the action, absent after it, at ${horizon}`);
  }
  if (baseline.present && current.present) {
    return mk("refuted", `present before AND after at ${horizon} — the action did not clear the condition`);
  }
  if (!baseline.present && !current.present) {
    return mk(
      "never_present",
      `absent before AND after at ${horizon} — the predicate was inert, and closing on it would be a false close that looks identical to success`,
    );
  }
  return mk("regressed", `absent before the action, present after it, at ${horizon} — the action introduced the condition`);
}

/**
 * Adjudicate one prediction across every horizon it declared.
 *
 * A claim confirmed at one hour and refuted at a day is not a contradiction — it is a
 * statement about how long the effect lasted, and collapsing it to a single verdict throws
 * that away. The summary therefore reports the horizons separately AND the earliest horizon at
 * which the claim was confirmed, which is the one that bounds the mechanism.
 */
export function adjudicateAll(
  baseline: Observation,
  readings: Array<{ horizon: string; elapsed: boolean; observation: Observation }>,
): {
  per_horizon: Adjudication[];
  confirmed_at: string | null;
  any_regression: boolean;
  all_pending: boolean;
} {
  const per_horizon = readings.map((r) => adjudicate(baseline, r.observation, r.horizon, r.elapsed));
  const firstConfirmed = per_horizon.find((a) => a.verdict === "confirmed");
  return {
    per_horizon,
    confirmed_at: firstConfirmed ? firstConfirmed.horizon : null,
    any_regression: per_horizon.some((a) => a.verdict === "regressed"),
    all_pending: per_horizon.length > 0 && per_horizon.every((a) => a.verdict === "pending"),
  };
}
