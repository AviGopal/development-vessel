import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const PROPAGATE_JUDGMENT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:propagate-judgment",
  name: "propagate-judgment",
  description: "Fold a judgment signal into the Thompson posterior for an activity variant.",
  inputShapes: ["activity_variant_id", "impulse_id", "relevance_score", "source_tier"],
  outputShapes: ["judgmentPropagated"],
  tags: ["learning", "thompson", "judgment"],
  variables: [
    { name: "activity_variant_id", description: "The variant to update" },
    { name: "impulse_id", description: "Impulse that carried the judgment" },
    { name: "relevance_score", description: "Score in [0, 1]" },
    { name: "source_tier", description: "human | verifier | automatic" },
  ],
  tasks: [
    {
      id: "propagate_judgment",
      description: "POST the judgment to activity-api impulse-relevance endpoint.",
      resolver: "propagate_judgment",
      config: {
        type: "propagate_judgment",
        activity_variant_id: "{{activity_variant_id}}",
        impulse_id: "{{impulse_id}}",
        relevance_score: "{{relevance_score}}",
        source_tier: "{{source_tier}}",
      },
      outputShapes: ["judgmentPropagated"],
    },
  ],
};
