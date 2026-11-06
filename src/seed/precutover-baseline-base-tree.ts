import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * precutover-baseline-base-tree — what the pre-cutover test gate compares a staged tree against when the vessel has no
 * usable post-land baseline (absent, unparseable, empty, or older than its maximum age), decided in process at the
 * gate (src/resolvers/vessel-mitosis-cutover.ts precutoverBaselineBaseTreeDecision), never dispatched. It produces one
 * precutoverBaseline per decision (variant, why the file was unusable, the baseline used, directed or not). Its grade
 * is decided by its CONSUMER, the precutover-baseline-base-tree-credit trace: reached = the landing's post-land suite
 * shows no failure outside the baseline the decision supplied, never by its exit. Variant-1 (`<id>-v1`, a child
 * template) measures the base tree in the same cutover; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const PRECUTOVER_BASELINE_BASE_TREE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:precutover-baseline-base-tree",
  name: "precutover-baseline-base-tree",
  description:
    "Decides, at a pre-cutover test gate with no usable post-land baseline, that the staged tree is judged as before " +
    "(nothing to compare against), and records a precutoverBaseline. Graded by its consumer (the landing's post-land " +
    "suite), never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["precutoverBaseline"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "choose-baseline",
      description: "Judge the staged tree as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["precutoverBaseline"],
    },
  ],
};

export const PRECUTOVER_BASELINE_BASE_TREE_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:precutover-baseline-base-tree-v1",
  name: "precutover-baseline-base-tree-v1",
  description:
    "Variant of precutover-baseline-base-tree. With no usable post-land baseline, the whole suite runs once on the " +
    "untouched base tree and its failing set is the baseline; a base run that does not measure refuses an undirected " +
    "landing. Records a precutoverBaseline. Graded by its consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["precutoverBaseline"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:precutover-baseline-base-tree",
  tasks: [
    {
      id: "choose-baseline",
      description: "Measure the base tree and use its failing set as the baseline; record the decision.",
      resolver: "deterministic",
      outputShapes: ["precutoverBaseline"],
    },
  ],
};
