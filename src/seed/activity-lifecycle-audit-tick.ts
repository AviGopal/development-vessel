import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const ACTIVITY_LIFECYCLE_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:activity-lifecycle-audit-tick",
  name: "activity-lifecycle-audit-tick",
  description:
    "Deterministic single-resolver wrapper around activity_lifecycle_audit. " +
    "Ranks templates by success × recency × signature-affinity; surfaces hot/cold/promote " +
    "sets. Used by boredom goal[19] to drive future lifecycle-hook activities.",
  inputShapes: [],
  outputShapes: ["activityLifecycleAudit"],
  tags: [
    "intent:horizon_detection",
    "horizon:activity",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_activity_lifecycle",
      description:
        "Invoke activity_lifecycle_audit. Reads templates + traces, computes per-template " +
        "scores, recommends LOAD / UNLOAD / PROMOTE_PROPOSED sets.",
      resolver: "activity_lifecycle_audit",
      config: { type: "activity_lifecycle_audit" },
      outputShapes: ["activityLifecycleAudit"],
    },
  ],
};
