import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const ESCALATE_UNKNOWN_SHAPE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:escalate-unknown-shape",
  name: "escalate-unknown-shape",
  description:
    "Reads the most recent unknownShapeReport, selects the highest-mention-count unknown shape, " +
    "and dispatches create-shape-provider-goal (the canonical escalation primitive) via " +
    "activity_fetch + recommend. If no unknown shapes exist the template short-circuits via " +
    "the json_path_extract empty check. Tagged intent:topology_discovery, phase:probe.",
  inputShapes: ["unknownShapeReport"],
  outputShapes: ["activityRecommendation"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop", "escalation"],
  variables: [
    {
      name: "report_path",
      description:
        "Filesystem path to the unknownShapeReport JSON (fallback when impulse binding is unavailable).",
    },
  ],
  tasks: [
    {
      id: "read_report",
      description: "Load the unknownShapeReport from disk.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{report_path}}",
      },
      outputShapes: ["unknownShapeReport"],
    },
    {
      id: "extract_top_unknown",
      description:
        "Extract the shape name with the highest mention_count (list is pre-sorted desc). " +
        "If the list is empty this value will be null; downstream task should check.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_report_content}}",
        path: "unknown_shapes[0].shape",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "recommend_provider",
      description:
        "Recommend create-shape-provider-goal via activity_recommend, scoped to the top unknown shape. " +
        "This is the canonical escalation path per foundation §819–820: spawn a sub-goal to produce " +
        "the missing shape rather than attempting direct improvisation here.",
      resolver: "activity_recommend",
      config: {
        type: "activity_recommend",
        goal: "create a provider for unknown shape {{extract_top_unknown_valueJson}}",
        expected_output_shapes: ["shapeProviderGoal"],
        intent_tag: "topology_discovery",
      },
      outputShapes: ["activityRecommendation"],
    },
  ],
};
