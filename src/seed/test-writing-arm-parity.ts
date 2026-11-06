import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * test-writing-arm-parity — which inputs the test-writing verify's arm precheck judges a drafted check by, decided in
 * process in feature_compose's verify (src/resolvers/feature-compose.ts testWritingArmPrecheck / armParityDecision),
 * never dispatched. It produces one testWritingArmParity per precheck (whose inputs it judged by, which inputs differ
 * between the caller's copy and the gap row, the region each derives, what each gate decided, the verify's call). Its
 * grade is decided by its CONSUMER: the arm step's verdict on the same check after it lands (armed agrees, arm_refused
 * does not), never by its exit. Variant-1 (`<id>-v1`, a child template) judges by the gap row's own inputs, as the arm
 * step does; which variant runs is the activityVariantMask pool impulse. Operator-seeded; seed_version, so a populated
 * catalogue upserts it (seed/deliver.ts).
 */
export const TEST_WRITING_ARM_PARITY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-writing-arm-parity",
  name: "test-writing-arm-parity",
  description:
    "Runs the arm step's gates on a drafted check before it lands, by the caller's inputs as before, and records which " +
    "inputs differ from the gap row's and what each gate decided, as a testWritingArmParity. Graded by its consumer " +
    "(the arm step's verdict after the check lands), never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["testWritingArmParity"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "arm-precheck-inputs",
      description: "Judge the drafted check by the caller's inputs (variant-0, the control) and record the decision.",
      resolver: "deterministic",
      outputShapes: ["testWritingArmParity"],
    },
  ],
};

export const TEST_WRITING_ARM_PARITY_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-writing-arm-parity-v1",
  name: "test-writing-arm-parity-v1",
  description:
    "Variant of test-writing-arm-parity. The arm step's gates run on the drafted check by the gap row's own summary " +
    "and classification_metadata, the inputs the arm step reads after the check lands, so a check the arm step would " +
    "refuse is refused before it lands. Records a testWritingArmParity. Graded by its consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["testWritingArmParity"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:test-writing-arm-parity",
  tasks: [
    {
      id: "arm-precheck-inputs",
      description: "Judge the drafted check by the gap row's own inputs; record the decision.",
      resolver: "deterministic",
      outputShapes: ["testWritingArmParity"],
    },
  ],
};
