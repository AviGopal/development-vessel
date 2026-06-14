import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-recurring-trace-pattern (2026-06-14) — the core-loop feeder for the
 * real-chain author `draft-activity-from-pattern`.
 *
 * The author needs a `recurringPatternCluster` to author a genuine producing
 * chain. Its prior feeder (detect-recurring-pattern) reads obsidian episodes —
 * obsidian-coupled, so unfit for the core boredom loop. This template wraps the
 * deterministic `trace_recurring_pattern_scan` resolver, which mines the
 * substrate's OWN execution traces for a recurrent output-shape topology, writes
 * the cluster to /workspace/patterns/<id>.json, and dispatches the author — all
 * with no external dependency. Light-dispatch eligible (deterministic, no LLM).
 */
export const DETECT_RECURRING_TRACE_PATTERN_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-recurring-trace-pattern",
  name: "detect-recurring-trace-pattern",
  description:
    "Deterministic single-resolver feeder for the real-chain author. Mines recent SUCCESS execution " +
    "traces for the most-recurrent output-shape topology (excluding meta-activities and deterministic " +
    "tick/scan/audit wrappers), emits a recurringPatternCluster to /workspace/patterns/, and dispatches " +
    "draft-activity-from-pattern so the substrate authors a clean producing chain for it. The " +
    "non-obsidian replacement for detect-recurring-pattern in the core loop. Returns recurringPatternCluster.",
  inputShapes: [],
  outputShapes: ["recurringPatternCluster"],
  tags: [
    "intent:self_dev",
    "pattern.detection",
    "lift.autonomous.loop",
    "boredom_target_template",
    "light_dispatch_eligible",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_recurring_trace_pattern",
      description:
        "Invoke trace_recurring_pattern_scan. Reads activity-api success traces over the lookback " +
        "window, groups by output-shape signature, picks the top signature recurring >= minRecurrence, " +
        "writes the recurringPatternCluster cluster file, and dispatches draft-activity-from-pattern.",
      resolver: "trace_recurring_pattern_scan",
      config: {
        type: "trace_recurring_pattern_scan",
        lookbackHours: 24,
        minRecurrence: 3,
        dispatch: true,
      },
      outputShapes: ["recurringPatternCluster"],
    },
  ],
};
