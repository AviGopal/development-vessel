import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * gap-to-scenario-bridge-tick — Break 1 close (2026-06-04).
 *
 * Single-task wrapper around gap_to_scenario_bridge. Reads open substrateGap
 * rows from WORKSPACE_ROOT/gaps/gaps.json and writes corresponding scenario
 * JSON files into WORKSPACE_ROOT/validation/failure-modes/scenarios/ so the
 * existing file-polling draft-gap-closing-activity drafter naturally absorbs
 * detector-emitted and operator-seeded gaps.
 *
 * Immunity-pattern compliant — empty inputShapes, empty variables, single
 * deterministic server-side resolver. No LLM, no pool iteration.
 */
export const GAP_TO_SCENARIO_BRIDGE_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:gap-to-scenario-bridge-tick",
  name: "gap-to-scenario-bridge-tick",
  description:
    "Deterministic single-resolver wrapper around gap_to_scenario_bridge. " +
    "Drains WORKSPACE_ROOT/gaps/gaps.json open gaps (source=operator_seed | " +
    "substrate_detected) into scenario JSON files the drafter consumes. " +
    "Returns bridgeResult { scenarios_written, gaps_skipped_existing, scenarios }.",
  inputShapes: [],
  outputShapes: ["bridgeResult"],
  tags: [
    "intent:gap_drain",
    "phase:bridge",
    "topology.discovery.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "bridge_gaps_to_scenarios",
      description:
        "Invoke gap_to_scenario_bridge resolver. Idempotent — skips gaps whose " +
        "scenario file already exists. Bounded by limit (default 10).",
      resolver: "gap_to_scenario_bridge",
      config: {
        type: "gap_to_scenario_bridge",
      },
      outputShapes: ["bridgeResult"],
    },
  ],
};
