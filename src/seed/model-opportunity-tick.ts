import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * model-opportunity-tick — autonomous lever-3 surface growth. Runs
 * model_opportunity_scan: emits a substrateGap for each high-value pipeline
 * quantity the substrate ACTS ON but does not PREDICT (forward/backward model
 * opportunities). Each proposed model follows the predict→validate→residual
 * template, so building it adds a free residual-detector — widening detectability.
 * Deterministic (no LLM).
 */
export const MODEL_OPPORTUNITY_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:model-opportunity-tick",
  name: "model-opportunity-tick",
  description:
    "Scans for forward/backward model opportunities — quantities the substrate acts on " +
    "but doesn't predict (patch convergence, mitosis verdict, drafter actionability, gap " +
    "landability) — and emits a substrateGap proposing each predict→validate model. Grows " +
    "the detectability surface (each prediction becomes a residual-detector). Deterministic.",
  inputShapes: [],
  outputShapes: ["modelOpportunityReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template"],
  variables: [],
  tasks: [
    { id: "scan_model_opportunities", description: "Run model_opportunity_scan; emit a gap per unmodeled quantity.",
      resolver: "model_opportunity_scan", config: { type: "model_opportunity_scan" }, outputShapes: ["modelOpportunityReport"] },
  ],
};
