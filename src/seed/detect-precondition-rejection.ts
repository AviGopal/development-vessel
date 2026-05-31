import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-precondition-rejection — deterministic detector for engine
 * pre-flight rejections. Author: substrate self-detection principle
 * (concept_9ldsmRgqSTd5).
 *
 * Bug class detected: execution traces with status="failure", short
 * duration (< 500ms), and zero completed tasks. This is the F25 signature
 * (concept_qcctOLBT5-CL) — recommend returned a template whose declared
 * inputShapes can't be satisfied from the pool, the engine rejected the
 * dispatch before any task ran. The D2 demo confirmed
 * drain-pending-substrate-gaps pre-flight-rejects on EVERY dispatch.
 *
 * Why this template is structurally safe from the bug it detects:
 *   - inputShapes is empty. Nothing to pre-flight-reject.
 *   - No `variables: []` declared, so no caller is required to seed
 *     specific variables for execution.
 *   - Single task dispatching a single server-side resolver
 *     (precondition_rejection_scan) — same pattern as the proven
 *     detect-stale-pointer (873ms successful run per D3).
 *   - The drain-pending-substrate-gaps template (which DOES pre-flight)
 *     declares `inputShapes: ["substrateGap"]` AND a `variables` block
 *     that includes scenarios_dir/report_path/proposals_dir — neither
 *     condition is present here.
 *
 * Emits one substrateGap impulse per affected template (grouped, not
 * per-instance) with classification_metadata.gap_subtype =
 * 'precondition_rejection_pattern' and fix_priors pointing to F25 so the
 * gap-drafter has a starting concept when it picks this up.
 *
 * Constitutional principle: every bug class observed becomes a detection
 * template, not just a patched instance.
 */

export const DETECT_PRECONDITION_REJECTION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-precondition-rejection",
  name: "detect-precondition-rejection",
  description:
    "Scans recent execution traces for the engine pre-flight rejection " +
    "signature (status=failure, duration < 500ms, task_count = 0), groups " +
    "by template_id, and emits one substrateGap impulse per affected " +
    "template carrying classification_metadata.gap_subtype=" +
    "'precondition_rejection_pattern'. Deterministic (no LLM); the resolver " +
    "collapses fetch + filter + group + emit into one server-side step. " +
    "Detector is structurally immune to the bug it detects: inputShapes is " +
    "empty and no variables are declared, so the engine pre-flight check " +
    "passes without dependence on the pool.",
  inputShapes: [],
  outputShapes: ["substrateGap", "preconditionRejectionReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "failure.mode.detection",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Fetch recent execution traces from activity-api, filter for the " +
        "pre-flight rejection signature, group by template_id, and emit a " +
        "substrateGap per affected template. Returns a " +
        "preconditionRejectionReport with scanned/rejections_total/" +
        "affected_template_count + per-template breakdown.",
      resolver: "precondition_rejection_scan",
      config: {
        type: "precondition_rejection_scan",
        dry_run: false,
        maxEmits: 50,
        durationThresholdMs: 500,
        fetchLimit: 200,
      },
      outputShapes: ["preconditionRejectionReport"],
    },
  ],
};
