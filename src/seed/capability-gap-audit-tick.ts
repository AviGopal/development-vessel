import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * capability-gap-audit-tick — substrate detects its OWN missing-capability
 * surface. Wraps capability_gap_audit in an immunity-pattern single-task
 * template. Boredom goal[29] dispatches this on cadence; output is a
 * capabilityGapReport with substrateGap impulses emitted per gap. The
 * resolver-author seed template consumes those gaps on a subsequent tick.
 *
 * cheap tier (HTTP-only, no LLM). The LLM-touching path is in resolver-author.
 */
export const CAPABILITY_GAP_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:capability-gap-audit-tick",
  name: "capability-gap-audit-tick",
  description:
    "Deterministic single-resolver wrapper around capability_gap_audit. Scans " +
    "recent failure traces for 'unknown shape' / 'no resolver for type' / " +
    "endpoint-404 signatures, aggregates into capability gaps, emits one " +
    "missing_capability substrateGap per cluster.",
  inputShapes: [],
  outputShapes: ["capabilityGapReport"],
  tags: [
    "intent:capability_gap_detection",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "meta_cognition_bootstrap",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_capability_gaps",
      description:
        "Invoke capability_gap_audit. Walks recent failure traces, extracts " +
        "missing-capability signatures, emits substrateGap impulses for each cluster.",
      resolver: "capability_gap_audit",
      config: { type: "capability_gap_audit" },
      outputShapes: ["capabilityGapReport"],
    },
  ],
};
