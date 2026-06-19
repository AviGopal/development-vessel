import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * dead-end-decision-scan-tick — the substrate's decision-without-action
 * detector. Runs dead_end_decision_scan: an intra-trajectory scan of
 * execution_trace_content.tasks[] for an actionable decision/selection task
 * (e.g. slot-binding's select_or_produce) that PRODUCES a decision impulse NO
 * downstream task consumes — the decision is computed and discarded, so the
 * action it was meant to drive never happens.
 *
 * Emits a decision_without_action substrateGap per systematic (activity_id,
 * task_id) class (occurrences ≥ min_occurrences AND dead_end_fraction ≥
 * threshold). The class is recombination-fixable (add a downstream task that
 * consumes the existing decision impulse), so the gap routes to the drafter,
 * not vessel-authoring. Same constitutional principle (concept_9ldsmRgqSTd5):
 * a measured defect class becomes a first-class detection target. Low cadence
 * — the underlying signature changes slowly. Deterministic; no LLM.
 */

export const DEAD_END_DECISION_SCAN_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:dead-end-decision-scan-tick",
  name: "dead-end-decision-scan-tick",
  description:
    "Runs dead_end_decision_scan over recent execution_trace_content rows: detects " +
    "actionable decision/selection tasks whose produced impulse is consumed by no " +
    "downstream task in the same trajectory (the slot-binding select_or_produce " +
    "dead-end signature, generalized), and emits a decision_without_action " +
    "substrateGap per systematic (activity_id, task_id) class. Deterministic " +
    "structural detection + emission; routes to the drafter (recombination-fixable).",
  inputShapes: [],
  outputShapes: ["deadEndDecisionReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "decision.flow.integrity", "boredom_target_template"],
  variables: [],
  cited_concept_ids: ["concept_9ldsmRgqSTd5"],
  tasks: [
    {
      id: "scan_dead_end_decisions",
      description:
        "Run dead_end_decision_scan over the recent trajectory window, aggregate " +
        "decision-without-action occurrences by (activity_id, task_id), and emit a " +
        "decision_without_action substrateGap per systematic class.",
      resolver: "dead_end_decision_scan",
      config: {
        type: "dead_end_decision_scan",
        window_hours: 24,
        trace_limit: 500,
        min_occurrences: 10,
        dead_end_threshold: 0.9,
        emit_gap: true,
      },
      outputShapes: ["deadEndDecisionReport"],
    },
  ],
};
