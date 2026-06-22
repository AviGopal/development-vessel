import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-lifecycle-tick — autonomous second-order (lever-4) gap-store health.
 * Runs gap_lifecycle_scan: finds stale-open / churned gaps (drafted+apply-failed+
 * stale) and AUTO-CLOSES the churned ones so the drafter stops re-drafting
 * un-landable gaps; emits a backlog-health meta-gap when the open store is unhealthy.
 * Safe: live detectors re-open anything still real. Deterministic (no LLM).
 */
export const GAP_LIFECYCLE_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-lifecycle-tick",
  name: "gap-lifecycle-tick",
  description:
    "Second-order detector over the gap store: auto-closes churned gaps (drafted + " +
    "apply-failed + stale) to stop drafter churn, and emits a backlog-health meta-gap " +
    "when too many open gaps are stale. Deterministic. Safe (real gaps re-open).",
  inputShapes: [],
  outputShapes: ["gapLifecycleReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "scan_gap_lifecycle",
      description: "Run gap_lifecycle_scan with auto-close enabled.",
      resolver: "gap_lifecycle_scan",
      config: { type: "gap_lifecycle_scan", staleHours: 48, autoClose: true, maxClose: 25, auditEmission: true, pruneChurned: true },
      outputShapes: ["gapLifecycleReport"],
    },
  ],
};
