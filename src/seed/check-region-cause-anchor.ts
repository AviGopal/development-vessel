import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * check-region-cause-anchor — which region of a gap's edit site the check goal names and the region gates replace,
 * decided in process wherever that region is derived (src/resolvers/check-region-cause-anchor.ts), never dispatched.
 * It produces one checkRegionAnchor per check goal written on a row's stated cause (the gap, the site, the cause, its
 * line). Its grade is decided by its CONSUMER, the check-region-cause-anchor-credit trace: reached = the gap's region
 * gate on the landed check measured a red that moved under the cause's region, never by its exit. Variant-1
 * (`<id>-v1`, a child template) anchors on the stated cause; which variant runs is the activityVariantMask pool
 * impulse. Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const CHECK_REGION_CAUSE_ANCHOR_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:check-region-cause-anchor",
  name: "check-region-cause-anchor",
  description:
    "Decides which region of a gap's edit site its check is anchored on: today's pick from the evidence's text and " +
    "token anchors (variant-0, the control), logging where the row's stated cause would anchor. Graded by its " +
    "consumer (the gap's region gate on the landed check), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["checkRegionAnchor"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "anchor-on-cause",
      description: "Keep today's region pick and record where the stated cause would anchor (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["checkRegionAnchor"],
    },
  ],
};

export const CHECK_REGION_CAUSE_ANCHOR_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:check-region-cause-anchor-v1",
  name: "check-region-cause-anchor-v1",
  description:
    "Variant of check-region-cause-anchor. The row's stated cause (its region, else region_prior_text) anchors the " +
    "check when it resolves in the edit site: a declared function's returns and throws, or a literal found once. A " +
    "summary token never overrides it; an unresolved cause falls back to today's pick. Records a checkRegionAnchor. " +
    "Graded by its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["checkRegionAnchor"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:check-region-cause-anchor",
  tasks: [
    {
      id: "anchor-on-cause",
      description: "Anchor on the stated cause when it resolves, else today's pick; record the decision.",
      resolver: "deterministic",
      outputShapes: ["checkRegionAnchor"],
    },
  ],
};
