import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * self-fact-reconcile-tick — deterministic single-resolver wrapper around
 * self_fact_reconcile. On each tick the substrate re-reads four facts about itself
 * (fleet inventory copy, authoring roots, manifest checkout lag, typecheck lane
 * coverage) against their sources, plants a canary, and files each divergence as
 * a self-verifying Class-2 gap. Tagged like the other shadow-state observers so
 * boredom selects it by rhythm; no LLM, no writes except gaps.
 */
export const SELF_FACT_RECONCILE_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:self-fact-reconcile-tick",
  name: "self-fact-reconcile-tick",
  description:
    "Deterministic single-resolver wrapper around self_fact_reconcile. Diffs facts " +
    "the substrate holds about itself against the copies it reads (deploy-side " +
    "inventory vs source inventory; authoring roots vs service vessels; manifest " +
    "checkout vs super-repo; tsconfig include vs directories holding TypeScript), " +
    "plants a canary so a clean result is attributed, and files each divergence as " +
    "a substrateGap whose Class-2 evidence_resolve re-runs this resolver.",
  inputShapes: [],
  outputShapes: ["selfFactReconcileReport"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "reconcile_self_facts",
      description: "Invoke self_fact_reconcile with the canary planted and gap filing on.",
      resolver: "self_fact_reconcile",
      config: { type: "self_fact_reconcile", plant_canary: true, file_gaps: true },
      outputShapes: ["selfFactReconcileReport"],
    },
  ],
};
