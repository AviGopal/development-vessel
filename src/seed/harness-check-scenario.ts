import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * harness-check-scenario — scores a single failure-mode scenario against
 * the live activity-api and writes the outcome to a results file.
 *
 * This is the seed-template equivalent of the failure-mode-harness.ts script.
 * One invocation = one scenario. Wire N executions in parallel (or in sequence
 * via an iteration template) to score the full matrix.
 *
 * Variables:
 *   scenario_path  — absolute/relative path to the scenario JSON file
 *   out_path       — path to write the ScenarioOutcome JSON
 */
export const HARNESS_CHECK_SCENARIO_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:harness-check-scenario",
  name: "harness-check-scenario",
  description:
    "Reads a failure-mode scenario JSON, queries activity-api via " +
    "activity_discover_by_shapes (forward mode) to check whether the " +
    "required output shapes are covered, and writes a ScenarioOutcome " +
    "record to the given output path. " +
    "emergence_class is 'reuse' when a matching activity is discovered, " +
    "'gap' otherwise.",
  inputShapes: ["gapScenario"],
  outputShapes: ["scenarioOutcome"],
  tags: ["lift.autonomous.loop", "validation.failure.modes", "harness"],
  variables: [
    {
      name: "scenario_path",
      description: "Path to the scenario JSON file (e.g. validation/failure-modes/scenarios/fp-11.json)",
    },
    {
      name: "out_path",
      description: "Path to write the ScenarioOutcome JSON result",
    },
  ],
  tasks: [
    {
      id: "read_scenario",
      description: "Load the scenario JSON from disk.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{scenario_path}}",
      },
      outputShapes: ["gapScenario"],
    },
    {
      id: "extract_required_shapes",
      description:
        "Extract expected_emergence.activity_signature.output_shapes_must_include " +
        "from the scenario deterministically.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_scenario_content}}",
        path: "expected_emergence.activity_signature.output_shapes_must_include",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_scenario_id",
      description: "Extract the scenario id field.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_scenario_content}}",
        path: "id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "discover_candidates",
      description:
        "Query activity-api for activities that produce the required output shapes. " +
        "Returns emergence_class='reuse' if at least one match exists.",
      resolver: "activity_discover_by_shapes",
      config: {
        type: "activity_discover_by_shapes",
        required_shapes: "{{extract_required_shapes_valueJson}}",
        mode: "forward",
        limit: 10,
      },
      outputShapes: ["discovered_activities"],
    },
    {
      id: "write_outcome",
      description: "Write the ScenarioOutcome record to the output path.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "{{out_path}}",
        content: JSON.stringify({
          scenario_id: "{{extract_scenario_id_value}}",
          dispatched_at: new Date(0).toISOString(),
          emergence_class: "{{discover_candidates_emergence_class}}",
          matched_existing_activity_id: "{{discover_candidates_first_id}}",
          recommendations_returned: 0,
          emergent_trace_id: null,
          self_heal_seconds: null,
          detection_signal_present: false,
          notes: [],
        }),
      },
      outputShapes: ["scenarioOutcome"],
    },
  ],
};
