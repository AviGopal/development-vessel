import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * invoke-docs-decision-solicit — a minimal bridge activity that invokes the
 * docs_decision_solicit resolver to close the orphaned-capability gap.
 * 
 * This activity directly calls the docs_decision_solicit resolver which scans
 * for documentation alignment issues that need human decisions. The resolver
 * will emit uiQuestion_write impulses for any gaps that need review.
 */
export const INVOKE_DOCS_DECISION_SOLICIT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:invoke-docs-decision-solicit",
  name: "invoke-docs-decision-solicit",
  description:
    "Bridge activity that invokes the docs_decision_solicit resolver to detect " +
    "documentation alignment issues requiring human decisions. This closes the " +
    "orphaned-capability gap for docs_decision_solicit by exercising the resolver.",
  inputShapes: [],
  outputShapes: ["docsDecisionSolicitReport"],
  tags: [
    "intent:docs_decision",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "bridge_activity",
  ],
  variables: [
    {
      name: "dry_run",
      description: "If true, only scan without creating UI questions (default: false).",
    },
    {
      name: "limit",
      description: "Maximum number of gaps to consider (default: 50).",
    },
  ],
  tasks: [
    {
      id: "invoke_docs_decision_solicit",
      description:
        "Invoke the docs_decision_solicit resolver which scans for documentation " +
        "alignment issues that need human decisions. The resolver will emit " +
        "uiQuestion_write impulses for any gaps requiring review.",
      resolver: "docs_decision_solicit",
      config: {
        type: "docs_decision_solicit",
        dry_run: false,
        limit: 50,
      },
      outputShapes: ["docsDecisionSolicitReport"],
    },
  ],
};
