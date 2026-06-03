import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * mitosis-tick — autonomous evaluate+cutover for the most recent mitosis pair.
 *
 * The substrate must prove its own verdict. scaffold-mitosis-track spawns
 * parallel-track copies (e.g. goal-host-vessel-mitosis-<TS>) but nothing
 * dispatches the evaluate/cutover chain — vessel_mitosis_evaluate and
 * vessel_mitosis_cutover sit idle until something composes them.
 *
 * This template closes the loop. It reads /workspace/mitosis-pending.json
 * (a single-file convention written by scaffold-mitosis-track on success;
 * also writable by the operator for bootstrap), extracts the mitosis
 * version_id, dispatches vessel_mitosis_evaluate against the live traces
 * stream, and unconditionally dispatches vessel_mitosis_cutover — the
 * cutover resolver self-refuses unless the evaluation verdict is FAVORABLE
 * (it requires evaluation_evidence.verdict === "FAVORABLE"), so a refuse
 * trace IS the substrate's audited NO. An accept trace is the audited YES.
 *
 * pending.json contract (minimal):
 *   {
 *     "vessel_name": "goal-host-vessel",
 *     "base_version_id": "v1",
 *     "mitosis_version_id": "2026-06-03T07-12-14-972Z",
 *     "mitosis_root": "/vessels/goal-host-vessel-mitosis-2026-06-03T07-12-14-972Z"
 *   }
 *
 * Wiring: boredom-vessel goal[15] dispatches this template on cadence.
 * Refuses with structured reason are normal: INSUFFICIENT_DATA early in
 * the mitosis's life, UNFAVORABLE / NEUTRAL once enough traces accrue but
 * the variant doesn't dominate. Only FAVORABLE flips to cutover.
 *
 * Immunity-pattern compliant — fs_read + json_path_extract + two server-side
 * resolvers. No LLM.
 */

export const MITOSIS_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:mitosis-tick",
  name: "mitosis-tick",
  description:
    "Autonomous evaluate+cutover tick for the most recent mitosis pair. Reads " +
    "/workspace/mitosis-pending.json, dispatches vessel_mitosis_evaluate, then " +
    "unconditionally dispatches vessel_mitosis_cutover which self-refuses unless " +
    "the verdict is FAVORABLE. Refuse traces ARE the substrate's audited NO; " +
    "accept traces are the audited YES. Closes the lift loop: detect → modify → " +
    "evaluate → cutover, no operator hand in the modify path.",
  inputShapes: [],
  outputShapes: ["vesselMitosisEvaluation", "vesselMitosisCutoverResult", "structuredError"],
  tags: [
    "intent:self_evaluation",
    "phase:judge",
    "lift.autonomous.loop",
    "boredom_target_template",
  ],
  variables: [],
  tasks: [
    {
      id: "read_pending",
      description:
        "Read /workspace/mitosis-pending.json which carries the (base, mitosis) version pair " +
        "for the most recent scaffold-mitosis-track invocation. If the file is absent, the " +
        "chain fails fast — a normal trace, not an error.",
      resolver: "fs_read",
      config: {
        type: "fs_read",
        path: "/workspace/mitosis-pending.json",
      },
      outputShapes: ["fileContent"],
    },
    {
      id: "extract_vessel_name",
      description: "Extract pending.vessel_name (e.g. goal-host-vessel).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "vessel_name",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_base_version",
      description: "Extract pending.base_version_id (anchor; typically 'v1').",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "base_version_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_mitosis_version",
      description: "Extract pending.mitosis_version_id (timestamp suffix of the mitosis track).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "mitosis_version_id",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_mitosis_root",
      description: "Extract pending.mitosis_root (absolute fs path of the mitosis vessel tree).",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "mitosis_root",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "evaluate_pair",
      description:
        "Dispatch vessel_mitosis_evaluate against the live traces stream. Returns " +
        "vesselMitosisEvaluation with verdict ∈ {FAVORABLE,NEUTRAL,UNFAVORABLE,INSUFFICIENT_DATA}. " +
        "Threshold defaults to 0.1; min_traces_per_version set to 1 to allow early evaluation " +
        "on freshly-spawned mitoses (will return INSUFFICIENT_DATA on either side with 0 traces, " +
        "FAVORABLE on memory-axis improvements once even one mitosis trace is recorded).",
      resolver: "vessel_mitosis_evaluate",
      config: {
        type: "vessel_mitosis_evaluate",
        base_version_id: "{{extract_base_version_text}}",
        mitosis_version_id: "{{extract_mitosis_version_text}}",
        min_traces_per_version: 1,
      },
      outputShapes: ["vesselMitosisEvaluation"],
    },
    {
      id: "conditional_cutover",
      description:
        "Unconditionally dispatch vessel_mitosis_cutover. The resolver self-refuses unless " +
        "evaluation_evidence.verdict === 'FAVORABLE' (returns structuredError with " +
        "verdict-acknowledgment in body), so we can safely chain without an explicit conditional. " +
        "A refuse is the substrate's audited NO; an accept is the audited YES. dry_run=false " +
        "because the operator wants a real cutover on memory-axis wins.",
      resolver: "vessel_mitosis_cutover",
      config: {
        type: "vessel_mitosis_cutover",
        vessel_name: "{{extract_vessel_name_text}}",
        base_version_id: "{{extract_base_version_text}}",
        mitosis_version_id: "{{extract_mitosis_version_text}}",
        mitosis_root: "{{extract_mitosis_root_text}}",
        evaluation_evidence: "{{evaluate_pair_content}}",
        dry_run: false,
      },
      outputShapes: ["vesselMitosisCutoverResult", "structuredError"],
    },
  ],
};
