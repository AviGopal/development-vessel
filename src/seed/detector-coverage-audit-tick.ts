import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detector-coverage-audit-tick — the meta-detector that detects MISSING
 * detectors. Runs detector_coverage_scan: clusters recurring failures, checks
 * which clusters are already cited by an existing substrateGap (i.e. already
 * watched by a detector), and emits a detector_coverage_gap for any recurring
 * cluster no detector covers.
 *
 * This closes SUBSTRATE_AS_MDP §9.3 limit-8: the substrate could detect template
 * gaps and capability gaps, but not "we have no detector for this bug class."
 * Now it can — and draft-detector-activity authors the detector. Same
 * constitutional principle (concept_9ldsmRgqSTd5) generalized one level up:
 * every uncovered bug class is an opportunity to author a DETECTOR, not just a
 * detection of one instance.
 */

export const DETECTOR_COVERAGE_AUDIT_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detector-coverage-audit-tick",
  name: "detector-coverage-audit-tick",
  description:
    "Scans recent failure traces, clusters them by (failure_type, activity_prefix), " +
    "and compares against the trace ids already cited by existing substrateGaps. " +
    "A recurring cluster (>= min_recurrence) whose traces are essentially un-cited " +
    "has no detector watching it; this tick emits a detector_coverage_gap carrying " +
    "the target_signature an authored detector binds signature_cluster_scan to. " +
    "Deterministic (no LLM). Makes 'missing detector' a first-class substrate gap.",
  inputShapes: [],
  outputShapes: ["detectorCoverageReport", "substrateGap"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "meta.detection", "boredom_target_template"],
  variables: [],
  cited_concept_ids: ["concept_9ldsmRgqSTd5"],
  tasks: [
    {
      id: "scan_detector_coverage",
      description:
        "Run detector_coverage_scan over recent failures, diff covered-vs-uncovered " +
        "clusters against existing substrateGap citations, and emit a detector_coverage_gap " +
        "per uncovered recurring cluster.",
      resolver: "detector_coverage_scan",
      config: {
        type: "detector_coverage_scan",
        window_hours: 48,
        trace_limit: 300,
        min_recurrence: 3,
        coverage_threshold: 0.2,
        emit_gap: true,
      },
      outputShapes: ["detectorCoverageReport"],
    },
  ],
};
