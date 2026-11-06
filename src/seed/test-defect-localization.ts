import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * test-defect-localization — where a failing-test row's fix goes when its own check is red only because a child script
 * the test runs does not parse, decided in process by the check-supply tick (src/resolvers/gap-check-supply.ts
 * testDefectLocalizationDecision), never dispatched. It produces one testDefectLocalization per decision (the row, the
 * test file, the per-case calls). Its grade is decided by its CONSUMER, the test-defect-localization-credit trace the
 * next compose of the row posts: reached = a test-only draft of the test file the child-parse certifier admitted turned
 * the row's own check red -> green, never by its exit. Variant-1 (`<id>-v1`, a child template) writes the localization;
 * which variant runs is the activityVariantMask pool impulse. Operator-seeded; seed_version, so a populated catalogue
 * upserts it (seed/deliver.ts).
 */
export const TEST_DEFECT_LOCALIZATION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-localization",
  name: "test-defect-localization",
  description:
    "Decides, for a failing-test row whose every failing case runs a child script that does not parse, that the row " +
    "keeps its src edit site as before, and records a testDefectLocalization. Graded by its consumer (the next compose " +
    "of the row), never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["testDefectLocalization"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "localize-test-defect",
      description: "Leave the row's edit site as it is and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["testDefectLocalization"],
    },
  ],
};

export const TEST_DEFECT_LOCALIZATION_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-localization-v1",
  name: "test-defect-localization-v1",
  description:
    "Variant of test-defect-localization. The row's edit site becomes its test file, marked test_defect with the " +
    "child-parse certifier that alone may admit a test-only draft; its own check still closes it. Records a " +
    "testDefectLocalization. Graded by its consumer, never at exit.",
  inputShapes: ["substrateGap"],
  outputShapes: ["testDefectLocalization"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:test-defect-localization",
  tasks: [
    {
      id: "localize-test-defect",
      description: "Write the row's test file as its edit site with the test_defect record, in one write; record the decision.",
      resolver: "deterministic",
      outputShapes: ["testDefectLocalization"],
    },
  ],
};
