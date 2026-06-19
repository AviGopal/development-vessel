import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detector-yield-registry-tick — the substrate's detector-fleet self-inventory.
 * Runs detector_yield_registry: joins gap provenance
 * (classification_metadata.detector) × gap outcomes (landed/churned/open) ×
 * scheduling (boredom selector snapshot picks/novel_fraction) into a per-detector
 * yield row, deriving PRODUCTIVE / LOW_YIELD / DORMANT / UNKNOWN. This is the
 * CURATIVE half of fleet management: detector-meta-scan names dormant detectors
 * and gap_lifecycle_scan tracks gap outcomes, but nothing joined "which detector
 * emitted which gap" to "did that gap land" — so the fleet was never curated.
 *
 * Descriptive by default: emit_retirement_gaps is false, so this turn it only
 * INVENTORIES the fleet (emits no gaps). When enabled, it routes a
 * detector_retirement_candidate substrateGap per DORMANT/LOW_YIELD detector
 * through the normal gap→bridge→deprecate path. Low cadence — yield changes
 * slowly. Deterministic; no LLM.
 */
export const DETECTOR_YIELD_REGISTRY_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detector-yield-registry-tick",
  name: "detector-yield-registry-tick",
  description:
    "Runs detector_yield_registry: a per-detector health inventory joining gap " +
    "provenance (classification_metadata.detector), gap outcomes (landed/churned/" +
    "open from the gap store), and scheduling (boredom selector snapshot picks) " +
    "into PRODUCTIVE/LOW_YIELD/DORMANT/UNKNOWN status rows. The curative half of " +
    "detector-fleet management — names retirement candidates so the substrate can " +
    "retire dormant/zero-yield detectors. Descriptive by default (emit_retirement_" +
    "gaps=false); deterministic, no LLM.",
  inputShapes: [],
  outputShapes: ["detectorYieldReport"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "detector.fleet.management", "boredom_target_template"],
  variables: [],
  cited_concept_ids: ["concept_9ldsmRgqSTd5"],
  tasks: [
    {
      id: "inventory_detector_yield",
      description:
        "Run detector_yield_registry over the gap store + selector snapshot for the " +
        "window and emit a detectorYieldReport with one yield row per detector. " +
        "Does NOT emit retirement gaps this turn (descriptive inventory).",
      resolver: "detector_yield_registry",
      config: {
        type: "detector_yield_registry",
        window_hours: 168,
        dormant_picks_threshold: 1,
        emit_retirement_gaps: false,
      },
      outputShapes: ["detectorYieldReport"],
    },
  ],
};
