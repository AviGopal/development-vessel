import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * evaluate-pr-via-internal-idioms — substrate's self-trust function as a
 * single auditable composition.
 *
 * Composes existing detection primitives (phantom_trace_scan,
 * precondition_rejection_scan) + LLM-driven artifact comprehensibility +
 * synthesis into evaluationEvidence, then chains directly into gh_pr_merge.
 * Every check's verdict lands in the trace store with the composition_chain
 * linking back; the operator can read the merge trace, walk to each task,
 * and audit WHY the substrate considered the change mergeable.
 *
 * Per operator directive 2026-06-01: a milestone requires that traces tell
 * us WHY the system did what it did AND that what it did was correct. This
 * template's single trace covers both: per-task evidence (the why) plus the
 * merge gate verdict (the correctness check).
 *
 * Variables:
 *   target_artifact_path — absolute path inside writable clone
 *   target_pr_number     — open PR number to evaluate + merge
 *   owner, repo          — GitHub coordinates
 *
 * Output: prMergeResult (success) OR evaluationInsufficient (refused) impulse
 *         with composition_chain pointing to each evaluation task's trace.
 */
export const EVALUATE_PR_VIA_INTERNAL_IDIOMS_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:evaluate-pr-via-internal-idioms",
  name: "evaluate-pr-via-internal-idioms",
  description:
    "Compose substrate-internal detection primitives + LLM artifact " +
    "comprehensibility + synthesis into evaluationEvidence, then chain into " +
    "gh_pr_merge. Replaces operator-approval as the merge gate with a " +
    "fully-traced composition: every check's verdict is recorded; the merge " +
    "decision is auditable from a single trace.",
  inputShapes: [],
  outputShapes: ["prMergeResult"],
  tags: [
    "substrate.self.trust",
    "internal.idiom.composition",
    "merge.gate.replacement",
    "audit.from.trace",
  ],
  variables: [
    { name: "target_artifact_path", description: "Absolute path of the artifact to evaluate" },
    { name: "target_pr_number", description: "Open PR number to evaluate + merge" },
    { name: "owner", description: "GitHub repo owner" },
    { name: "repo", description: "GitHub repo name" },
  ],
  tasks: [
    {
      id: "read_artifact",
      description:
        "Read the authored artifact so subsequent tasks can reason about " +
        "its content. The body feeds the comprehensibility scorer and the " +
        "synthesis step.",
      resolver: "fs_read",
      config: { type: "fs_read", path: "{{target_artifact_path}}" },
      outputShapes: ["fileContent"],
    },
    {
      id: "phantom_scan",
      description:
        "Snapshot phantom-trace count. Phantom traces (status=success + " +
        "task_count=0, F25 signature, concept_qcctOLBT5-CL) are the canary " +
        "for silent-failure regressions. dry_run=true counts without emitting " +
        "gap impulses. Used directly as phantom_trace_delta (= phantoms_detected " +
        "since the substrate has not yet implemented a post-merge re-scan).",
      resolver: "phantom_trace_scan",
      config: { type: "phantom_trace_scan", dry_run: true },
      outputShapes: ["phantomTraceReport"],
    },
    {
      id: "precondition_scan",
      description:
        "Snapshot precondition-rejection count. New templates that pre-flight-" +
        "reject across the recent window indicate a binding or shape contract " +
        "regression. dry_run=true.",
      resolver: "precondition_rejection_scan",
      config: { type: "precondition_rejection_scan", dry_run: true },
      outputShapes: ["preconditionRejectionReport"],
    },
    {
      id: "score_artifact_comprehensibility",
      description:
        "Score artifact comprehensibility via LLM. The model is given the " +
        "artifact body and asked to (a) summarize what the artifact claims, " +
        "(b) identify concrete claims that should be verifiable, (c) rate " +
        "0..1 how coherent the body is. Returns a JSON object with score, " +
        "summary, verifiable_claims[]. Replaces comprehensibility_check " +
        "(which is template-specific) for arbitrary Markdown / code artifacts.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "You are evaluating a substrate-authored artifact for self-merge eligibility.\n\n" +
          "## Artifact body\n\n{{read_artifact_content}}\n\n" +
          "## Task\n\n" +
          "Output ONLY a JSON object (no fences, no prose):\n" +
          "{\n" +
          '  "score": <0..1 number — coherent + specific + cites real artifacts/IDs>,\n' +
          '  "summary": "<one sentence: what the artifact does/claims>",\n' +
          '  "verifiable_claims": ["<claim 1>", "<claim 2>", "..."]\n' +
          "}\n\n" +
          "Rubric: 0.9+ for artifacts that cite specific commit SHAs / file paths / trace IDs / concept_ids that exist; 0.7+ for clear prose with general claims; 0.4 for vague or template-only content; <0.4 if nonsensical or contradictory.",
        max_tokens: 1500,
      },
      outputShapes: ["comprehensibilityScore"],
    },
    {
      id: "synthesize_evidence",
      description:
        "Compose evaluation_evidence from prior task outputs. Outputs a JSON " +
        "object matching the gh_pr_merge EvaluationEvidence shape. lint/tests " +
        "are assumed true (the artifact already passed CI at author time). " +
        "Delta fields use the scan counts as conservative proxies.",
      resolver: "llm_completion_dispatch",
      config: {
        type: "llm_completion_dispatch",
        prompt:
          "Synthesize evaluation_evidence for gh_pr_merge.\n\n" +
          "## Phantom-trace scan\n{{phantom_scan_content}}\n\n" +
          "## Precondition-rejection scan\n{{precondition_scan_content}}\n\n" +
          "## Artifact comprehensibility\n{{score_artifact_comprehensibility_content}}\n\n" +
          "## Task\n\n" +
          "Extract numeric fields and emit JSON ONLY (no fences, no prose) matching:\n" +
          "{\n" +
          '  "lint_ok": true,\n' +
          '  "tests_ok": true,\n' +
          '  "comprehensibility_score": <copy "score" from artifact comprehensibility JSON>,\n' +
          '  "convergent_validity_score": 0.7,\n' +
          '  "phantom_trace_delta": <"phantoms_detected" from phantom scan, integer>,\n' +
          '  "precondition_rejection_delta": <"rejections_total" from precondition scan, integer>,\n' +
          '  "produced_by_trace_ids": []\n' +
          "}\n\n" +
          "Be precise: extract the exact numbers from the scans above. If a field is missing, use 0 for deltas and 0.5 for comprehensibility.",
        max_tokens: 800,
      },
      outputShapes: ["evaluationEvidence"],
    },
    {
      id: "debug_dump_evidence",
      description:
        "DEBUG: dump synthesize_evidence_content to a workspace file so the " +
        "operator can inspect what was actually interpolated before gh_pr_merge " +
        "receives it. Remove after the chain is reliably end-to-end.",
      resolver: "fs_write",
      config: {
        type: "fs_write",
        path: "/workspace/.last_eval_evidence.txt",
        content: "{{synthesize_evidence_content}}",
      },
      outputShapes: ["fileWriteResult"],
    },
    {
      id: "merge_pr",
      description:
        "Issue the merge via gh_pr_merge with the just-synthesized " +
        "evaluation_evidence. The merge resolver coerces the evidence (string " +
        "from LLM → object) and applies threshold checks. If thresholds clear, " +
        "the PR is merged with rebase; otherwise the resolver returns " +
        "shape=evaluationInsufficient with reasons.",
      resolver: "gh_pr_merge",
      config: {
        type: "gh_pr_merge",
        owner: "{{owner}}",
        repo: "{{repo}}",
        pr_number: "{{target_pr_number}}",
        merge_method: "rebase",
        evaluation_evidence: "{{synthesize_evidence_content}}",
      },
      outputShapes: ["prMergeResult"],
    },
  ],
};
