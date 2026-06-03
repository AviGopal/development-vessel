import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const VESSEL_ARCHITECTURE_PATTERN_SCAN_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vessel-architecture-pattern-scan-tick",
  name: "vessel-architecture-pattern-scan-tick",
  description:
    "Deterministic single-resolver wrapper around vessel_architecture_pattern_scan. " +
    "Detects cross-vessel architectural patterns (single-dispatcher SPOF, catalogue-bloat, " +
    "cost-output mismatch, cascading SPOF) from recent traces + discovery registry. " +
    "Emits architectural_pattern substrateGaps. Used by boredom goal[18].",
  inputShapes: [],
  outputShapes: ["vesselArchitecturePatternScan"],
  tags: [
    "intent:horizon_detection",
    "horizon:vessel_architecture",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_architecture_patterns",
      description:
        "Invoke vessel_architecture_pattern_scan. Reads traces + discovery + templates, " +
        "checks for single_dispatcher / catalogue_bloat / cost_output_mismatch / spof_cascade " +
        "patterns, emits substrateGap_write for each finding.",
      resolver: "vessel_architecture_pattern_scan",
      config: { type: "vessel_architecture_pattern_scan" },
      outputShapes: ["vesselArchitecturePatternScan"],
    },
  ],
};
