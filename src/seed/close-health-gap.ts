import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * close-health-gap — closes the diagnostic→action loop for health confidence.
 *
 * Problem this solves: previously, confidence_passing=False required operator
 * intervention to identify and manually run the right templates. The substrate
 * had no mechanism to self-identify the cheapest fix and execute it.
 *
 * Diagnostic→action loop:
 *   1. substrate-health-tick → confidence_passing verdict
 *   2. reachable-unlearned-report → below_confidence_floor list
 *      (sorted by fewest additional runs needed)
 *   3. Extract top_below_floor_template_id (deterministic, no LLM needed)
 *   4. http_fetch → goal-host-vessel /run-goal with that template
 *
 * Per boredom cycle: one template dispatched. Successive cycles build
 * cumulative evidence until confidence threshold is met.
 *
 * Added to boredom rotation as goal[2] (after substrate-health-tick goal[1]).
 */
export const CLOSE_HEALTH_GAP_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:close-health-gap",
  name: "close-health-gap",
  description:
    "Self-healing loop for confidence gap: reads health verdict, identifies the " +
    "template with fewest runs needed to cross the confidence floor, and dispatches " +
    "it to goal-host-vessel. No-ops when confidence is already passing. The substrate " +
    "selects which template to run based on its own diagnosis, not operator judgment.",
  inputShapes: ["substrateHealthReport", "reachableButUnlearnedReport"],
  outputShapes: ["healthGapDispatch"],
  tags: ["self-healing.confidence.gap", "lift.autonomous.loop", "health.remediation"],
  tasks: [
    {
      id: "check_health",
      description: "Get current health verdict — specifically confidence_passing.",
      resolver: "substrate_health_tick",
      config: { type: "substrate_health_tick" },
      outputShapes: ["substrateHealthReport"],
    },
    {
      id: "get_below_floor",
      description:
        "Get templates below confidence floor, sorted cheapest-fix first. " +
        "top_below_floor_template_id is the substrate's own diagnosis of what to run next.",
      resolver: "reachable_unlearned_report",
      config: {
        type: "reachable_unlearned_report",
        confidence_floor: 10,
      },
      outputShapes: ["reachableButUnlearnedReport"],
    },
    {
      id: "extract_target",
      description:
        "Extract top_below_floor_template_id from the unlearned report. " +
        "This is the template the substrate diagnosed as needing the most-urgent attention.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{get_below_floor_content}}",
        path: "top_below_floor_template_id",
      },
    },
    {
      id: "dispatch_fix",
      description:
        "If the substrate identified a below-floor template, dispatch it to goal-host-vessel. " +
        "goal-host-vessel handles null/empty targetTemplateId gracefully (falls back to Thompson). " +
        "This is the action step: substrate executes its own diagnosis.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8210/run-goal",
        headers: { "Content-Type": "application/json" },
        body: "{\"goal\":\"run template for confidence gap closure\",\"targetTemplateId\":\"{{extract_target_text}}\",\"variables\":{\"source\":\"close-health-gap\"}}",
      },
    },
    {
      id: "record_action",
      description: "Write a record of what was dispatched so audit agents can verify the decision.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/health-gap-closures/latest.json",
        content:
          "{\"dispatched_at\":\"{{check_health_text}}\",\"template_id\":\"{{extract_target_text}}\",\"dispatch_response\":\"{{dispatch_fix_text}}\"}",
      },
    },
  ],
};
