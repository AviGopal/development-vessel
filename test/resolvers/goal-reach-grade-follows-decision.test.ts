/**
 * goal_reach_tick: THE GRADE FOLLOWS THE DECISION (one closure rule for both).
 *
 * nextAction re-runs a goal only when a linked gap closed for a REPAIR reason (REALLY_FIXED_REASONS) after the goal's last
 * attempt. gradeTick called a goal "missed_eligible" when its linked gaps had closed for ANY reason, so every tick was graded
 * failure for correctly not re-running goals whose gaps closed by expiry, and the tick template took beta for right behaviour.
 * Both now read closedForRepairSince.
 *
 *   [MUST-FAIL] an expiry-closed linked gap: the decider does not re-run the goal, and the grader records NO missed_eligible.
 *   [CONTROL]   a REALLY_FIXED close the tick did not act on is still missed_eligible (and the decider would re-run it).
 *   [CONTROL]   a linked gap ABSENT from the store does not count as closed: neither eligible nor missed.
 *
 * Fixture goal from a fresh 5-word draw (draw-words.sh):
 *   2026-10-27T07:33:55Z seed=1793086434986597815 words=hamper handyman undefined clear salvage
 */
import { describe, expect, it } from "bun:test";
import {
  goalHashOf,
  observe,
  linkGaps,
  nextAction,
  gradeTick,
  DEFAULT_GOAL_REACH_POLICY,
  type GoalReachRecord,
  type DispatchObservation,
  type GapView,
  type GoalReachPolicy,
  type TickLedger,
} from "../../src/resolvers/goal-reach-tick.js";

const T0 = Date.parse("2026-10-22T10:00:00Z");
const min = (n: number): number => T0 + n * 60_000;
const GOAL = "Find a handyman who can clear the hamper of salvage whose owner is still undefined, and list what can be reused";
const H = goalHashOf(GOAL);
const d = (over: Partial<DispatchObservation> & { dispatchId: string }): DispatchObservation => ({
  goal: GOAL, status: "failed", reached: false, operator: null, trigger: "boredom",
  startedAt: min(0), endedAt: min(1), node: "n", goalReachReason: "judged_hollow", poolShapes: [], completionShapes: null, cost_usd: 0.1, ...over,
});
const link = (dispatch_id: string) => ({ source: "goal_reach" as const, goal_hash: H, dispatch_id, origin: "autonomous" as const });
const closedAs = (id: string, closed_reason: string, at = min(3)): GapView =>
  ({ id, status: "closed", source: "substrate_detected", demand_goals: [link("d1")], closed_reason, closed_at: new Date(at).toISOString(), reopen_count: 0 });
const policy: GoalReachPolicy = { ...DEFAULT_GOAL_REACH_POLICY, max_cycles: 3, dry_run: false };
const ledger = (over: Partial<TickLedger>): TickLedger => ({ at: min(5), dry_run: false, actions: [], eligible: [], errors: [], ...over });
const recordsFrom = (gaps: GapView[]): GoalReachRecord[] => {
  const recs = Object.values(observe({}, [d({ dispatchId: "d1" })], min(5)));
  for (const r of recs) linkGaps(r, gaps);
  return recs;
};
const missed = (reasons: string[]): string[] => reasons.filter((r) => r.startsWith("missed_eligible:"));

describe("gradeTick reads the decider's closure rule", () => {
  it("[MUST-FAIL] an expiry-closed linked gap is correctly not re-run, and the grade records no missed_eligible", () => {
    const g = closedAs("g1", "expired_not_redetected");
    const recs = recordsFrom([g]);
    expect(recs[0]!.linked).toEqual(["g1"]);
    expect(nextAction(recs[0]!, [g], policy)).toEqual({ kind: "none", reason: "no_new_closure" });
    const v = gradeTick(ledger({}), { records: recs, gaps: [g] });
    expect(missed(v.reasons)).toEqual([]);
    expect(v.verdict).toBe("neutral");
  });

  it("[CONTROL] a REALLY_FIXED close the tick did not act on is still missed_eligible", () => {
    const g = closedAs("g1", "landed_verified");
    const recs = recordsFrom([g]);
    expect(nextAction(recs[0]!, [g], policy).kind).toBe("redispatch");
    const v = gradeTick(ledger({}), { records: recs, gaps: [g] });
    expect(v.verdict).toBe("failure");
    expect(missed(v.reasons)).toEqual([`missed_eligible:${H}:all linked gaps closed before the tick`]);
  });

  it("[CONTROL] a linked gap absent from the store does not count as closed: neither eligible nor missed", () => {
    const recs = recordsFrom([]);
    recs[0]!.linked = ["gone-from-the-store"];
    expect(nextAction(recs[0]!, [], policy)).toEqual({ kind: "none", reason: "unlinked" });
    expect(missed(gradeTick(ledger({}), { records: recs, gaps: [] }).reasons)).toEqual([]);
    // an absent gap beside an expiry-closed one: still neither
    const g = closedAs("g1", "expired_not_redetected");
    const recs2 = recordsFrom([g]);
    recs2[0]!.linked = ["g1", "gone-from-the-store"];
    expect(nextAction(recs2[0]!, [g], policy)).toEqual({ kind: "none", reason: "no_new_closure" });
    expect(missed(gradeTick(ledger({}), { records: recs2, gaps: [g] }).reasons)).toEqual([]);
  });
});
