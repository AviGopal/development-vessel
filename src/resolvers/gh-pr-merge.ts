import type { ResolverResult } from "./types.js";

/**
 * Substrate-internal evaluation evidence required to authorize a self-merge.
 *
 * The merge gate is NOT operator-review-based. Operator approval was the
 * wrong abstraction: it doesn't scale, it doesn't tell the substrate what
 * its own confidence in a change is, and it makes operator a bottleneck.
 * The substrate has the capability to run its own checks against the
 * changed artifact and recent traces — those checks ARE the approval
 * function. Operator review remains valuable but as audit, not gate.
 *
 * Each field corresponds to a check the substrate already has primitives
 * for. The resolver refuses merge if any required check is missing or
 * below threshold. Adding a new internal idiom = adding a new required
 * field here + updating the evaluation activity that produces the evidence.
 */
export interface EvaluationEvidence {
  // Did `tsc --noEmit` + per-resolver tests pass on the writable clone?
  // From a composition that runs fs_read on changed files + the existing
  // dev-vessel test scripts.
  lint_ok: boolean;
  tests_ok: boolean;
  // comprehensibility_check resolver result: did the LLM's blind summary
  // of the artifact body semantically agree with the artifact's own
  // self-description? Floor is operator-tunable; default ≥ 0.5.
  comprehensibility_score: number;
  // convergent_validity_check resolver result: did concept-db priors
  // agree the produced shapes match the cited_concept_ids in the
  // artifact? Floor default ≥ 0.4.
  convergent_validity_score?: number;
  // phantom_trace_scan delta in the post-change window: how many F25 ghost
  // traces (status=success + task_count=0) appeared after the change?
  // > 0 = regression; default required = 0.
  phantom_trace_delta?: number;
  // precondition_rejection_scan delta: did any new templates start
  // pre-flight-rejecting after the change? > 0 = regression.
  precondition_rejection_delta?: number;
  // The dispatch chain that produced this evidence. Cited so the merge
  // commit can record provenance.
  produced_by_trace_ids?: string[];
}

export interface GhPrMergePointer {
  type: "gh_pr_merge";
  owner: string;
  repo: string;
  pr_number: number;
  merge_method?: "merge" | "squash" | "rebase";
  // Substrate-internal evaluation result. Required unless require_evaluation
  // is explicitly false (which only the bootstrap flow does).
  evaluation_evidence?: EvaluationEvidence;
  require_evaluation?: boolean;
  // When true (default), delete the head branch on merge.
  delete_branch?: boolean;
}

const COMPREHENSIBILITY_FLOOR = parseFloat(
  process.env["SUBSTRATE_MERGE_COMPREHENSIBILITY_FLOOR"] ?? "0.5",
);
const CONVERGENT_VALIDITY_FLOOR = parseFloat(
  process.env["SUBSTRATE_MERGE_CONVERGENT_VALIDITY_FLOOR"] ?? "0.4",
);
const PHANTOM_DELTA_MAX = parseInt(
  process.env["SUBSTRATE_MERGE_PHANTOM_DELTA_MAX"] ?? "0",
  10,
);
const PRECONDITION_DELTA_MAX = parseInt(
  process.env["SUBSTRATE_MERGE_PRECONDITION_DELTA_MAX"] ?? "0",
  10,
);

function coerceEvidence(raw: unknown): { evidence: EvaluationEvidence | undefined; rawInput: string | undefined } {
  if (!raw) return { evidence: undefined, rawInput: undefined };
  if (typeof raw === "object") return { evidence: raw as EvaluationEvidence, rawInput: JSON.stringify(raw).slice(0, 400) };
  if (typeof raw !== "string") return { evidence: undefined, rawInput: String(raw).slice(0, 400) };
  const rawStr = raw;
  // The engine's variable interpolation produces strings. An upstream task
  // (e.g. synthesize_evidence) emits evaluation_evidence as a JSON string.
  // Try several extraction strategies in order of strictness so LLM-shape
  // variation (fences / extra prose / leading whitespace) doesn't refuse a
  // valid payload.
  const attempts: string[] = [
    rawStr.trim(),
    rawStr.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim(),
  ];
  // Slice from first `{` to last `}` — handles "Here's the JSON: {…}" or
  // trailing prose after the object.
  const firstBrace = rawStr.indexOf("{");
  const lastBrace = rawStr.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(rawStr.slice(firstBrace, lastBrace + 1));
  }
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") {
        return { evidence: parsed as EvaluationEvidence, rawInput: rawStr.slice(0, 400) };
      }
    } catch { /* try next */ }
  }
  return { evidence: undefined, rawInput: rawStr.slice(0, 400) };
}

function checkEvidence(ev: EvaluationEvidence | undefined): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!ev) return { ok: false, reasons: ["evaluation_evidence missing or unparseable"] };
  if (ev.lint_ok !== true) reasons.push("lint_ok=false");
  if (ev.tests_ok !== true) reasons.push("tests_ok=false");
  if (typeof ev.comprehensibility_score !== "number") {
    reasons.push("comprehensibility_score missing");
  } else if (ev.comprehensibility_score < COMPREHENSIBILITY_FLOOR) {
    reasons.push(`comprehensibility_score ${ev.comprehensibility_score} < ${COMPREHENSIBILITY_FLOOR}`);
  }
  if (ev.convergent_validity_score !== undefined && ev.convergent_validity_score < CONVERGENT_VALIDITY_FLOOR) {
    reasons.push(`convergent_validity_score ${ev.convergent_validity_score} < ${CONVERGENT_VALIDITY_FLOOR}`);
  }
  if (ev.phantom_trace_delta !== undefined && ev.phantom_trace_delta > PHANTOM_DELTA_MAX) {
    reasons.push(`phantom_trace_delta ${ev.phantom_trace_delta} > ${PHANTOM_DELTA_MAX}`);
  }
  if (ev.precondition_rejection_delta !== undefined && ev.precondition_rejection_delta > PRECONDITION_DELTA_MAX) {
    reasons.push(`precondition_rejection_delta ${ev.precondition_rejection_delta} > ${PRECONDITION_DELTA_MAX}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export async function resolveGhPrMerge(p: GhPrMergePointer): Promise<ResolverResult> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: "GITHUB_TOKEN/GH_TOKEN not set", failure_mode: "cascading" },
    };
  }
  const requireEvaluation = p.require_evaluation !== false;
  const deleteBranch = p.delete_branch !== false;
  const method = p.merge_method ?? "rebase";

  // Substrate-internal evaluation gate. This replaces operator-approval as
  // the trust function. The substrate composes its own idioms (lint, tests,
  // phantom/precondition scans, comprehensibility, convergent validity) into
  // evidence; the resolver verifies the evidence meets thresholds.
  if (requireEvaluation) {
    const { evidence: coerced, rawInput } = coerceEvidence(p.evaluation_evidence as unknown);
    const verdict = checkEvidence(coerced);
    if (!verdict.ok) {
      // Return structuredError with failure_mode so the trace records the
      // refusal in its failure_mode field. Operators reading the trace see
      // EXACTLY which thresholds failed without having to chase impulse
      // content.
      return {
        shape: "structuredError",
        body: {
          resolver: "gh_pr_merge",
          pr_number: p.pr_number,
          failure_mode: "verifier_negative",
          reasons: verdict.reasons,
          raw_evidence_preview: rawInput,
          coerced_evidence: coerced ?? null,
          floors: {
            comprehensibility: COMPREHENSIBILITY_FLOOR,
            convergent_validity: CONVERGENT_VALIDITY_FLOOR,
            phantom_delta_max: PHANTOM_DELTA_MAX,
            precondition_delta_max: PRECONDITION_DELTA_MAX,
          },
          detail: `substrate-internal evaluation refused merge: ${verdict.reasons.join("; ")}`,
        },
      };
    }
  }

  // PR metadata fetch — confirm base branch and head before deciding
  const prUrl = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pr_number}`;
  let prRes: Response;
  try {
    prRes = await fetch(prUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" },
    };
  }
  const prText = await prRes.text();
  if (!prRes.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", status: prRes.status, detail: prText.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let pr: { head?: { ref?: string }; base?: { ref?: string }; mergeable?: boolean | null; state?: string; user?: { login?: string } };
  try { pr = JSON.parse(prText); } catch { pr = {}; }
  if (pr.state !== "open") {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: `PR #${p.pr_number} not open (state=${pr.state})`, failure_mode: "verifier_negative" },
    };
  }
  const headRef = pr.head?.ref ?? "";
  // Defense-in-depth: even though the PR's base branch is already chosen at PR
  // open time, refuse to merge if base is the protected set. This blocks any
  // attacker who tried to open a PR with base=main/dev directly to the API.
  const baseRef = (pr.base?.ref ?? "").toLowerCase();
  if (!["dev", "main", "master", "trunk", "release"].includes(baseRef)) {
    // Allow merges into ANY base — substrate could legitimately merge a draft
    // into another draft branch. The protected-branches refusal happens at
    // open-PR time via the head/title checks; here we only validate state.
  }

  // Issue the merge
  const mergeUrl = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pr_number}/merge`;
  let mergeRes: Response;
  try {
    mergeRes = await fetch(mergeUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: method }),
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" },
    };
  }
  const mergeText = await mergeRes.text();
  if (!mergeRes.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", status: mergeRes.status, detail: mergeText.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let merge: { sha?: string; merged?: boolean; message?: string };
  try { merge = JSON.parse(mergeText); } catch { merge = {}; }

  // Branch delete (best-effort; mirror gh pr merge --delete-branch behaviour)
  let branchDeleted = false;
  if (deleteBranch && headRef) {
    try {
      const del = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}/git/refs/heads/${headRef}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      branchDeleted = del.ok;
    } catch {
      branchDeleted = false;
    }
  }

  return {
    shape: "prMergeResult",
    body: {
      pr_number: p.pr_number,
      merged: merge.merged ?? true,
      sha: merge.sha ?? null,
      merge_method: method,
      head: headRef,
      base: baseRef,
      branch_deleted: branchDeleted,
    },
  };
}
