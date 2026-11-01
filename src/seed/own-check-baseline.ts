import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * own-check-baseline — one gap's own check, run at its vessel's origin/dev and classified (green_at_parent |
 * red_code_reachable | red_environmental | unrunnable) by own_check_baseline_classify, which reads the shaped
 * ownCheckEnvironmentPolicy at use time and writes the reading onto the gap row through substrateGap_write.
 * Dispatched per gap by the gap-check-supply tick (target_template_id, variables gap_id + base_ref); not a
 * boredom target, since it needs a gap. ONE task: the classify step runs the check itself (test_suite), so no
 * array-valued variable is bound into a non-LLM config. Its grade is decided by the readings' CONSUMERS
 * (admission's exclusion, the compose's parent comparison), never by its exit: reach_decided_by "consumer".
 */
export const OWN_CHECK_BASELINE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:own-check-baseline",
  name: "own-check-baseline",
  description:
    "Runs one gap's own check (its evidence_resolve test_suite input) on the pinned base sha and classifies why it is " +
    "red or green there: green_at_parent | red_code_reachable | red_environmental | unrunnable. The environmental " +
    "signals come from the shaped ownCheckEnvironmentPolicy, read at use time. Graded by its consumers' outcome " +
    "(admission exclusion, compose parent comparison), never at exit.",
  // Its one task consumes no pool impulse (it reads the gap row by the gap_id variable), so the declared input shapes
  // are none. Delivered as input_shapes [] (seed/deliver.ts), so activity-api infers nothing from the prose: an
  // inferred "goal" made every goal trace a replay match and gave a variant the same shape signature.
  inputShapes: [],
  outputShapes: ["ownCheckBaseline", "substrateGap"],
  tags: ["lift.autonomous.loop", "phase:supply", "reach_decided_by:consumer"],
  metadata: { seed_version: 2, reach_decided_by: "consumer" },
  variables: [{ name: "gap_id" }, { name: "base_ref" }],
  tasks: [
    {
      id: "classify",
      description: "Run the gap's own check at base_ref and classify it; write the reading onto the gap row.",
      resolver: "own_check_baseline_classify",
      config: { type: "own_check_baseline_classify", gap_id: "{{gap_id}}", base_ref: "{{base_ref}}" },
      outputShapes: ["ownCheckBaseline"],
    },
  ],
};
