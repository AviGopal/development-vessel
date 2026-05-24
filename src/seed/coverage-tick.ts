import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const COVERAGE_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:coverage-tick",
  name: "coverage-tick",
  description:
    "Aggregator: reads N successive time windows of topology data and emits a coverageReport " +
    "with 4-cell monotonicity metrics. coverage_progress=true when reachable_learned is strictly " +
    "increasing and decreasing metrics are non-worsening across ≥3 consecutive windows. " +
    "One of the two measurement sources feeding the lift hand-over decision (the other is " +
    "substrate-health-tick). Tagged intent:topology_discovery, phase:measure.",
  inputShapes: [],
  outputShapes: ["coverageReport"],
  tags: ["intent:topology_discovery", "phase:measure", "topology.discovery.loop", "lift.criterion"],
  variables: [
    {
      name: "num_windows",
      description: "Number of time windows to compare (default 4).",
    },
    {
      name: "window_size_seconds",
      description: "Duration of each window in seconds (default 3600).",
    },
  ],
  tasks: [
    {
      id: "compute_coverage",
      description:
        "Invoke coverage_tick resolver which fetches templates + execution-traces across " +
        "N time windows and computes monotonicity. Emits coverageReport with coverage_progress boolean.",
      resolver: "development-vessel:coverage_tick",
      config: {
        type: "coverage_tick",
        num_windows: 4,
        window_size_seconds: 3600,
      },
      outputShapes: ["coverageReport"],
    },
  ],
};
