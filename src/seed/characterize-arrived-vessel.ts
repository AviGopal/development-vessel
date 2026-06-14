import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * characterize-arrived-vessel (2026-06-13) — the vessel-arrival horizon
 * classifier as a boredom-dispatchable activity. SUBSTRATE_AS_MDP §8.6 names
 * this as the missing "arrival trigger": the substrate already routes detected
 * gaps to the drafter (template gap) or scaffold-and-publish-vessel (resolver
 * gap), and already observes registry staleness — but nothing watched a NEW
 * vessel joining discovery to characterize the shapes it brought. Without it an
 * arbitrary vessel can connect and its shapes stay observable-but-unmanipulable.
 *
 * Single-resolver wrapper around vessel_arrival_scan (the observer-tick idiom):
 * the resolver diffs the live registry against a persisted snapshot, classifies
 * each new vessel's shape coverage via discover-by-shapes, writes deterministic
 * gap scenarios for uncovered shapes into the dir drafter-trigger-tick polls,
 * and invokes the reward edge (credit_vessel_shapes) so the new vessel's shapes
 * leave zero relevance. First run is a no-arrival baseline (anti-flood).
 *
 * Empty inputShapes + variables = precondition always satisfied (immunity
 * pattern), so it is light-dispatch eligible and runs unconditionally — a
 * no-op report when no vessel has arrived since the last run.
 */
export const CHARACTERIZE_ARRIVED_VESSEL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:characterize-arrived-vessel",
  name: "characterize-arrived-vessel",
  description:
    "Detects vessels that joined discovery since the last run, classifies each " +
    "advertised shape's coverage (covered / producer_only / consumer_only / " +
    "orphaned) via discover-by-shapes, writes a gap scenario for shapes no " +
    "activity consumes so the drafter authors an integrating template, and " +
    "credits the new vessel's shapes (reward edge) so their cold-start relevance " +
    "leaves zero. Baseline on first run; no-op when nothing arrived.",
  inputShapes: [],
  outputShapes: ["vesselArrivalReport"],
  tags: [
    "intent:shadow_state_observation",
    "horizon:meta",
    "phase:detect",
    "boredom_target_template",
    "lift.autonomous.loop",
    "light_dispatch_eligible",
    "impulse_complete_base",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_vessel_arrivals",
      description:
        "Diff the live discovery registry against the persisted snapshot, " +
        "classify each new vessel's shape coverage, emit gap scenarios for " +
        "uncovered shapes, and credit characterized shapes via the reward edge.",
      resolver: "vessel_arrival_scan",
      config: { type: "vessel_arrival_scan" },
      outputShapes: ["vesselArrivalReport"],
    },
  ],
};
