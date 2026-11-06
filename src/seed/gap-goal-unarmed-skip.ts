import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-goal-unarmed-skip — whether boredom-vessel's pool dispatches a gap goal for a row a compose would refuse as
 * unarmed (its edit_site a src/ file), decided in process when such a candidate wins the pool's pick
 * (boredom-vessel src/index.ts pickByShapeAvailability, src/goal-generation.ts decideUnarmedSkip), never dispatched.
 * It produces one gapGoalUnarmedSkip per decision (variant, the winner, what filled the slot). Its grade is decided by
 * its CONSUMER, the gap-goal-unarmed-skip-credit trace: reached = the goal that filled the slot reached (goal-host's
 * verdict for that dispatch), never by its exit. Variant-1 (`<id>-v1`, a child template) fills the slot with the best
 * unflagged candidate of the same ranking; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const GAP_GOAL_UNARMED_SKIP_TEMPLATE: ActivityTemplate = {
  id: "boredom-vessel:gap-goal-unarmed-skip",
  name: "gap-goal-unarmed-skip",
  description:
    "Decides, at a pool pick won by a gap goal for a row a compose would refuse as unarmed, that the goal is " +
    "dispatched as before, and records a gapGoalUnarmedSkip. Graded by its consumer (the goal that filled the slot " +
    "reached), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["gapGoalUnarmedSkip"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "decide-pick",
      description: "Dispatch the flagged winner as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["gapGoalUnarmedSkip"],
    },
  ],
};

export const GAP_GOAL_UNARMED_SKIP_V1_TEMPLATE: ActivityTemplate = {
  id: "boredom-vessel:gap-goal-unarmed-skip-v1",
  name: "gap-goal-unarmed-skip-v1",
  description:
    "Variant of gap-goal-unarmed-skip. A pool pick won by a gap goal for a row a compose would refuse as unarmed is " +
    "filled with the best unflagged candidate of the same ranking instead (none: nothing that pass); dv's check " +
    "supply is the row's producer of a check. Records a gapGoalUnarmedSkip. Graded by its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["gapGoalUnarmedSkip"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "boredom-vessel:gap-goal-unarmed-skip",
  tasks: [
    {
      id: "decide-pick",
      description: "Fill the slot with the best unflagged candidate and record the decision.",
      resolver: "deterministic",
      outputShapes: ["gapGoalUnarmedSkip"],
    },
  ],
};
