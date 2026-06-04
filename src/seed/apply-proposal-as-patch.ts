import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * apply-proposal-as-patch — convert the newest unstaged proposal report
 * into a staged mitosis directory the freshness-gated cutover machinery
 * (mitosis-tick + vessel_mitosis_cutover) can apply.
 *
 * Single-task wrapper around the apply_proposal_as_patch resolver. The
 * resolver does everything atomically: pick proposal, read live source,
 * LLM-patch, stage, write mitosis-pending.json with staged_base_sha.
 *
 * Boredom goal[23] dispatches this on cadence. On any cycle with no
 * unstaged proposals the resolver returns dispatched=null with reason
 * (not an error) — a normal idle trace.
 *
 * Closes the third break in the autonomous repair loop (bridge → drafter
 * → executor → apply). With this template wired, the substrate can
 * author-AND-APPLY a fix to its own source. The freshness gate in
 * vessel_mitosis_cutover refuses if base_sha drifts; that refusal is the
 * correct safety behavior, not a blocker.
 */
export const APPLY_PROPOSAL_AS_PATCH_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:apply-proposal-as-patch",
  name: "apply-proposal-as-patch",
  description:
    "Reads the newest unstaged /workspace/proposals/<id>-report.json, LLM-patches " +
    "the live target source identified by required_code_modifications[].file, " +
    "stages /vessels/<vessel>-mitosis-<TS>/<sub_path>, and writes " +
    "/workspace/mitosis-pending.json with staged_base_sha for the cutover gate.",
  inputShapes: [],
  outputShapes: ["mitosisStaged", "structuredError"],
  tags: [
    "intent:apply_proposal",
    "phase:enact",
    "lift.autonomous.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "apply",
      description:
        "Dispatch apply_proposal_as_patch. Picks newest unstaged proposal, " +
        "extracts target_file, LLM-patches, stages mitosis dir, and writes " +
        "mitosis-pending.json with staged_base_sha so the freshness gate " +
        "in vessel_mitosis_cutover can accept or refuse on next mitosis-tick.",
      resolver: "apply_proposal_as_patch",
      config: { type: "apply_proposal_as_patch" },
      outputShapes: ["mitosisStaged", "structuredError"],
    },
  ],
};
