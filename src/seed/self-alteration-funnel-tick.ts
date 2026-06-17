import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * self-alteration-funnel-tick — autonomous self-detection of the self-alteration
 * pipeline's EMERGENT health. The substrate already detects per-step failures
 * (detect-unclassified_failure_* per resolver); this rolls those into the FUNNEL
 * the per-step detectors can't see — draft → apply → stage → cutover conversion —
 * and emits a substrateGap when conversion collapses (e.g. proposals authored but
 * 0 staged), citing the stuck stage + likely cause so the gap is actionable.
 *
 * Same shape as cost-expectation-audit-tick: deterministic (no LLM), boredom-
 * selectable, emits a first-class substrate gap. This is the detection the
 * operator had to perform by hand; making it autonomous is a step toward the
 * substrate noticing its own loop stalls (S2→S3 readiness).
 */
export const SELF_ALTERATION_FUNNEL_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:self-alteration-funnel-tick",
  name: "self-alteration-funnel-tick",
  description:
    "Rolls up the self-alteration pipeline into a funnel (proposals authored → mitoses staged → " +
    "cutovers landed) over a recent window and emits a substrateGap when end-to-end conversion " +
    "collapses (0 staged despite N proposals, or staged-but-not-landed), localizing the stuck " +
    "stage with cited evidence. Also flags a stale-proposal backlog poisoning FIFO apply. " +
    "Deterministic (no LLM). The emergent self-detection the per-step failure detectors lack.",
  inputShapes: [],
  outputShapes: ["selfAlterationFunnelReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "scan_self_alteration_funnel",
      description:
        "Run self_alteration_funnel_scan over the proposals dir, staged mitosis dirs, and " +
        "mitosis-applied.jsonl; emit a substrateGap per pipeline-throughput / stale-backlog finding.",
      resolver: "self_alteration_funnel_scan",
      config: {
        type: "self_alteration_funnel_scan",
        windowHours: 6,
        minProposals: 5,
      },
      outputShapes: ["selfAlterationFunnelReport"],
    },
  ],
};
