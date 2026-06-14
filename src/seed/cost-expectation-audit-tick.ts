import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * cost-expectation-audit-tick — the return-edge for the V30 cost-aware selector.
 * Runs cost_expectation_scan over the selector's own cost snapshot and emits a
 * substrateGap when the cost model is miscalibrated or a template is cost-
 * inefficient. This makes "detection of costs/constraints via our expectations"
 * autonomous: the cost signal V30 predicts + validates now routes into the
 * gap → bridge → drafter loop instead of sitting unread.
 *
 * Same shape as detector-coverage-audit-tick: deterministic (no LLM), boredom-
 * selectable (boredom_target_template tag), emits a first-class substrate gap.
 * SUBSTRATE_AS_MDP §6 (validation/return-edge) + §8.4 (the inefficient-template
 * gap's natural fix is tier-refinement).
 */

export const COST_EXPECTATION_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:cost-expectation-audit-tick",
  name: "cost-expectation-audit-tick",
  description:
    "Reads the cost-aware selector snapshot (boredom-selector-state.json) and emits a " +
    "substrateGap when the cost model is miscalibrated (cost_model_verdict=surprising) or a " +
    "template is cost-inefficient (productive but >= 2x pool-median wall-clock). Turns the " +
    "substrate's validated cost expectations into actionable gaps. Deterministic (no LLM). " +
    "Closes the cost-detection loop: cost = negative reward-vector component, routed to drafter.",
  inputShapes: [],
  outputShapes: ["costExpectationReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "cost.detection", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "scan_cost_expectations",
      description:
        "Run cost_expectation_scan over the selector cost snapshot; emit a substrateGap per " +
        "cost-model-miscalibration or cost-inefficient template.",
      resolver: "cost_expectation_scan",
      config: {
        type: "cost_expectation_scan",
        costMultiple: 2.0,
        minMean: 0.5,
        minPicks: 5,
        emit_gap: true,
      },
      outputShapes: ["costExpectationReport"],
    },
  ],
};
