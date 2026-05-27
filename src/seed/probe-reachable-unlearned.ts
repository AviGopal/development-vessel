import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROBE_REACHABLE_UNLEARNED_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-reachable-unlearned",
  name: "probe-reachable-unlearned",
  description:
    "Emits a reachableButUnlearnedReport impulse (top unlearned shape + best producer). " +
    "The registry-change-observer subscribes to this execution's success event and " +
    "re-derives the top template server-side, then dispatches it via goal-host-vessel. " +
    "This template is intentionally a single-task TRIGGER — it does not perform recommendation " +
    "in-template because activity_recommend with a literal {{get_report_top_shape}} placeholder " +
    "pollutes Thompson with bogus recommendations (the ias-executor-ts engine does not " +
    "interpolate {{}} in non-llm task configs; see memory note feedback_slot_binding_not_resolver_proliferation). " +
    "Tagged intent:topology_discovery.",
  outputShapes: ["reachableButUnlearnedReport"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop"],
  variables: [],
  tasks: [
    {
      id: "get_report",
      description:
        "Call the reachable_unlearned_report resolver to produce a reachableButUnlearnedReport " +
        "impulse with the top unlearned shape and its best producer template. The observer " +
        "(repos/development-vessel/src/observers/registry-change-observer.ts) consumes this " +
        "on execution_completed and dispatches the best producer.",
      resolver: "reachable_unlearned_report",
      config: {
        type: "reachable_unlearned_report",
        lookback_window_seconds: 3600,
      },
      outputShapes: ["reachableButUnlearnedReport"],
    },
  ],
};
