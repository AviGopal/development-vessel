import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const SUBSTRATE_HEALTH_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:substrate-health-tick",
  name: "substrate-health-tick",
  description:
    "Aggregator: queries variant_performance_metrics (posterior confidence), template creation " +
    "rate (graph stability), and the most recent stratified-harness report (optimality). " +
    "Emits substrateHealthReport with health_verdict.overall_passing. " +
    "Sibling to coverage-tick; together the two aggregators provide the substrate-measured " +
    "half of the lift hand-over criterion. Tagged intent:topology_discovery, phase:measure.",
  inputShapes: [],
  outputShapes: ["substrateHealthReport"],
  tags: ["intent:topology_discovery", "phase:measure", "topology.discovery.loop", "lift.criterion"],
  variables: [
    {
      name: "lookback_window_seconds",
      description: "Lookback window for stability + confidence measurement (default 3600).",
    },
  ],
  tasks: [
    {
      id: "compute_health",
      description:
        "Invoke substrate_health_tick resolver which checks posterior confidence, graph " +
        "stability, and optimality (if harness data is available). Emits substrateHealthReport.",
      resolver: "development-vessel:substrate_health_tick",
      config: {
        type: "substrate_health_tick",
        lookback_window_seconds: 3600,
      },
      outputShapes: ["substrateHealthReport"],
    },
  ],
};
