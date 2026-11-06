import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * post-land-baseline-keep — what the post-land suite writes as the vessel's baseline when it finds tests newly failing
 * after the landing, decided in process (src/resolvers/vessel-mitosis-cutover.ts postLandBaselineKeepDecision), never
 * dispatched. It produces one postLandBaseline per decision (variant, landed sha, the newly failing names, how many were
 * written). Its grade is decided by its CONSUMER, the post-land-baseline-keep-credit trace: reached = the next pre-cutover
 * gate on the vessel read a usable baseline that hides none of the withheld names still failing, never by its exit.
 * Variant-1 (`<id>-v1`, a child template) writes the failing set less the newly failing names; which variant runs is the
 * activityVariantMask pool impulse. Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const POST_LAND_BASELINE_KEEP_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:post-land-baseline-keep",
  name: "post-land-baseline-keep",
  description:
    "Decides, after a post-land suite that found tests newly failing, that the whole failing set is written as the " +
    "vessel's baseline as before, and records a postLandBaseline. Graded by its consumer (the next pre-cutover gate on " +
    "the vessel), never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["postLandBaseline"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "write-baseline",
      description: "Write the whole failing set as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["postLandBaseline"],
    },
  ],
};

export const POST_LAND_BASELINE_KEEP_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:post-land-baseline-keep-v1",
  name: "post-land-baseline-keep-v1",
  description:
    "Variant of post-land-baseline-keep. The baseline written after a landing that newly broke tests leaves those " +
    "tests out, so the next landing's gate still counts them as newly failing. Records a postLandBaseline. Graded by " +
    "its consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["postLandBaseline"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:post-land-baseline-keep",
  tasks: [
    {
      id: "write-baseline",
      description: "Write the failing set less the newly failing names; record the decision.",
      resolver: "deterministic",
      outputShapes: ["postLandBaseline"],
    },
  ],
};
