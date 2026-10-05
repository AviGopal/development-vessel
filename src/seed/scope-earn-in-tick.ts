import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * scope-earn-in-tick — deterministic single-resolver wrapper around scope_earn_in_tick, so applying the adopted
 * scope earn-in criterion is an activity the loop can select and grade (law 2). The resolver reads its own family's
 * timeShapedRhythm ("scope-earn-in") and does nothing when the family has no rhythm or is not due (law 5). Per tick it
 * judges each excluded file by the criterion (every historical regression maps to an armed must-fail that reddens
 * when the guard commit is reverted on the accepted tree) and PROPOSES a scope change as an autonomyScopeProposal; it
 * never writes autonomyScope. A proposal is applied only by the accepted evaluator (scope_earn_in_apply), which
 * re-derives the evidence itself. No LLM here.
 */
export const SCOPE_EARN_IN_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:scope-earn-in-tick",
  name: "scope-earn-in-tick",
  description:
    "Proposes autonomy-scope changes by the adopted earn-in criterion: an excluded file whose every regression maps to " +
    "an armed must-fail that goes red when its guard commit is reverted (a mutation run on the accepted tree) is proposed " +
    "for widening; an in-scope file with an open, unreverted regression is proposed for a TTL tightening. Never proposes " +
    "runtime glue executed from the clone. Never writes autonomyScope: the accepted evaluator applies proposals. " +
    "Cadence, per-tick bound and TTL come from the scope-earn-in timeShapedRhythm.",
  inputShapes: [],
  outputShapes: ["scopeEarnInReport", "autonomyScopeProposal"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template", "phase:scope"],
  variables: [],
  tasks: [
    {
      id: "propose_scope_changes",
      description: "Invoke scope_earn_in_tick; it gates itself on the scope-earn-in rhythm.",
      resolver: "scope_earn_in_tick",
      config: { type: "scope_earn_in_tick" },
      outputShapes: ["scopeEarnInReport"],
    },
  ],
};
