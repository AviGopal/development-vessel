import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * goal-reach-tick — the goal-reach seam (resolvers/goal-reach-tick.ts) as a selectable, graded activity.
 *
 * SELECTED the way gap-lifecycle-tick is: tagged boredom_target_template, so boredom-vessel's
 * shape-driven selector can pick it and dispatch it through light-dispatch. That selector scores
 * input-shape availability and the Thompson posterior; it does NOT see the seam's condition, so the
 * condition and its min_interval_s floor (goalReachPolicy) are a cheap gate inside the resolver: a
 * selection with nothing eligible returns an idle result without reading the gap store.
 *
 * GRADED ON EFFECT, one tick late: each run grades the previous run's actions against the state it
 * observes (gradeTick) and carries the verdict on its own result (carryGrade): a failure grade fails
 * this task; success/idle return the declared shape with information_yield.
 *
 * Starts in DRY-RUN (goalReachPolicy.dry_run defaults true): it logs `[goal-reach] DRY-RUN would …`
 * and grades the would-actions, so the posterior is earned before any live re-dispatch.
 */
export const GOAL_REACH_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:goal-reach-tick",
  name: "goal-reach-tick",
  description:
    "Goal-reach seam: parks non-reached goals on their linked prerequisite gaps, re-dispatches a goal " +
    "when every linked gap has closed, stops goals on futility/budget/scope with a recorded reason, and " +
    "measures whether reaches became templates. Gated by a cheap condition + min interval; graded on " +
    "the effect of the previous run. Dry-run until goalReachPolicy.dry_run is set false.",
  inputShapes: [],
  outputShapes: ["goalReachTickResult"],
  tags: ["lift.autonomous.loop", "goal_reach", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "goal_reach_tick",
      description: "Run goal_reach_tick: gate on the caller condition, act (or dry-run), grade the previous run.",
      resolver: "goal_reach_tick",
      config: { type: "goal_reach_tick" },
      outputShapes: ["goalReachTickResult"],
    },
  ],
};
