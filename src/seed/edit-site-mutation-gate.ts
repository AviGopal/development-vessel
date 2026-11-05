import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * edit-site-mutation-gate — the arm step's and the test-writing verify's judgment of whether a check's red depends on its
 * edit site (src/resolvers/check-supply-admission.ts editSiteMutationGate), run in process, never dispatched. It runs the
 * check under operator mutants of the site and produces one editSiteMutationVerdict per decided check (pass or refuse,
 * the variant, the aimed and the sampled picks). Its grade is decided by its CONSUMER, the
 * edit-site-mutation-gate-credit trace (reached = a mutant that measured the check lies in the declaration around the
 * gap's literal region: the verdict acted on was measured on the gap's code), never by its exit. Variant-1 (`<id>-v1`, a
 * child template) aims part of the k mutants at that region; which variant runs is the activityVariantMask pool impulse.
 * Operator-seeded: uploaded by the operator, not extracted from a walk. seed_version, so a populated catalogue upserts
 * it (seed/deliver.ts); raise it whenever a body below changes.
 */
export const EDIT_SITE_MUTATION_GATE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:edit-site-mutation-gate",
  name: "edit-site-mutation-gate",
  description:
    "Judges whether a check's red depends on its edit site: runs the check under k operator mutants of the site, evenly " +
    "spaced over the declarations the check reaches, and records an editSiteMutationVerdict (pass when a mutant moves " +
    "the red, refuse when none measured moves it). Graded by its consumer (the verdict was measured on the gap's code), " +
    "never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["editSiteMutationVerdict"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:control"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "control", seed_version: 1 },
  tasks: [
    {
      id: "mutant-runs",
      description: "Run the check under the k evenly spaced operator mutants of its edit site (variant-0, the control).",
      resolver: "deterministic",
      outputShapes: ["editSiteMutationVerdict"],
    },
  ],
};

export const EDIT_SITE_MUTATION_GATE_V1_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:edit-site-mutation-gate-v1",
  name: "edit-site-mutation-gate-v1",
  description:
    "Variant of edit-site-mutation-gate. When the gap's literal region occurs once in the edit site, half the k mutants " +
    "are aimed at it (its statement, then its enclosing declaration's mutants, one per line, nearest and evenly spaced " +
    "in turn) and run first; the rest are " +
    "the evenly spaced picks. A run moves the red only when a named test goes green or fails on the same assertion " +
    "with a different value; another assertion failing is the check's path, not its measurement. Records an " +
    "editSiteMutationVerdict naming the aimed and the sampled picks and each run's change kind. Graded by its " +
    "consumer, never at exit.",
  inputShapes: ["test_suite"],
  outputShapes: ["editSiteMutationVerdict"],
  tags: ["phase:learning", "reach_decided_by:consumer", "origin:operator_seeded", "variant_role:treatment"],
  metadata: { reach_decided_by: "consumer", origin: "operator_seeded", variant_role: "treatment", seed_version: 1 },
  // A variant of the family, not a new activity.
  variant_of: "development-vessel:edit-site-mutation-gate",
  tasks: [
    {
      id: "mutant-runs",
      description: "Run the check under the aimed mutants of the gap's region first, then the evenly spaced ones.",
      resolver: "deterministic",
      outputShapes: ["editSiteMutationVerdict"],
    },
  ],
};
