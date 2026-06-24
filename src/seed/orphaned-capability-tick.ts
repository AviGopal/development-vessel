import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * orphaned-capability-tick — the substrate detects its OWN advertised-but-
 * unexpressed capability surface. Wraps orphaned_capability_scan in an
 * immunity-pattern single-task template. Boredom dispatches this on cadence
 * alongside capability-gap-audit-tick; the two are the complementary halves of
 * the find-stage (failure-driven + demand-driven). Output emits one
 * orphaned_capability substrateGap per orphaned resolver, which the existing
 * drain-pending-substrate-gaps → draft-gap-closing-activity → gap-compose loop
 * drains to author a bridge activity that invokes the orphaned resolver.
 *
 * cheap tier (HTTP-only, no LLM).
 */
export const ORPHANED_CAPABILITY_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:orphaned-capability-tick",
  name: "orphaned-capability-tick",
  description:
    "Deterministic single-resolver wrapper around orphaned_capability_scan. " +
    "Computes live_resolver_shapes (discovery) minus invoked_resolvers (activity " +
    "tasks), filters to the outward-capability surface, and emits one " +
    "orphaned_capability substrateGap per resolver that is live but invoked by " +
    "zero activities — the demand-driven complement to capability-gap-audit-tick.",
  inputShapes: [],
  outputShapes: ["orphanedCapabilityReport"],
  tags: [
    "intent:orphaned_capability_detection",
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
      id: "scan_orphaned_capabilities",
      description:
        "Invoke orphaned_capability_scan. Fetches live resolver shapes from " +
        "discovery and invoked resolvers from the activity corpus, set-differences " +
        "them, filters to outward capabilities, and emits one orphaned_capability " +
        "substrateGap per orphan (stable id → idempotent upsert).",
      resolver: "orphaned_capability_scan",
      config: { type: "orphaned_capability_scan", max_emit: 40 },
      outputShapes: ["orphanedCapabilityReport"],
    },
  ],
};
