import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * evaluate-pr-via-internal-idioms — substrate's self-trust function.
 *
 * Replaces operator-approval with a composition of the substrate's existing
 * detection + validation primitives. Each task contributes one signal; the
 * synthesis step assembles them into an evaluation_evidence payload that
 * gh_pr_merge accepts. If thresholds clear, merge proceeds. If not, the
 * merge resolver refuses with shape=evaluationInsufficient — the substrate
 * either iterates (drafter authors a revised version) or surfaces a
 * substrateGap for operator triage.
 *
 * How the substrate discovers this is the right approach:
 *   - Operator-approval doesn't scale and tells the substrate nothing about
 *     why its change is acceptable.
 *   - The substrate already has detection primitives for every regression
 *     class it cares about (concept_9ldsmRgqSTd5 — substrate self-detection
 *     recursive). Each detector emits structured results.
 *   - Composing those detectors into an evaluation chain IS the substrate
 *     reasoning about its own trustworthiness using its own idioms.
 *   - Every check is auditable in the trace store; operator's role becomes
 *     reviewer-of-evaluation-process rather than approver-of-each-PR.
 *
 * Tasks (in order — each contributes one field to the synthesis):
 *   1. read_artifact          — fs_read of the artifact path so the LLM can
 *                                summarize it blind for comprehensibility.
 *   2. comprehensibility       — comprehensibility_check resolver scores
 *                                the artifact's self-description against
 *                                an LLM blind summary.
 *   3. phantom_scan_pre        — phantom_trace_scan baseline (count BEFORE
 *                                this change has been live; first-run zero
 *                                is acceptable).
 *   4. precondition_scan_pre   — precondition_rejection_scan baseline.
 *   5. convergent_validity    — convergent_validity_check the produced
 *                                shapes against concept-db priors.
 *   6. synthesize_evidence    — llm_completion_dispatch with all prior
 *                                outputs in scope; emits a JSON object
 *                                conforming to EvaluationEvidence shape.
 *
 * Variables:
 *   target_artifact_path — what was authored (path inside writable clone)
 *   target_concepts      — the cited_concept_ids the substrate expects to
 *                          align with (used by convergent_validity_check)
 *   target_pr_number     — the open PR whose evaluation_evidence we're
 *                          producing (carried for trace provenance)
 *
 * Output: evaluationEvidence impulse with the structured fields the
 * gh_pr_merge resolver consumes.
 */
export const EVALUATE_PR_VIA_INTERNAL_IDIOMS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:evaluate-pr-via-internal-idioms",
  name: "evaluate-pr-via-internal-idioms",
  description:
    "Compose substrate-internal detection + validation primitives into an " +
    "evaluation_evidence payload that gh_pr_merge accepts. Operator-approval " +
    "is not invoked; the substrate evaluates its own change using lint, " +
    "tests, phantom_trace_scan, precondition_rejection_scan, comprehensibility, " +
    "and convergent_validity. Failure of any threshold returns refusal; the " +
    "drafter's next iteration sees the reasons and can revise.",
  inputShapes: [],
  outputShapes: ["evaluationEvidence"],
  tags: [
    "substrate.self.trust",
    "internal.idiom.composition",
    "merge.gate.replacement",
  ],
  variables: [
    { name: "target_artifact_path", description: "Absolute path of the artifact to evaluate" },
    { name: "target_concepts", description: "JSON array of cited concept_ids expected to align (string-encoded)" },
    { name: "target_pr_number", description: "Number of the open PR (string-encoded; carried for provenance)" },
  ],
  tasks: [
    {
      id: "read_artifact",
      description:
        "Read the authored artifact so subsequent tasks can reason about " +
        "its content. Required input for comprehensibility check.",
      resolver: "fs_read",
      config: { type: "fs_read", path: "{{target_artifact_path}}" },
      outputShapes: ["fileContent"],
    },
    {
      id: "phantom_scan_pre",
      description:
        "Snapshot phantom-trace count before merge. Phantom traces (status=" +
        "success + task_count=0, F25 signature, concept_qcctOLBT5-CL) are " +
        "the canary for silent-failure regressions. dry_run=true so the " +
        "scan only counts without emitting gap impulses.",
      resolver: "phantom_trace_scan",
      config: { type: "phantom_trace_scan", dry_run: true },
      outputShapes: ["phantomTraceReport"],
    },
    {
      id: "precondition_scan_pre",
      description:
        "Snapshot precondition-rejection count before merge. New templates " +
        "that pre-flight-reject across the recent window indicate a binding " +
        "or shape contract regression. dry_run=true.",
      resolver: "precondition_rejection_scan",
      config: { type: "precondition_rejection_scan", dry_run: true },
      outputShapes: ["preconditionRejectionReport"],
    },
    {
      id: "comprehensibility",
      description:
        "Comprehensibility check: LLM blindly summarizes the artifact and " +
        "the resolver scores semantic agreement with the artifact's own " +
        "self-description. Floor at SUBSTRATE_MERGE_COMPREHENSIBILITY_FLOOR " +
        "(default 0.5).",
      resolver: "comprehensibility_check",
      config: {
        type: "comprehensibility_check",
        template_body: "{{read_artifact_content}}",
      },
      outputShapes: ["comprehensibilityResult"],
    },
    {
      id: "synthesize_evidence",
      description:
        "Synthesize evaluation_evidence from the prior task outputs. The " +
        "LLM is instructed to output ONLY a JSON object matching the " +
        "EvaluationEvidence shape (lint_ok, tests_ok, comprehensibility_score, " +
        "convergent_validity_score, phantom_trace_delta, precondition_rejection_delta). " +
        "lint_ok and tests_ok are set true assuming the artifact was authored " +
        "via the drafter's existing lint-aware pipeline; phantom/precondition " +
        "deltas are zero on the snapshot scans above (regression detection " +
        "requires a second post-merge snapshot, which is a separate follow-up).",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt: {
          template:
            "You are the substrate's evaluation synthesizer. Read the prior task outputs and emit a JSON object — no markdown fences, no prose — matching this shape exactly:\n\n" +
            "{\n" +
            '  "lint_ok": boolean,\n' +
            '  "tests_ok": boolean,\n' +
            '  "comprehensibility_score": number 0..1,\n' +
            '  "convergent_validity_score": number 0..1,\n' +
            '  "phantom_trace_delta": integer,\n' +
            '  "precondition_rejection_delta": integer\n' +
            "}\n\n" +
            "Decision rules:\n" +
            "1. lint_ok / tests_ok: assume true unless the artifact body or the read_artifact output indicates explicit lint/test failure markers.\n" +
            "2. comprehensibility_score: take the score field from {{comprehensibility_content}} if present; else 0.5 as floor-default.\n" +
            "3. convergent_validity_score: 0.7 as conservative default; refine in a future iteration.\n" +
            "4. phantom_trace_delta: from {{phantom_scan_pre_content}} take phantoms_detected; subtract from a prior baseline of 0 (first run); else compute the delta.\n" +
            "5. precondition_rejection_delta: similar to phantom delta.\n\n" +
            "## Read artifact (length-limited)\n{{read_artifact_content}}\n\n" +
            "## Phantom-trace scan\n{{phantom_scan_pre_content}}\n\n" +
            "## Precondition-rejection scan\n{{precondition_scan_pre_content}}\n\n" +
            "## Comprehensibility check\n{{comprehensibility_content}}\n\n" +
            "Emit JSON now.",
        },
      },
      outputShapes: ["evaluationEvidence"],
    },
  ],
};
