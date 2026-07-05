import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * self-interference-scan-tick — stuck-state and interference detector. Runs
 * self_interference_scan: scans durable evidence (compose reports under
 * /workspace/proposals, the gaps store, goal-host dispatch records, busy
 * refusals) for the ways the self-development loop silently blocks itself —
 * same-error rollback streaks per vessel, repeated re-landing of one gap,
 * approach decisions never joined to an outcome, interrupted dispatches, and
 * compose BUSY refusals — and files one substrateGap per distinct incident
 * kind so the drain loop can act. Deterministic; no LLM.
 */

export const SELF_INTERFERENCE_SCAN_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:self-interference-scan-tick",
  name: "self-interference-scan-tick",
  description:
    "Scan durable evidence (compose reports, gaps store, dispatch records) for self-interference stuck states — same-error rollback streaks per vessel, repeated re-landing of one gap, abandoned approach decisions, interrupted dispatches, busy refusals — and file one substrateGap per distinct incident kind.",
  inputShapes: [],
  outputShapes: ["selfInterferenceReport", "substrateGap"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "stability.measurement",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_self_interference",
      description: "Run the self-interference scan over the last window and emit incident gaps.",
      resolver: "self_interference_scan",
      config: { type: "self_interference_scan", max_incidents: 10, window_hours: 24, emit_gap: true },
      outputShapes: ["selfInterferenceReport"],
    },
  ],
};
