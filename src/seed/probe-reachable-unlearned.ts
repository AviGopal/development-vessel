import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROBE_REACHABLE_UNLEARNED_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-reachable-unlearned",
  name: "probe-reachable-unlearned",
  description:
    "Reads the most recent reachableButUnlearnedReport impulse, selects the highest-priority " +
    "unlearned shape, and dispatches an activity_recommend call with a synthetic goal of " +
    "'produce shape <X>'. The recommended activity execution is the downstream step; this " +
    "template does the selection and tagging. Tagged intent:topology_discovery.",
  inputShapes: ["reachableButUnlearnedReport"],
  outputShapes: ["activityRecommendation"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop"],
  variables: [
    {
      name: "report_path",
      description:
        "Filesystem path to the reachableButUnlearnedReport JSON (fallback when impulse binding is unavailable).",
    },
  ],
  tasks: [
    {
      id: "read_report",
      description:
        "Load the reachableButUnlearnedReport from disk so we can select the top shape.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{report_path}}",
      },
      outputShapes: ["reachableButUnlearnedReport"],
    },
    {
      id: "extract_top_shape",
      description: "Extract the shape name of the highest-priority entry (entries[0].shape).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_report_content}}",
        path: "entries[0].shape",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "recommend",
      description:
        "Ask activity_recommend for activities that produce the top unlearned shape. " +
        "The trace is tagged intent:topology_discovery so the observer can re-trigger measurement.",
      resolver: "activity_recommend",
      config: {
        type: "activity_recommend",
        goal: "produce shape {{extract_top_shape_valueJson}}",
        expected_output_shapes: ["{{extract_top_shape_valueJson}}"],
        intent_tag: "topology_discovery",
      },
      outputShapes: ["activityRecommendation"],
    },
  ],
};
