import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROBE_UNTRAVERSED_EDGE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-untraversed-edge",
  name: "probe-untraversed-edge",
  description:
    "Reads the most recent learnedTopologySnapshot, selects the first untraversed composition " +
    "edge (from_activity→via_shape→to_activity), and dispatches activity_recommend to " +
    "produce the intermediate shape. Tagged intent:topology_discovery, phase:probe.",
  inputShapes: ["learnedTopologySnapshot"],
  outputShapes: ["activityRecommendation", "topologyGapReport"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop"],
  variables: [
    {
      name: "snapshot_path",
      description:
        "Filesystem path to the learnedTopologySnapshot JSON (fallback when impulse binding is unavailable).",
    },
  ],
  tasks: [
    {
      id: "read_snapshot",
      description: "Load the learnedTopologySnapshot from disk.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "{{snapshot_path}}",
      },
      outputShapes: ["learnedTopologySnapshot"],
    },
    {
      id: "extract_edge_shape",
      description:
        "Extract the via_shape of the first untraversed edge. " +
        "This is the intermediate impulse shape that needs to flow between the two templates.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_snapshot_content}}",
        path: "untraversed_edges[0].via_shape",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_from_activity",
      description: "Extract the producer template id for this edge.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_snapshot_content}}",
        path: "untraversed_edges[0].from_activity",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "recommend",
      description:
        "Recommend activities that produce the untraversed edge's via_shape, " +
        "seeding the recommendation with the known producer template.",
      resolver: "activity_recommend",
      config: {
        type: "activity_recommend",
        goal: "traverse edge from {{extract_from_activity_valueJson}} by producing shape {{extract_edge_shape_valueJson}}",
        expected_output_shapes: ["{{extract_edge_shape_valueJson}}"],
        intent_tag: "topology_discovery",
      },
      outputShapes: ["activityRecommendation"],
    },
  ],
};
