import type { ResolverResult } from "./types.js";

/**
 * composition_flow_health_scan — detector for composition-graph flow health.
 * Computes connected-component count of the genuine composition graph, genuine
 * edges per cell, and bridges-minted per reached chain, reusing the readers that
 * already exist (learning_transfer_report + the activity_composition_graph and
 * goal_execution_paths tables). Files a substrateGap with the STABLE id
 * gap-composition-flow-components-split when the genuine graph has more than one
 * component (credit cannot mix across components — the standing two-component
 * split finding).
 */
export interface CompositionFlowHealthScanPointer {
  type: "composition_flow_health_scan";
  /** Cap on composition edges scanned. Default 10000. */
  edgeLimit?: number;
  /** Override dev-vessel impulses URL (self-POST). */
  devVesselImpulsesUrl?: string;
  /** dry_run = true: scan + report but do not POST gaps. */
  dry_run?: boolean;
}

export async function resolveCompositionFlowHealthScan(
  pointer: CompositionFlowHealthScanPointer,
): Promise<ResolverResult> {
  // SKELETON (2026-07-04): graph analysis behavior lands in the follow-up compose.
  return {
    shape: "compositionFlowHealthReport",
    body: {
      scanned: false,
      verdict: "skeleton",
      edge_limit: pointer.edgeLimit ?? 10000,
      note: "skeleton only — graph analysis behavior lands in the follow-up compose",
    },
  };
}
