import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * dispatch-latest-auto-draft — Break 2 close (2026-06-04).
 *
 * Single-task wrapper around the dispatch_latest_auto_draft resolver. The
 * resolver lists gap-closing:auto-* templates from activity-api, computes
 * the unexecuted subset against recent traces, picks the newest, and fires
 * a light-dispatch invocation so its Thompson posterior gets seeded.
 *
 * Without this template, 6+ gap-closing:auto-* templates sit in the registry
 * with zero executions because boredom's rotation doesn't include
 * "dispatch the newest unexecuted auto-draft" and Thompson sampling skips
 * templates with no posterior.
 *
 * Immunity-pattern compliant — empty inputShapes, empty variables, single
 * deterministic server-side resolver. No LLM, no pool iteration.
 */
export const DISPATCH_LATEST_AUTO_DRAFT_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:dispatch-latest-auto-draft",
  name: "dispatch-latest-auto-draft",
  description:
    "Deterministic single-resolver wrapper around dispatch_latest_auto_draft. " +
    "Finds the newest unexecuted gap-closing:auto-* template and posts a " +
    "light-dispatch invocation to seed its Thompson posterior. Idempotent — " +
    "skips templates already exercised by recent traces.",
  inputShapes: [],
  outputShapes: ["autoDraftDispatchResult"],
  tags: [
    "intent:auto_draft_seed",
    "phase:execute",
    "topology.discovery.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "pick_and_dispatch_auto_draft",
      description:
        "Invoke dispatch_latest_auto_draft resolver. Queries activity-api for " +
        "auto-* templates + recent traces, picks the newest unexecuted, POSTs " +
        "to light-dispatch /dispatch. Returns autoDraftDispatchResult.",
      resolver: "dispatch_latest_auto_draft",
      config: {
        type: "dispatch_latest_auto_draft",
      },
      outputShapes: ["autoDraftDispatchResult"],
    },
  ],
};
