import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * trace-outcome-validity-audit-tick — substrate inspects its OWN trace records
 * for status/outcome inconsistencies (e.g. tail body shape=structuredError with
 * trace.status=success) and emits substrateGap (category=
 * trace_outcome_inconsistency) when clusters exceed threshold. Closes the
 * meta-recursion that operator log-scraping closed manually for the
 * apply-proposal-as-patch echo chamber (commit a0f9f593) — substrate now
 * detects the same pattern via an activity. Immunity-pattern compliant.
 */
export const TRACE_OUTCOME_VALIDITY_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:trace-outcome-validity-audit-tick",
  name: "trace-outcome-validity-audit-tick",
  description:
    "Deterministic single-resolver wrapper around trace_outcome_validity_audit. " +
    "Walks recent execution traces and flags clusters where tail output_impulse_shape " +
    "contradicts recorded status (structuredError + success, mitosisStaged + success, " +
    "variantPromoteResult + success). Emits trace_outcome_inconsistency substrateGap " +
    "impulses for each cluster above min_inconsistencies.",
  inputShapes: [],
  outputShapes: ["traceOutcomeValidityResult"],
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
      id: "audit_trace_outcome_validity",
      description:
        "Invoke trace_outcome_validity_audit. Walks recent traces, applies the rule " +
        "table over (tail_shape, status) → derived_outcome, clusters by signature, " +
        "emits substrateGap impulses for clusters above threshold.",
      resolver: "trace_outcome_validity_audit",
      config: { type: "trace_outcome_validity_audit" },
      outputShapes: ["traceOutcomeValidityResult"],
    },
  ],
};
