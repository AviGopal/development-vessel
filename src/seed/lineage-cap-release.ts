import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * lineage-cap-release — whether the auto-pick holds a recommit lineage past its attempt cap when the lineage carries
 * information newer than its last failure (a changed falsifier classification, a new arm), decided in process at each
 * pick pass (src/resolvers/gap-to-feature.ts lineageCapReleaseDecisions), never dispatched. It produces one
 * lineageCapRelease per decision (the row, its root and root source, the event, the last failing step). Its grade is
 * decided by its CONSUMER, the lineage-cap-release-credit trace: reached = the released row's compose landed, never
 * by its exit. Variant-1 (`<id>-v1`, a child template) admits the row past the cap; which variant runs is the
 * activityVariantMask pool impulse.
 * Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const LINEAGE_CAP_RELEASE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:lineage-cap-release",
  name: "lineage-cap-release",
  description:
    "Decides, for a recommit lineage past its attempt cap with information newer than its last failure, that the " +
    "cap holds as before, and records a lineageCapRelease. Graded by its consumer (the released row's compose " +
    "landed), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["lineageCapRelease"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "decide-release",
      description: "Hold the capped lineage as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["lineageCapRelease"],
    },
  ],
};

export const LINEAGE_CAP_RELEASE_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:lineage-cap-release-v1",
  name: "lineage-cap-release-v1",
  description:
    "Variant of lineage-cap-release. A recommit lineage past its attempt cap with information newer than its last " +
    "failure is admitted past the cap once; its next failure re-applies the cap. Records a lineageCapRelease. Graded " +
    "by its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["lineageCapRelease"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:lineage-cap-release",
  tasks: [
    {
      id: "decide-release",
      description: "Admit the capped lineage past the cap and record the decision.",
      resolver: "deterministic",
      outputShapes: ["lineageCapRelease"],
    },
  ],
};
