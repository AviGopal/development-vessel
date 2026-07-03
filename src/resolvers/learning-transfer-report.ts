import type { ResolverResult } from "./types.js";

export interface LearningTransferReportPointer {
  type: "learning_transfer_report";
  limit?: number;
}

export async function resolveLearningTransferReport(
  _pointer: LearningTransferReportPointer,
): Promise<ResolverResult> {
  return {
    shape: "learningTransferReport",
    body: {
      scanned: false,
      note: "skeleton — cross-activity learning-transfer scan not yet implemented",
      crystallized_cells: null,
      stalled_credit_chains: null,
      genuine_edge_density: null,
      sf_coverage: null,
    },
  };
}
