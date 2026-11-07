import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-localization — where a gap with no edit site is sited, decided in process after each localizeGap call
 * (src/resolvers/gap-localization.ts: decomposeGap, the compose pick, the check supply's I1), never dispatched. It
 * produces one gapLocalization per decision that sited a row or localized nothing (the caller, the method, the file,
 * written or why not). Its grade is decided by its CONSUMER, the gap-localization-credit trace: reached = the gap's next
 * localizer read used the persisted site, never by its exit. Variant-1 (`<id>-v1`, a child template) persists a site the
 * caller would have used once; which variant runs is the activityVariantMask pool impulse. Operator-seeded;
 * seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const GAP_LOCALIZATION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-localization",
  name: "gap-localization",
  description:
    "Decides, after the localizer answers for a gap with no edit site, to use the answer once as before (variant-0, " +
    "the control), and records the decision. Graded by its consumer (the gap's next localizer read), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["gapLocalization"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "localize",
      description: "Use the localizer's answer once, as before, and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["gapLocalization"],
    },
  ],
};

export const GAP_LOCALIZATION_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-localization-v1",
  name: "gap-localization-v1",
  description:
    "Variant of gap-localization. A non-null answer for a row with no edit site is persisted in the check supply's " +
    "form (edit_site, localized_by, localization_method, the localization record) unless the autonomy scope is " +
    "unreadable or excludes it, or the row's region is not literal once in it. Records a gapLocalization. Graded by " +
    "its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["gapLocalization"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:gap-localization",
  tasks: [
    {
      id: "localize",
      description: "Persist the answer for a row with no edit site when the scope and region allow it; record the decision.",
      resolver: "deterministic",
      outputShapes: ["gapLocalization"],
    },
  ],
};
