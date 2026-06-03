import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * vessel-demand-tick — single-task wrapper around vessel_demand_report.
 *
 * Without this template, boredom-vessel's goal[12] open-ended text would
 * route through goal-host's LLM-reuse path, semantically mapping the goal
 * to whatever existing template is closest in vector space (observed
 * 2026-06-03: mapped to detect-service-oom-cascade — adjacent but wrong).
 *
 * Wiring `AUTONOMOUS_GOAL_TARGET_TEMPLATES[12] = "development-vessel:vessel-demand-tick"`
 * bypasses LLM-reuse entirely; goal[12] becomes a deterministic resolver
 * dispatch with predictable alignment between goal text and trace outcome.
 *
 * Immunity-pattern compliant — empty inputShapes, empty variables, single
 * server-side resolver task. The detector itself cannot pre-flight-reject.
 */

export const VESSEL_DEMAND_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vessel-demand-tick",
  name: "vessel-demand-tick",
  description:
    "Deterministic single-resolver wrapper around vessel_demand_report. Surfaces capability " +
    "shapes required by N+ templates with zero vessel advertising them. Used by boredom goal[12] " +
    "to autonomously check whether substrate should author a new vessel. Returns vesselDemandReport " +
    "with prioritized demand entries (capability-classified, domain entities filtered out). " +
    "Tagged intent:vessel_authoring, phase:trigger.",
  inputShapes: [],
  outputShapes: ["vesselDemandReport"],
  tags: ["intent:vessel_authoring", "phase:trigger", "topology.discovery.loop", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "scan_vessel_demand",
      description:
        "Invoke vessel_demand_report resolver. Reads activity-api templates + discovery /shapes; " +
        "classifies inputShapes as capability vs domain entity; emits substrateGap_write for each " +
        "capability shape demanded by >=3 templates with zero supply. Returns vesselDemandReport.",
      resolver: "vessel_demand_report",
      config: {
        type: "vessel_demand_report",
      },
      outputShapes: ["vesselDemandReport"],
    },
  ],
};
