import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * vessel-responsibility-audit-tick — single-task wrapper around the
 * vessel_responsibility_audit horizon detector. Immunity-pattern compliant
 * (empty inputShapes, empty variables, single resolver). Boredom goal[17]
 * targets this template explicitly so the goal text routes deterministically.
 */
export const VESSEL_RESPONSIBILITY_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:vessel-responsibility-audit-tick",
  name: "vessel-responsibility-audit-tick",
  description:
    "Deterministic single-resolver wrapper around vessel_responsibility_audit. " +
    "Scans vessel source trees against architectural_pattern_principle concepts " +
    "with severity=structural and emits substrateGap impulses for responsibility " +
    "misallocations. Used by boredom goal[17].",
  inputShapes: [],
  outputShapes: ["vesselResponsibilityAudit"],
  tags: [
    "intent:horizon_detection",
    "horizon:vessel",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_vessel_responsibilities",
      description:
        "Invoke vessel_responsibility_audit. Reads architectural_pattern_principle " +
        "concepts from concept-db, scans vessel sources, emits responsibility_misallocation " +
        "substrateGaps for matches.",
      resolver: "vessel_responsibility_audit",
      config: { type: "vessel_responsibility_audit" },
      outputShapes: ["vesselResponsibilityAudit"],
    },
  ],
};
