import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const CODE_LOCALITY_MINING_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:code-locality-mining-tick",
  name: "code-locality-mining-tick",
  description:
    "Consolidates span-level edit provenance from favorable compose-reports into a persisted code-locality index — P(span relevant | activity family). Expertise consolidation: many episodes, one indexed association. Deterministic.",
  inputShapes: [],
  outputShapes: ["codeLocalityIndex"],
  tags: ["lift.autonomous.loop", "code.locality", "boredom_target_template"],
  variables: [],
  tasks: [
    {
      id: "mine_locality_index",
      description:
        "Scan favorable compose-reports and persist the code-locality index.",
      resolver: "code_locality_mining_tick",
      config: { type: "code_locality_mining_tick" },
      outputShapes: ["codeLocalityIndex"],
    },
  ],
};
