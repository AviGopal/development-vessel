import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROBE_REACHABLE_UNLEARNED_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:probe-reachable-unlearned",
  name: "probe-reachable-unlearned",
  description:
    "Finds templates whose output shapes have never appeared in execution traces, " +
    "picks the highest-priority unlearned shape's best producer, and dispatches " +
    "that template via goal-host-vessel — closing the recommend→execute loop. " +
    "Uses the reachable_unlearned_probe resolver which combines get-report and " +
    "dispatch in a single call to avoid inter-task variable interpolation issues. " +
    "Tagged intent:topology_discovery.",
  inputShapes: ["reachableButUnlearnedReport"],
  outputShapes: ["reachableUnlearnedReport"],
  tags: ["intent:topology_discovery", "phase:probe", "topology.discovery.loop"],
  variables: [],
  tasks: [
    {
      id: "probe_and_dispatch",
      description:
        "Fetch the reachable-but-unlearned report, pick the top unlearned shape's " +
        "best producer template, and dispatch it to goal-host-vessel in one step. " +
        "Returns reachableUnlearnedReport with dispatch_id and top_template_id.",
      resolver: "reachable_unlearned_probe",
      config: {
        type: "reachable_unlearned_probe",
        lookback_window_seconds: 3600,
      },
      outputShapes: ["reachableUnlearnedReport"],
    },
  ],
};
