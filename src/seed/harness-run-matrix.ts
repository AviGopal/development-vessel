import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const HARNESS_RUN_MATRIX_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:harness-run-matrix",
  name: "harness-run-matrix",
  description:
    "Aggregator: scores all failure-mode scenarios in `scenarios_dir` against the live " +
    "activity registry by calling discover-by-shapes on each scenario's " +
    "output_shapes_must_include. Emits a failureModeReport impulse. " +
    "Fires automatically when the registry-change-observer detects a qualifying lifecycle " +
    "event (draft-gap-closing-activity, prune-activity, replace-activity, or any " +
    "activityRegistryChange emission). Also runnable manually via the CLI.",
  inputShapes: [],
  outputShapes: ["failureModeReport"],
  tags: ["lift.autonomous.loop", "validation.failure.modes", "harness.matrix"],
  variables: [
    {
      name: "scenarios_dir",
      description:
        "Path to directory containing scenario JSON files (relative to WORKSPACE_ROOT or absolute). " +
        "Default: validation/failure-modes/scenarios",
    },
    {
      name: "label",
      description: "Cycle tag attached to the report, e.g. 'cycle-9-auto'. Default: auto-<timestamp>.",
    },
    {
      name: "out_path",
      description:
        "Optional filesystem path to write the failureModeReport JSON (for progression-driver compat). " +
        "Default: validation/results/<date>-harness-auto.json",
    },
  ],
  tasks: [
    {
      id: "score_matrix",
      description:
        "Invoke failure_mode_matrix_score resolver: reads all *.json in scenarios_dir, " +
        "calls discover-by-shapes per scenario, aggregates into failureModeReport.",
      resolver: "development-vessel:failure_mode_matrix_score",
      config: {
        type: "failure_mode_matrix_score",
        scenarios_dir: "{{scenarios_dir}}",
        label: "{{label}}",
        out_path: "{{out_path}}",
      },
      outputShapes: ["failureModeReport"],
    },
  ],
};
