import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * check-landing-restart — whether development-vessel's self-cutover restarts the vessel for a check-only landing (every
 * staged file an out-of-suite test/checks/<name>.check.ts), decided in process at the cutover's restart step
 * (src/resolvers/vessel-mitosis-cutover.ts checkLandingRestartDecision), never dispatched. It produces one
 * checkLandingRestart per decision (variant, reason, landed and runtime sha, the stale-runtime and owed-restart
 * readings). Its grade is decided by its CONSUMER, the check-landing-restart-credit trace: reached = the first compose
 * request on this node within 17 min of the decision was admitted, never by its exit. Variant-1 (`<id>-v1`, a child
 * template) skips the restart when the runtime is current and no restart is owed; which variant runs is the
 * activityVariantMask pool impulse. Operator-seeded; seed_version, so a populated catalogue upserts it (seed/deliver.ts).
 */
export const CHECK_LANDING_RESTART_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:check-landing-restart",
  name: "check-landing-restart",
  description:
    "Decides, at a self-cutover whose staging is check files only, that development-vessel restarts as before, and " +
    "records a checkLandingRestart. Graded by its consumer (the next compose request on this node was admitted), never " +
    "at exit.",
  inputShapes: ["cutoverApplied"],
  outputShapes: ["checkLandingRestart"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "decide-restart",
      description: "Restart the vessel as before and record the decision (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["checkLandingRestart"],
    },
  ],
};

export const CHECK_LANDING_RESTART_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:check-landing-restart-v1",
  name: "check-landing-restart-v1",
  description:
    "Variant of check-landing-restart. A self-cutover whose staging is check files only skips the vessel restart, and " +
    "so its drain, unless a runtime file under src/ (or package.json, bun.lock) is newer than the process or a restart " +
    "is already owed. Records a checkLandingRestart. Graded by its consumer, never at exit.",
  inputShapes: ["cutoverApplied"],
  outputShapes: ["checkLandingRestart"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:check-landing-restart",
  tasks: [
    {
      id: "decide-restart",
      description: "Skip the restart when the runtime is current and none is owed; record the decision.",
      resolver: "deterministic",
      outputShapes: ["checkLandingRestart"],
    },
  ],
};
