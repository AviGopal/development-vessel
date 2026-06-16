import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * drafter-trigger-tick (V18, 2026-06-07) — bridges boredom rotation to the
 * variable-supply requirement of draft-gap-closing-activity.
 *
 * Why this exists: the substrate is a demand-pull architecture. Consumers
 * declare inputShapes; the binding-layer backward-chains to find producers.
 * draft-gap-closing-activity (goal[8]) needs scenario_id + report_path
 * variables, which boredom can't seed. Without an upstream activity that
 * picks a scenario and dispatches the drafter with those variables filled,
 * the chain dead-ends at goal[8] precondition-rejection.
 *
 * This template closes the loop. Three tasks:
 *  1. fs_list /workspace/validation/failure-modes/scenarios → directoryListing
 *  2. extract entries[0].name (deterministic — drafter has its own
 *     "skip if ≥3 proposals in 7d" rate-limit, so re-picking the same
 *     oldest entry is idempotent)
 *  3. http_fetch POST to light-dispatch :8280/dispatch with
 *     template_id=draft-gap-closing-activity + scenario_id + paths filled in
 *
 * Tagged boredom_target_template so it enters the rotation. Has zero
 * inputShapes and zero variables → boredom can always dispatch it.
 *
 * After this tick fires:
 *   drafter runs with vars → new gap-closing:auto-* variant registered
 *   → dispatch-latest-auto-draft (goal[22]) picks it up
 *   → variant runs with V15-tightened TASK 3 prompt
 *   → produces canonical kind:patch_proposal report
 *   → apply-proposal-as-patch finds eligible proposal
 *   → mitosis-tick auto-evaluates (typecheck → FAVORABLE)
 *   → cutover emits host-sync intent
 *   → poller commits + pushes
 */
export const DRAFTER_TRIGGER_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:drafter-trigger-tick",
  name: "drafter-trigger-tick",
  description:
    "Value-ranks open/materialized/undrafted scenarios (category priority -> " +
    "severity -> recency) and dispatches draft-gap-closing-activity on the top " +
    "and dispatches draft-gap-closing-activity via light-dispatch with " +
    "scenario_id + paths filled in. Closes the producer-chain gap that " +
    "prevents the drafter from running autonomously via boredom rotation. " +
    "Idempotent: the drafter has its own rate-limit (skip if ≥3 proposals " +
    "in last 7 days for the picked scenario).",
  inputShapes: [],
  outputShapes: ["priorityScenarioPick"],
  tags: [
    "lift.autonomous.loop",
    "validation.failure.modes",
    "gap.closing",
    "boredom_target_template",
    "producer-chain.bridge",
  ],
  variables: [],
  tasks: [
    {
      id: "pick_and_dispatch",
      description:
        "Value-rank open/materialized/undrafted scenarios (category priority -> " +
        "severity -> recency) and dispatch draft-gap-closing-activity on the top " +
        "pick in ONE atomic resolver call. Replaces the prior fs_list-shuffle " +
        "random pick (defect b): a coin-flip over hundreds of scenarios left " +
        "high-priority self-detected gaps undrafted for hours. " +
        "pick_priority_scenario supplies scenario_id + paths to the drafter " +
        "itself, so there is no fragile cross-task interpolation to drop vars " +
        "(the empty-vars no_op failure mode).",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8090/v2/impulses/resolve",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "ApiKey ${METABOB_API_KEY}",
        },
        body: JSON.stringify({
          impulse: {
            type: "pick_priority_scenario",
            dispatch_drafter: true,
            scenarios_dir: "/workspace/validation/failure-modes/scenarios",
            light_dispatch_url: "http://127.0.0.1:8280/dispatch",
            drafter_template_id: "development-vessel:draft-gap-closing-activity",
          },
        }),
        timeoutMs: 130000,
      },
      outputShapes: ["priorityScenarioPick"],
    },
  ],
};
