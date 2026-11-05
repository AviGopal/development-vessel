import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * failure-recall — goal-host's recall of a goal's earlier failures (goal-host src/index.ts recallGoalFailures, read into
 * the synthesis and floor prompts and as the switch that turns command replay off), run in process by goal-host at a
 * dispatch's first recall, never dispatched. It produces one failureRecall per dispatch that recalled anything (exact
 * and near counts before and after, the records variant-1's clause matched). Its grade is decided by its CONSUMER,
 * the dispatch that read the recall: the failure-recall-credit trace carries that dispatch's decided verdict, posted
 * only when variant-1's clause matched a record. Variant-1 (`<id>-v1`, a child template) drops legacy caller-cut
 * lessons; which variant runs is the activityVariantMask pool impulse. Seeded here, with development-vessel's other
 * operator-seeded activities, so the catalogue has one seed route; seed_version, so a populated catalogue upserts it.
 */
export const FAILURE_RECALL_TEMPLATE: ActivityTemplate = {
  id: "goal-host:failure-recall",
  name: "failure-recall",
  description:
    "Recalls a goal's earlier failures (this goal's since its last reach, and goals with the same target decision) " +
    "for its dispatch, recording a failureRecall. Graded by the dispatch that consumed it (its decided verdict), " +
    "never at exit.",
  inputShapes: ["goal"],
  outputShapes: ["failureRecall"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "recall",
      description: "Recall the goal's failures as before (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["failureRecall"],
    },
  ],
};

export const FAILURE_RECALL_V1_TEMPLATE: ActivityTemplate = {
  id: "goal-host:failure-recall-v1",
  name: "failure-recall-v1",
  description:
    "Variant of failure-recall. Drops legacy caller-cut lessons: records written before records carried their " +
    "outcome source, whose reason carries the caller-cut text. A record with a source is never dropped. Records a " +
    "failureRecall with the matched records. Graded by the consuming dispatch, never at exit.",
  inputShapes: ["goal"],
  outputShapes: ["failureRecall"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "goal-host:failure-recall",
  tasks: [
    {
      id: "recall",
      description: "Recall the goal's failures without legacy caller-cut lessons.",
      resolver: "deterministic",
      outputShapes: ["failureRecall"],
    },
  ],
};
