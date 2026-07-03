import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * repair-activity-from-failures (2026-07-02) — makes the `template_repair`
 * resolver WALK-REACHABLE as an ordinary producer in the shape graph.
 *
 * Before this seed, template_repair was reachable only via a goal-host
 * interception (special-case). This template advertises it idiomatically:
 * a goal that infers `activityVariant_write` backward-chains to this template;
 * its input shape `trace_failure_pattern_report` is produced by the existing
 * analysis chain (probe-recurring-dispatch → detect-recurring-trace-pattern →
 * composed-cap-summarize-the-most-common-failure-modes), completing
 * analysis → pattern report → REPAIR → variant.
 *
 * Binding note: the live producer of `trace_failure_pattern_report`
 * (composed-cap-summarize-the-most-common-failure-modes) emits an LLM TEXT
 * summary (lines of `<failure_mode.type> count=N example_execution_id=…`) —
 * it carries NO structured activity-id field to dot-path into. The structured
 * sibling (`failurePatternReport` from the trace_failure_pattern_report
 * resolver) DOES carry `patterns[].template_id`, so we bind `template_id`
 * from it opportunistically. `activity_id` binds from goal variables; when
 * neither placeholder resolves, the resolver falls back to extracting the
 * target id from the goal text (the goal-host proxy spreads walk variables —
 * including `goal` — into the pointer). Grounding + minting live entirely in
 * the resolver; this template is a minimal one-task dispatch.
 *
 * Promotion is NOT this template's job: the minted variant competes under the
 * existing Thompson evidence gate (`variant_promote`, ≥0.15 posterior
 * dominance over ≥10 samples).
 */
export const REPAIR_ACTIVITY_FROM_FAILURES_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:repair-activity-from-failures",
  name: "repair-activity-from-failures",
  description:
    "Repairs a weak/flaky activity by minting a corrected variant grounded on its recent " +
    "failure traces (variant-first repair via the template_repair resolver). Consumes the " +
    "failure-pattern analysis (trace_failure_pattern_report) produced by the trace-analysis " +
    "chain and emits activityVariant_write + templateRepairReport. Only mints the candidate — " +
    "promotion stays with the Thompson evidence gate (variant_promote).",
  inputShapes: [],
  optionalInputShapes: ["trace_failure_pattern_report"],
  outputShapes: ["activityVariant_write", "templateRepairReport"],
  tags: ["repair", "activity-lifecycle", "meta"],
  variables: [
    {
      name: "activity_id",
      description:
        "Id of the flaky/weak activity template to repair (bare or activity:⟨…⟩ wrapped), " +
        "e.g. development-vessel:harness-run-matrix. When absent, the template_repair " +
        "resolver extracts the target id from the goal text.",
    },
  ],
  tasks: [
    {
      id: "repair_template",
      description:
        "Invoke the template_repair resolver: grounds a repair spec from the target " +
        "template's JSON + its recent failure traces, then mints a corrected variant via " +
        "activity_create_variant (variant-first — parentTemplateId exempts the " +
        "reuse-before-mint gate). Returns templateRepairReport with verdict + variant_id.",
      resolver: "template_repair",
      config: {
        type: "template_repair",
        // Goal-variable binding; unresolved placeholders are sanitized by the
        // resolver, which then falls back to goal-text extraction.
        activity_id: "{{activity_id}}",
        // Opportunistic structured binding when the pool carries the structured
        // failurePatternReport (top failing template) rather than the LLM-text
        // trace_failure_pattern_report summary.
        template_id: "{{failurePatternReport.patterns.0.template_id}}",
        failure_window: 5,
      },
      outputShapes: ["activityVariant_write", "templateRepairReport"],
    },
  ],
};
