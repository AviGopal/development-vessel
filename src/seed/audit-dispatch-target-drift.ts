import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * audit-dispatch-target-drift — deterministic dispatch-target-drift detector.
 *
 * The bug class: callers dispatch `run_goal target_template_id=X` (MCP,
 * direct HTTP, or goal_execution impulse), expecting template X to run.
 * Traces only record the SELECTED template (`activity_id`/`variant_id`).
 * The originally-requested target is dropped. The dispatch path's
 * `target_template_id` argument is, in practice, decorative for any
 * caller that doesn't post-check the response's `selectedTemplateId`.
 *
 * What this detector does today:
 *   - Probes recent traces for any of `target_template_id`,
 *     `dispatch_target_template_id`, `requested_template_id` fields.
 *   - If absent on every row (current state of activity-api): emits a
 *     SINGLE high-priority substrateGap with gap_subtype=
 *     `instrumentation_gap_dispatch_target_not_recorded`. This is a
 *     detection-template-of-detection-templates — the gap that, once
 *     closed, unlocks the real dispatch-target-drift detection.
 *   - If present: scans for rows where requested != selected and emits
 *     one substrateGap per drift.
 *
 * Constitutional principle (concept_9ldsmRgqSTd5,
 * substrate_self_detection_principle): when the data needed to detect
 * a bug class is itself missing, the FIRST emitted detection is the
 * instrumentation gap that blocks the second. Accumulated audit
 * capability.
 *
 * Mirrors detect-phantom-success-trace's collapsed-resolver idiom:
 * single task, single resolver, no LLM, no multi-task abort surface.
 */

export const AUDIT_DISPATCH_TARGET_DRIFT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:audit-dispatch-target-drift",
  name: "audit-dispatch-target-drift",
  description:
    "Scans recent execution traces for the dispatch-target-drift signature " +
    "(caller-requested target_template_id != trace's selected activity_id). " +
    "If activity-api does not yet record the requested target on traces, " +
    "emits a single instrumentation_gap substrateGap declaring the data " +
    "shape that must be added before drift detection is possible. " +
    "Deterministic; no LLM. Each gap carries detection_principle=" +
    "'concept_9ldsmRgqSTd5'. Companion to detect-phantom-success-trace.",
  inputShapes: [],
  outputShapes: ["substrateGap", "dispatchTargetDriftReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "dispatch.audit",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Probe trace schema for any target-recording field; if present, emit a " +
        "substrateGap per drift; if absent (current state), emit a single " +
        "instrumentation gap declaring the chained-prerequisite data shape. " +
        "Returns a dispatchTargetDriftReport summary.",
      resolver: "dispatch_target_drift_scan",
      config: {
        type: "dispatch_target_drift_scan",
        limit: 200,
        maxEmits: 50,
        dry_run: false,
      },
      outputShapes: ["dispatchTargetDriftReport"],
    },
  ],
};
