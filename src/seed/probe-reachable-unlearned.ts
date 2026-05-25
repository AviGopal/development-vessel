import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROBE_REACHABLE_UNLEARNED_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-reachable-unlearned",
  name: "probe-reachable-unlearned",
  description:
    "Reads the most recent reachableButUnlearnedReport, selects the highest-priority " +
    "unlearned shape, and dispatches an activity_recommend call with a synthetic goal of " +
    "'produce shape <X>'. The activityRecommendation output is consumed downstream by the " +
    "lifecycle observer (recommend → slot-binding → execute via goal-host-vessel). " +
    "Tagged intent:topology_discovery.",
  inputShapes: ["reachableButUnlearnedReport"],
  outputShapes: ["activityRecommendation"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop"],
  variables: [],
  tasks: [
    {
      id: "get_report",
      description:
        "Call the reachable_unlearned_report resolver directly to get the current list " +
        "of shapes that have templates but no execution traces.",
      resolver: "reachable_unlearned_report",
      config: {
        type: "reachable_unlearned_report",
        lookback_window_seconds: 3600,
      },
      outputShapes: ["reachableButUnlearnedReport"],
    },
    {
      id: "recommend",
      description:
        "Ask activity_recommend for activities that produce the top unlearned shape. " +
        "The trace is tagged intent:topology_discovery so the observer can re-trigger " +
        "measurement. Execution of the recommended template is downstream via the " +
        "standard lifecycle:substrate:idle → recommend → execute path.",
      resolver: "activity_recommend",
      config: {
        type: "activity_recommend",
        task_description: "produce shape {{get_report_top_shape}}",
        expected_output_shapes: ["{{get_report_top_shape}}"],
        intent_tag: "topology_discovery",
      },
      outputShapes: ["activityRecommendation"],
    },
  ],
};
