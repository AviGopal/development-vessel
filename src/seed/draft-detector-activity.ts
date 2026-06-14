import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * draft-detector-activity — the substrate authoring a NEW detector for a problem
 * class no detector covers. Consumes a detector_coverage_gap (from
 * detector-coverage-audit-tick), binds the generic signature_cluster_scan body
 * to the gap's target_signature, and registers a real detect-<class> activity
 * through activity_create_variant (the same registration path + I1..I6 invariants
 * every authored activity passes). Closes the gap with the authored variant id.
 *
 * This is the substrate improving its ABILITY to improve, using the exact loop
 * it uses to improve every other activity: detect → draft → register → execute →
 * validate → promote → select. The "draft" is deterministic (the detector is
 * mechanically determined by the signature), so it is more semantically valid
 * than a generated draft — there is nothing to hallucinate. Downstream Thompson
 * selection still validates it: the authored detector only earns weight if the
 * gaps it emits route to fixes that move metrics.
 */

export const DRAFT_DETECTOR_ACTIVITY_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:draft-detector-activity",
  name: "draft-detector-activity",
  description:
    "Reads the highest-recurrence open detector_coverage_gap and authors a " +
    "detect-<class> detector activity that binds signature_cluster_scan to the " +
    "observed signature, registering it via activity_create_variant. The authored " +
    "detector becomes Thompson-selectable and emits substrateGaps of its class " +
    "for the fix-drafter. This is the detector-authoring recursion (SUBSTRATE_AS_MDP " +
    "§9.3 limit-8): the substrate extends its own detection surface autonomously.",
  inputShapes: [],
  outputShapes: ["activityTemplateVariant"],
  tags: ["lift.autonomous.loop", "substrate.self.detection", "meta.detection", "drafter", "boredom_target_template"],
  variables: [],
  cited_concept_ids: ["concept_9ldsmRgqSTd5"],
  tasks: [
    {
      id: "build_and_register_detector",
      description:
        "Run build_signature_detector: pick the top open detector_coverage_gap, " +
        "construct the one-task detector activity binding signature_cluster_scan to " +
        "its target_signature, register it through the standard variant path, and " +
        "close the gap with the authored variant id.",
      resolver: "build_signature_detector",
      config: { type: "build_signature_detector" },
      outputShapes: ["activityTemplateVariant"],
    },
  ],
};
