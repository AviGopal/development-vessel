// Pins the DIRECTION of the rhythm posterior.
//
// THE FAILURE THIS EXISTS FOR: `beta` was read when computing a family's credit_mean, and
// carefully preserved on every write-back, and no code path anywhere incremented it. The
// only settlement was `alpha + 0.5` on fire. So credit_mean = alpha/(alpha+beta) could only
// ever climb, and due_score with it — a family that had NEVER been dispatchable kept gaining
// due-ness alongside one that worked every tick. The registry recorded how often the
// conductor tried, and called it evidence of how well it worked.
//
// It was invisible for the usual reason: the write was one line inside a loop, the preserved
// `beta` looked like care rather than an unused field, and nothing downstream complained
// because a monotonically rising posterior is indistinguishable from a healthy one until you
// look for the decrement and find there is no code that could produce it.
//
// WHAT THE POSTERIOR MEANS: it grades the conductor's ability to get this family's work
// SCHEDULED, not whether that work then succeeds — the dispatched goal carries its own
// posterior. Conflating them would penalise a correctly-scheduled family for a downstream
// failure it cannot control, and make cadence hostage to execution quality.
import { describe, expect, test } from "bun:test";
import { rhythmSettlementOverlay } from "../../src/resolvers/rhythm-conductor-tick";

describe("rhythmSettlementOverlay", () => {
  test("the alpha leg credits AND decays staleness — demand was answered", () => {
    expect(rhythmSettlementOverlay("alpha", 2, 1, 10)).toEqual({ alpha: 2.5, staleness: 3 });
  });

  test("the beta leg moves beta — THE REGRESSION: this direction did not exist", () => {
    // If this returns anything without a raised `beta`, the penalty leg is gone again and
    // every family's credit is once more a count of attempts.
    expect(rhythmSettlementOverlay("beta", 2, 1, 10)).toEqual({ beta: 1.5 });
  });

  test("the beta leg does NOT decay staleness — a failed dispatch did not answer demand", () => {
    // Decaying here would silence exactly the families that need attention most: a family
    // that could not be dispatched would go quiet as though it had been handled.
    const overlay = rhythmSettlementOverlay("beta", 2, 1, 10) as Record<string, number>;
    expect(overlay["staleness"]).toBeUndefined();
  });

  test("the beta leg does not touch alpha, and the alpha leg does not touch beta", () => {
    // Each settlement moves one side. A leg that wrote both would let a single tick both
    // reward and punish, which makes the posterior unreadable.
    const a = rhythmSettlementOverlay("alpha", 2, 1, 10) as Record<string, number>;
    const b = rhythmSettlementOverlay("beta", 2, 1, 10) as Record<string, number>;
    expect(a["beta"]).toBeUndefined();
    expect(b["alpha"]).toBeUndefined();
  });

  test("credit_mean FALLS across repeated failures — the property that was unreachable", () => {
    // The end-to-end invariant, stated as the selector actually consumes it. Before the
    // penalty leg existed this sequence was not expressible: beta was frozen, so no number
    // of consecutive failures could reduce a family's standing.
    let alpha = 1, beta = 1;
    const mean = () => alpha / (alpha + beta);
    const before = mean();
    for (let i = 0; i < 4; i++) {
      beta = (rhythmSettlementOverlay("beta", alpha, beta, 5) as { beta: number }).beta;
    }
    expect(mean()).toBeLessThan(before);
  });

  test("staleness decay is clamped at zero", () => {
    const o = rhythmSettlementOverlay("alpha", 1, 1, 0) as { staleness: number };
    expect(o.staleness).toBe(0);
    expect(o.staleness).toBeGreaterThanOrEqual(0);
  });
});
