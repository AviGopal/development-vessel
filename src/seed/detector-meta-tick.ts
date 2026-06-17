import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detector-meta-tick — autonomous Nth-order detector-over-detectors. Runs
 * detector_meta_scan: audits the substrate's own detection apparatus (from the
 * boredom selector snapshot), flags DORMANT detectors (known but never exercised
 * → blind spots-in-waiting), and emits a detector-coverage meta-gap. Recursively
 * composable — its own tick appears in the snapshot a higher-order scan would read.
 * Deterministic (no LLM).
 */
export const DETECTOR_META_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detector-meta-tick",
  name: "detector-meta-tick",
  description:
    "Nth-order detector: audits the detector set itself (from the selector snapshot), " +
    "flags dormant detectors the UCB never exercises (they cover nothing), and emits a " +
    "detector-coverage meta-gap. The substrate auditing its own detection completeness. Deterministic.",
  inputShapes: [],
  outputShapes: ["detectorMetaReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "boredom_target_template"],
  variables: [],
  tasks: [
    { id: "scan_detector_set", description: "Run detector_meta_scan over the selector snapshot.",
      resolver: "detector_meta_scan", config: { type: "detector_meta_scan", minPicks: 1 }, outputShapes: ["detectorMetaReport"] },
  ],
};
