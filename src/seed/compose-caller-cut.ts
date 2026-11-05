import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * compose-caller-cut — what a feature_compose does when the goal-host dispatch that asked for it stops waiting (the
 * client drops the connection), decided at the compose's cooperative checkpoints (src/resolvers/feature-compose.ts
 * callerCutCheckpoint), in process, never dispatched. It produces one composeCallerCut per observed cut (dispatch,
 * gap, checkpoint, lane, cut and observed times). Its grade is decided by its CONSUMER, the
 * compose-caller-cut-credit trace: reached = the next compose acquire of the same slot class on this node within
 * 30 min was admitted (the slot the cut could free was used), never by its exit. Variant-1 (`<id>-v1`, a child
 * template) stops the goal-host compose at that checkpoint; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const COMPOSE_CALLER_CUT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:compose-caller-cut",
  name: "compose-caller-cut",
  description:
    "Observes, at a compose's checkpoints, that the goal-host dispatch which asked for it stopped waiting, and records a " +
    "composeCallerCut; the compose goes on as before. Graded by its consumer (the next compose of its slot class on this " +
    "node was admitted), never at exit.",
  inputShapes: ["featureComposeReport"],
  outputShapes: ["composeCallerCut"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "observe-cut",
      description: "Record the cut at the first checkpoint that sees it; the compose continues (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["composeCallerCut"],
    },
  ],
};

export const COMPOSE_CALLER_CUT_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:compose-caller-cut-v1",
  name: "compose-caller-cut-v1",
  description:
    "Variant of compose-caller-cut. A goal-host compose whose caller stopped waiting stops at its next checkpoint before " +
    "drafting or before a repair round, with the verdict CALLER_GONE, releasing its workspace, slot and landing lease; a " +
    "compose past its verify still lands. Records a composeCallerCut. Graded by its consumer, never at exit.",
  inputShapes: ["featureComposeReport"],
  outputShapes: ["composeCallerCut"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:compose-caller-cut",
  tasks: [
    {
      id: "observe-cut",
      description: "Record the cut and stop the goal-host compose at that checkpoint.",
      resolver: "deterministic",
      outputShapes: ["composeCallerCut"],
    },
  ],
};
