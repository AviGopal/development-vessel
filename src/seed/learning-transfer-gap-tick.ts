import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const LEARNING_TRANSFER_GAP_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:learning-transfer-gap-tick",
  name: "learning-transfer-gap-tick",
  description:
    "Detector tick: invokes learning_transfer_report(emit_gap) to measure where cross-activity " +
    "learning fails to flow (successor-feature transfer coverage, genuine composition-credit density " +
    "vs new-uninformed-cell rate, stalled credit chains) and files a substrateGap(performance_inefficiency) " +
    "when SF-transfer coverage is below floor, so the gap_to_feature -> feature_compose loop authors a fix. " +
    "Tagged intent:learning_transfer, phase:measure.",
  inputShapes: [],
  outputShapes: ["learningTransferReport"],
  tags: ["intent:learning_transfer", "phase:measure", "detector"],
  variables: [
    { name: "sf_coverage_floor", description: "SF-coverage floor below which a gap is filed (default 0.5)." },
  ],
  tasks: [
    {
      id: "scan_learning_transfer",
      description:
        "Invoke learning_transfer_report with emit_gap=true. Reads variant_performance_metrics, " +
        "activity_composition_graph, successor_features and files a substrateGap when SF coverage is low.",
      resolver: "development-vessel:learning_transfer_report",
      config: { type: "learning_transfer_report", emit_gap: true },
      outputShapes: ["learningTransferReport"],
    },
  ],
};
