import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const RESOLVER_DISTRIBUTION_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:resolver-distribution-audit-tick",
  name: "resolver-distribution-audit-tick",
  description:
    "Deterministic single-resolver wrapper around resolver_distribution_audit. " +
    "Reads discovery /shapes + templates + traces + principle concepts. Flags shape " +
    "orphans, demand-supply mismatches, and responsibility-imbalance per architectural " +
    "principle. Used by boredom goal[20].",
  inputShapes: [],
  outputShapes: ["resolverDistributionAudit"],
  tags: [
    "intent:horizon_detection",
    "horizon:resolver_distribution",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
  ],
  variables: [],
  tasks: [
    {
      id: "audit_resolver_distribution",
      description:
        "Invoke resolver_distribution_audit. Reads discovery /shapes registry, traces, " +
        "templates, and architectural_pattern_principle concepts. Emits substrateGaps for " +
        "shape orphans, demand/supply mismatches, and principle-violating distribution.",
      resolver: "resolver_distribution_audit",
      config: { type: "resolver_distribution_audit" },
      outputShapes: ["resolverDistributionAudit"],
    },
  ],
};
