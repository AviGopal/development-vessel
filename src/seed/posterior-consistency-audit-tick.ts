import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * posterior-consistency-audit-tick — substrate cross-checks its OWN claimed
 * Thompson α/β cells against empirical trace counts. Emits substrateGap
 * (category=posterior_consistency_drift) when posterior means drift > threshold.
 * Catches stale-posterior bugs that won't show up in trace_outcome_validity_audit.
 * Immunity-pattern compliant.
 */
export const POSTERIOR_CONSISTENCY_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:posterior-consistency-audit-tick",
  name: "posterior-consistency-audit-tick",
  description:
    "Deterministic single-resolver wrapper around posterior_consistency_audit. " +
    "Fetches activity_metrics + recent traces, compares claimed Thompson posterior " +
    "means against empirical trace-derived means, emits posterior_consistency_drift " +
    "substrateGap for each cell whose drift exceeds threshold.",
  inputShapes: [],
  outputShapes: ["posteriorConsistencyResult"],
  tags: [
    "intent:horizon_detection",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_posterior_consistency",
      description:
        "Invoke posterior_consistency_audit. Pulls templates + traces, computes " +
        "empirical α/β per activity, flags drift > threshold, emits substrateGap.",
      resolver: "posterior_consistency_audit",
      config: { type: "posterior_consistency_audit" },
      outputShapes: ["posteriorConsistencyResult"],
    },
  ],
};
