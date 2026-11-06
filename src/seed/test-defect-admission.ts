import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * test-defect-admission — whether a green draft that edits a test-defect row's check file is admitted, decided in process
 * in feature_compose's verify (src/resolvers/feature-compose.ts testDefectAdmissionDecision), never dispatched. It
 * produces one testDefectAdmission per decision (the row, the test file, the parent's and the draft's shape, admitted or
 * the breach). Its grade is decided by its CONSUMER: reached = the landing's own check green after it lands (the
 * pending-land sweep closing the row), never by its exit. Variant-1 (`<id>-v1`, a child template) admits a draft only
 * through the child-parse certifier; which variant runs is the activityVariantMask pool impulse. Operator-seeded;
 * seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const TEST_DEFECT_ADMISSION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-admission",
  name: "test-defect-admission",
  description:
    "Decides, for a green draft that edits a test-defect row's own check file, that it is refused as a draft of its " +
    "own check is, and records a testDefectAdmission. Graded by its consumer (the landing's own check after it " +
    "lands), never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["testDefectAdmission"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "certify-test-defect-draft",
      description: "Refuse the draft as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["testDefectAdmission"],
    },
  ],
};

export const TEST_DEFECT_ADMISSION_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:test-defect-admission-v1",
  name: "test-defect-admission-v1",
  description:
    "Variant of test-defect-admission. The draft is admitted only when it edits nothing but the test file and the " +
    "child-parse certifier, a check distinct from the row's own, is red on the parent and green on the draft with no " +
    "case, child script or skip mark removed or added. Records a testDefectAdmission. Graded by its consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["testDefectAdmission"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:test-defect-admission",
  tasks: [
    {
      id: "certify-test-defect-draft",
      description: "Admit the draft only through the child-parse certifier; record the decision.",
      resolver: "deterministic",
      outputShapes: ["testDefectAdmission"],
    },
  ],
};
