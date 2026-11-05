import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * reach-grade — the delivery of a landing verdict (or a failed compose's exit) to the execution it grades, run in
 * process by the landing-verdict judge and the compose exit (src/judge/learning-credit.ts reachGrade), never dispatched.
 * It produces one executionReachResult per grade (posted id, resolved id, as_given | dispatch_mapped | unresolved,
 * delivered, moved). Its grade is decided by its CONSUMER, the reach-grade-credit trace (reached = the verdict was
 * delivered to a trace row), never by its exit: reach_decided_by "consumer". Variant-1 (`<id>-v1`, a child template)
 * maps a dispatch id that holds no row to its trace id; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded: uploaded by the operator, not extracted from a walk. No seed_version, so a populated catalogue does
 * not auto-upsert it (seed/deliver.ts).
 */
export const REACH_GRADE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:reach-grade",
  name: "reach-grade",
  description:
    "Delivers a decided reach verdict to the execution trace it grades and records the delivery as an " +
    "executionReachResult (as_given | dispatch_mapped | unresolved; delivered, moved). Graded by its consumer " +
    "(the verdict reached a trace row), never at exit.",
  inputShapes: ["cutoverApplied"],
  outputShapes: ["executionReachResult"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control" },
  tasks: [
    {
      id: "post-reach",
      description: "Post the decided verdict to the execution id as given (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["executionReachResult"],
    },
  ],
};
