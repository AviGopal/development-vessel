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
 *     "mitosis_root": "/vessels/goal-host-vessel-mitosis-2026-06-03T07-12-14-972Z",
 *     "base_sha": "<12-hex SHA-256 of base src/index.ts at staging time>"
 *   }
 *
 * The base_sha field (Stage B.2 2026-06-03) enables the cutover resolver's
 * freshness gate: if absent OR doesn't match the current live source's hash,
 * cutover refuses and emits a substrateGap citing
 * `resilient_against_unintended_changes`. vessel_mitosis_start v0.3+ now
 * captures this automatically; pre-v0.3 pending entries lack it and are
 * (correctly) refused as stale.
 *
 * Wiring: boredom-vessel goal[15] dispatches this template on cadence.
 * Refuses with structured reason are normal: INSUFFICIENT_DATA early in
 * the mitosis's life, UNFAVORABLE / NEUTRAL once enough traces accrue but
 * the variant doesn't dominate. Only FAVORABLE flips to cutover.
 *
 * Immunity-pattern compliant — fs_read + json_path_extract + two server-side
 * resolvers. No LLM.
 *
 * Dispatcher-portable interpolation (2026-06-04 follow-up to 74542cc):
 * All cross-task references use the `{{<taskId>_content}}` form. Both
 * dispatchers honour this:
 *   - goal-host (ias-executor-ts engine.ts ~line 421): populates
 *     `accumulatedVariables[\`${taskId}_content\`]` from the first output
 *     impulse's content. For json_extracted_value the goal-host proxy
 *     unwraps body.value → string before the engine sees it, so _content is
 *     the raw scalar. For vesselMitosisEvaluation the proxy passes the body
 *     object through, so _content is the full verdict structure.
 *   - light-dispatch (light-dispatch-vessel/src/index.ts resolvePath alias
 *     block): when r.body has no `content` field, falls back to body.value
 *     (preferred when present) or the whole body object — mirroring goal-
 *     host's unwrap-then-alias chain.
 * The earlier `{{<taskId>_value}}` and bare `{{evaluate_pair}}` forms worked
 * only on light-dispatch (which reads r.body.value directly and supports
 * exact-match whole-object substitution). Goal-host has no `_value` alias
 * and no bare-taskId alias, so boredom-dispatched mitosis-tick traces
 * silently failed at conditional_cutover with verdict="{{evaluate_pair}}".
 * See concept_K-NGhlSQ3grT (mitosis cutover chain post-fix state).
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
  outputShapes: [
    "vesselMitosisEvaluation",
    "vesselMitosisCutoverResult",
    "cutoverApplied",
    "structuredError",
  ],
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
      id: "extract_base_sha",
      description:
        "Extract pending.base_sha — SHA-256(12) hex of the live base source at staging time. " +
        "Threaded into vessel_mitosis_cutover's freshness gate (Stage B.2 2026-06-03). " +
        "When absent the cutover refuses with mitosis_freshness_violation, which is the safe " +
        "default — a stale draft cannot silently regress newer operator-side fixes.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "base_sha",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_staged_files",
      description:
        "Extract pending.staged_files — the allowlist of relative paths the cutover " +
        "is permitted to copy into the host repo + live vessel. Defaults to empty when " +
        "absent, which makes the cutover take the legacy directory-rename path.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "staged_files",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "extract_proposal_id",
      description: "Extract pending.proposal — the apply-proposal-as-patch source id.",
      resolver: "json_path_extract",
      config: {
        type: "json_path_extract",
        json: "{{read_pending_content}}",
        path: "proposal",
      },
      outputShapes: ["json_extracted_value"],
    },
    {
      id: "evaluate_pair",
      description:
        "Dispatch vessel_mitosis_evaluate. Static-evaluation path (2026-06-04) runs " +
        "`bun run lint` + `bun test` inside mitosis_root BEFORE consulting traces — lint+tests " +
        "pass → FAVORABLE without waiting for runtime traces; lint or tests fail → UNFAVORABLE " +
        "with cited output. min_traces_per_version=1 preserves the fallback trace path when " +
        "static eval is unavailable.",
      resolver: "vessel_mitosis_evaluate",
      config: {
        type: "vessel_mitosis_evaluate",
        base_version_id: "{{extract_base_version_content}}",
        mitosis_version_id: "{{extract_mitosis_version_content}}",
        mitosis_root: "{{extract_mitosis_root_content}}",
        // Overlay: staged file copied over canonical /vessels/<v>/ tree
        // so lint+tests run against a synthesized post-cutover vessel tree.
        // Required when the mitosis dir is sparse (only changed files).
        static_check_base_root: "/vessels/{{extract_vessel_name_content}}",
        staged_files: "{{extract_staged_files_content}}",
        // Substrate-runtime defaults: use full bun path and run typecheck-only.
        // The shape-dispatch check + tests can require fixtures or packages not
        // available in /vessels/<v>/, so we narrow the static-eval surface to
        // `tsc --noEmit` — sufficient to catch syntax/type bugs in substrate-
        // authored patches without depending on full vessel-tree fidelity.
        bun_cmd: "/root/.bun/bin/bun",
        static_check_scripts: ["typecheck"],
        skip_tests: true,
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
        vessel_name: "{{extract_vessel_name_content}}",
        base_version_id: "{{extract_base_version_content}}",
        mitosis_version_id: "{{extract_mitosis_version_content}}",
        mitosis_root: "{{extract_mitosis_root_content}}",
        staged_base_sha: "{{extract_base_sha_content}}",
        staged_files: "{{extract_staged_files_content}}",
        proposal_id: "{{extract_proposal_id_content}}",
        evaluation_evidence: "{{evaluate_pair_content}}",
        dry_run: false,
      },
      outputShapes: [
        "vesselMitosisCutoverResult",
        "cutoverApplied",
        "structuredError",
      ],
    },
  ],
};
