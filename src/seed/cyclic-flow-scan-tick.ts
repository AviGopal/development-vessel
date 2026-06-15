import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * cyclic-flow-scan-tick — the substrate's stability detector. Runs
 * cyclic_flow_scan: measures the zero-work (idle/error/failure/no-output)
 * fraction of recent dispatch flow per template and in aggregate, and emits a
 * wastedCycle substrateGap for genuinely-actionable high-cyclic templates.
 *
 * The aggregate cyclic_flow_fraction is the substrate-level STABILITY scalar:
 * lower = less churn = more stable. Paired with detector_coverage's
 * autonomous_closure_ratio (the GROWTH axis) it gives "growing AND stabilizing"
 * a measurable two-axis read each window. The honest discrete analogue of the
 * Hodge cyclic-flow component (SUBSTRATE_AS_MDP §8.3 frontier — not the
 * continuous decomposition). Deterministic; no LLM.
 */

export const CYCLIC_FLOW_SCAN_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:cyclic-flow-scan-tick",
  name: "cyclic-flow-scan-tick",
  description:
    "Runs cyclic_flow_scan over recent dispatch traces: computes per-template and " +
    "aggregate zero-work cyclic-flow fraction (the substrate stability scalar) and " +
    "emits a wastedCycle substrateGap for templates dispatched many times while " +
    "almost never producing useful work (the validator-dispatch livelock signature, " +
    "generalized). Excludes lifecycle meta-activities already covered by phantom/" +
    "precondition detectors. Deterministic stability measurement + emission.",
  inputShapes: [],
  outputShapes: ["cyclicFlowReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "stability.measurement", "boredom_target_template"],
  variables: [],
  cited_concept_ids: ["concept_9ldsmRgqSTd5"],
  tasks: [
    {
      id: "scan_cyclic_flow",
      description:
        "Run cyclic_flow_scan over the recent dispatch window, compute the aggregate " +
        "cyclic_flow_fraction stability scalar, and emit wastedCycle gaps for high-cyclic templates.",
      resolver: "cyclic_flow_scan",
      config: {
        type: "cyclic_flow_scan",
        window_hours: 24,
        trace_limit: 400,
        min_dispatches: 5,
        cyclic_threshold: 0.8,
        emit_gap: true,
      },
      outputShapes: ["cyclicFlowReport"],
    },
  ],
};
