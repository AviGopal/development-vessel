import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * precutover-suite-timeout-defer — what the pre-cutover test gate does when an undirected landing's whole suite did
 * not run, decided in process at the gate (src/resolvers/precutover-suite-timeout-defer.ts), never dispatched. It
 * produces one precutoverSuiteTimeout per decision (variant, whether the suite timed out, the host's PSI and the
 * threshold, the gap's deferrals, deferred or not). Its grade is decided by its CONSUMER, the
 * precutover-suite-timeout-defer-credit trace: reached = the same gap's next pre-cutover suite measured, never by its
 * exit. Variant-1 (`<id>-v1`, a child template) defers a contended timeout; which variant runs is the
 * activityVariantMask pool impulse. Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const PRECUTOVER_SUITE_TIMEOUT_DEFER_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:precutover-suite-timeout-defer",
  name: "precutover-suite-timeout-defer",
  description:
    "Decides, at a pre-cutover test gate whose whole suite did not run on an undirected landing, to refuse the " +
    "landing as before, and records a precutoverSuiteTimeout. Graded by its consumer (the gap's next pre-cutover " +
    "suite), never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["precutoverSuiteTimeout"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "defer-or-refuse",
      description: "Refuse the landing as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["precutoverSuiteTimeout"],
    },
  ],
};

export const PRECUTOVER_SUITE_TIMEOUT_DEFER_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:precutover-suite-timeout-defer-v1",
  name: "precutover-suite-timeout-defer-v1",
  description:
    "Variant of precutover-suite-timeout-defer. A suite killed at its budget while the host was contended, on a gap " +
    "under its deferral cap, defers the cutover: the staged tree is kept and retried, the compose is a non-attempt. " +
    "Anything else refuses as before. Records a precutoverSuiteTimeout. Graded by its consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["precutoverSuiteTimeout"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:precutover-suite-timeout-defer",
  tasks: [
    {
      id: "defer-or-refuse",
      description: "Defer a contended timeout under the cap, else refuse as before; record the decision.",
      resolver: "deterministic",
      outputShapes: ["precutoverSuiteTimeout"],
    },
  ],
};
