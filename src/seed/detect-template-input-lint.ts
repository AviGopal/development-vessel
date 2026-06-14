import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-template-input-lint — deterministic detector for templates that
 * declare inputShapes / variables NO task consumes.
 *
 * Meta-detector authored 2026-06-13 after the operator had to hand-fix exactly
 * this class: draft-activity-from-pattern declared inputShapes:[recurringPatternCluster]
 * + a pattern_cluster_id variable but no task loaded the cluster, so the
 * authoring ran blind and produced nothing for weeks — a silent mis-wire that
 * never surfaced as an execution failure. This makes the class substrate-
 * detectable: one server-side resolver lints the registry and POSTs a
 * substrateGap per offending template (gap_subtype=template_declares_unused_input),
 * routing the fix into the gap → bridge → drafter loop so the NEXT instance
 * self-completes instead of waiting for an operator to read source.
 *
 * Single-task template (mirrors detect-stale-pointer): the resolver does the
 * whole fetch → lint → emit flow; no LLM (structural yes/no check).
 */
export const DETECT_TEMPLATE_INPUT_LINT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-template-input-lint",
  name: "detect-template-input-lint",
  description:
    "Lints the activity registry for templates that declare inputShapes or " +
    "variables no task consumes (declared-but-never-loaded). Deterministic " +
    "(no LLM): a declared inputShape is unused when no task lists it as a task " +
    "inputShape and no task config/prompt references {{shape}}; a variable is " +
    "unused when {{name}} / {{name_suffix}} never appears. Emits one " +
    "substrateGap per offending template with " +
    "classification_metadata.gap_subtype='template_declares_unused_input'. " +
    "Catches the silent mis-wire class that left draft-activity-from-pattern dead.",
  inputShapes: [],
  outputShapes: ["substrateGap", "templateInputLintReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "activity.lifecycle",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run the registry lint + gap-emission in one server-side step. Returns a " +
        "templateInputLintReport with scanned/in_scope/finding_count and the per-" +
        "template findings (unused_input_shapes, unused_variables, post_status).",
      resolver: "template_input_lint_scan",
      config: {
        type: "template_input_lint_scan",
        dry_run: false,
        maxEmits: 25,
      },
      outputShapes: ["templateInputLintReport"],
    },
  ],
};
