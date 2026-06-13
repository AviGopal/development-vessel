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
    "Picks the oldest scenario from /workspace/validation/failure-modes/scenarios " +
    "and dispatches draft-gap-closing-activity via light-dispatch with " +
    "scenario_id + paths filled in. Closes the producer-chain gap that " +
    "prevents the drafter from running autonomously via boredom rotation. " +
    "Idempotent: the drafter has its own rate-limit (skip if ≥3 proposals " +
    "in last 7 days for the picked scenario).",
  inputShapes: [],
  outputShapes: ["autoDraftDispatchResult"],
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
      id: "list_scenarios",
      description:
        "Enumerate scenario JSON files in the validation/failure-modes/scenarios dir.",
      resolver: "fs_list",
      config: {
        type: "fs_list",
        path: "/workspace/validation/failure-modes/scenarios",
        glob: "*.json",
        max_depth: 0,
        // V26 (2026-06-09): shuffle so entries[0].name rotates across scenarios
        // instead of always returning the alphabetic-first id. Without this,
        // drafter's 3-per-7-day rate-limit blocks new variants and V25
        // canonical-prompt override never exercises.
        shuffle: true,
      },
      outputShapes: ["directoryListing"],
    },
    {
      id: "extract_scenario_name",
      description:
        "Extract entries[0].name — the first scenario file. Deterministic pick. " +
        "Drafter's internal rate-limit skips already-drafted scenarios so this " +
        "is idempotent even if the same name comes up repeatedly.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{list_scenarios_content}}",
        path: "entries.0.name",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_scenario_id",
      description:
        "Strip .json extension from the filename to get the scenario_id. " +
        "draft-gap-closing-activity's read_scenario task constructs " +
        "{scenarios_dir}/{scenario_id}.json so we must NOT pass .json here.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{\"name\":\"{{extract_scenario_name_value}}\"}",
        path: "name",
        strip_suffix: ".json",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "dispatch_drafter",
      description:
        "POST to light-dispatch with template_id=draft-gap-closing-activity " +
        "and the chosen scenario_id + paths. Light-dispatch runs the drafter " +
        "synchronously, returns dispatchId + executionId. The drafter's tasks " +
        "register a new variant via activity_create_variant — that variant " +
        "carries the V15-tightened TASK 3 prompt so its output is canonical " +
        "kind:patch_proposal shape.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        url: "http://127.0.0.1:8280/dispatch",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "ApiKey ${METABOB_API_KEY}",
        },
        body: JSON.stringify({
          template_id: "development-vessel:draft-gap-closing-activity",
          variables: {
            report_path:
              "/workspace/validation/failure-modes/scenarios/{{extract_scenario_name_value}}",
            scenario_id: "{{extract_scenario_id_value}}",
            proposals_dir: "/workspace/proposals",
            scenarios_dir: "/workspace/validation/failure-modes/scenarios",
          },
        }),
        timeoutMs: 60000,
      },
      outputShapes: ["autoDraftDispatchResult"],
    },
  ],
};
