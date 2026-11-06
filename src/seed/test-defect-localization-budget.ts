import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * test-defect-localization-budget — what the check-supply tick's test-defect pass counts against max_per_tick, decided
 * in process by the tick (src/resolvers/gap-check-supply.ts testDefectPass), never dispatched. It produces one
 * testDefectLocalizationBudget per due pass (the variant, the budget, how many rows it decided and wrote, how many
 * candidates it left undecided). Its grade is decided by its CONSUMER: a row decided this pass that a variant-0 pass
 * leaves undecided, read off the localization's own decision lines, never by its exit. Variant-1 (`<id>-v1`, a child
 * template) counts only writes against max_per_tick; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const TEST_DEFECT_LOCALIZATION_BUDGET_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-localization-budget",
  name: "test-defect-localization-budget",
  description:
    "Bounds the check-supply tick's test-defect pass by counting every decision against max_per_tick, as before, and " +
    "records how many candidates the pass left undecided as a testDefectLocalizationBudget. Graded by its consumer " +
    "(the rows the pass decides), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["testDefectLocalizationBudget"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "budget-test-defect-pass",
      description: "Count every decision against max_per_tick (variant-0, the control) and record the pass.",
      resolver: "deterministic",
      outputShapes: ["testDefectLocalizationBudget"],
    },
  ],
};

export const TEST_DEFECT_LOCALIZATION_BUDGET_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-localization-budget-v1",
  name: "test-defect-localization-budget-v1",
  description:
    "Variant of test-defect-localization-budget. Only a decision that writes counts against max_per_tick; the pass " +
    "decides at most test_defect_decide_max rows, so a row behind rows that are decided without a write is still " +
    "decided. Records a testDefectLocalizationBudget. Graded by its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["testDefectLocalizationBudget"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:test-defect-localization-budget",
  tasks: [
    {
      id: "budget-test-defect-pass",
      description: "Count only writes against max_per_tick, bound the decisions per pass; record the pass.",
      resolver: "deterministic",
      outputShapes: ["testDefectLocalizationBudget"],
    },
  ],
};
