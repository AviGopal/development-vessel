import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * variant_promote — substrate-callable template-lifecycle decision.
 *
 * Issues activityTemplate_update (mark winner canonical) AND
 * activityTemplate_deprecate (retire losers) against activity-api with the
 * Thompson posteriors as evidence. activity-api's evidence gate
 * (validateEvidenceGate) admits these write-scope calls when:
 *   - loser_samples ≥ MIN_SAMPLES (default 10) AND
 *   - winner_mean - loser_mean ≥ MIN_DELTA (default 0.15).
 *
 * Architectural shape: parallel to vessel_mitosis_cutover, which already
 * uses evidence-based gating (FAVORABLE typecheck verdict). Here the gate
 * is the substrate's own Thompson posteriors over real workload — the
 * natural safety mechanism for promote/retire decisions.
 *
 * The resolver records every per-loser outcome (admitted vs rejected by
 * the gate) so the substrate accumulates a record of its own lifecycle
 * decisions, not just template state. Returns variantPromoteResult.
 */

export interface VariantPromoteEvidence {
  winner_alpha: number;
  winner_beta: number;
  winner_samples?: number;
  loser_alpha: number;
  loser_beta: number;
  loser_samples?: number;
  confidence_threshold?: number;
  reason: string;
  source_trace_ids?: string[];
}

export interface VariantPromotePointer {
  type: "variant_promote";
  family_id: string;
  winner_variant_id: string;
  loser_variant_ids: string[];
  evidence: VariantPromoteEvidence;
  /** When true, do not POST anything — just return the decisions the gate
   *  would emit. Useful for harness runs / scenario tests. */
  dry_run?: boolean;
}

type ImpulseResolveResult = {
  ok: boolean;
  status: number;
  variantId: string;
  operation: "update" | "deprecate";
  detail?: string;
};

async function postImpulse(
  type: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${METABOB_ENDPOINT}/v2/impulses/resolve`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pointer: { type, ...body } }),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

export async function resolveVariantPromote(
  pointer: VariantPromotePointer,
): Promise<ResolverResult> {
  const { family_id, winner_variant_id, loser_variant_ids, evidence, dry_run } = pointer;

  if (typeof winner_variant_id === "string" && winner_variant_id.trim() === "") {
    return {
      shape: "variantPromoteResult",
      body: {
        family_id,
        winner_variant_id: null,
        loser_variant_ids: [],
        evidence: null,
        decisions: [],
        admitted_count: 0,
        rejected_count: 0,
        skipped: true,
        skip_reason: "no_promotable_candidate",
      },
    };
  }
  if (typeof winner_variant_id !== "string" || !winner_variant_id) {
    return {
      shape: "structuredError",
      body: {
        resolver: "variant_promote",
        failure_mode: "validation_rejected",
        detail: "winner_variant_id (string) required",
      },
    };
  }
  if (!Array.isArray(loser_variant_ids) || loser_variant_ids.length === 0) {
    return {
      shape: "structuredError",
      body: {
        resolver: "variant_promote",
        failure_mode: "validation_rejected",
        detail: "loser_variant_ids (non-empty array) required",
      },
    };
  }
  if (!evidence || typeof evidence !== "object" || !evidence.reason) {
    return {
      shape: "structuredError",
      body: {
        resolver: "variant_promote",
        failure_mode: "validation_rejected",
        detail: "evidence.reason (string) required",
      },
    };
  }

  const decisions: ImpulseResolveResult[] = [];

  if (dry_run) {
    decisions.push({
      ok: true,
      status: 200,
      variantId: winner_variant_id,
      operation: "update",
      detail: "dry_run",
    });
    for (const id of loser_variant_ids) {
      decisions.push({ ok: true, status: 200, variantId: id, operation: "deprecate", detail: "dry_run" });
    }
    return {
      shape: "variantPromoteResult",
      body: {
        family_id,
        winner_variant_id,
        loser_variant_ids,
        evidence,
        dry_run: true,
        decisions,
        admitted_count: decisions.length,
        rejected_count: 0,
      },
    };
  }

  // Step 1: mark winner canonical via _update. Reason-only evidence
  // suffices for _update; the gate accepts non-Thompson reasons for
  // updates (a mutation that is auditable + reversible).
  const updateRes = await postImpulse("activityTemplate_update", {
    templateId: winner_variant_id,
    updates: { tags: [`canonical:${family_id}`, `promoted_by:variant_promote`] },
    evidence: {
      reason: `promoted as winner of family ${family_id}: ${evidence.reason}`,
      winner_alpha: evidence.winner_alpha,
      winner_beta: evidence.winner_beta,
      loser_alpha: evidence.loser_alpha,
      loser_beta: evidence.loser_beta,
      loser_samples: evidence.loser_samples,
      confidence_threshold: evidence.confidence_threshold,
      source_trace_ids: evidence.source_trace_ids,
    },
  });
  decisions.push({
    ok: updateRes.status === 200,
    status: updateRes.status,
    variantId: winner_variant_id,
    operation: "update",
    detail: updateRes.status === 200 ? "promoted" : updateRes.text.slice(0, 200),
  });

  // Step 2: deprecate each loser. Each deprecate carries the full
  // Thompson evidence so the activity-api evidence gate can admit it.
  for (const loserId of loser_variant_ids) {
    const deprecateRes = await postImpulse("activityTemplate_deprecate", {
      templateId: loserId,
      reason: `dominated by ${winner_variant_id}: ${evidence.reason}`,
      evidence: {
        reason: `dominated by ${winner_variant_id}: ${evidence.reason}`,
        winner_alpha: evidence.winner_alpha,
        winner_beta: evidence.winner_beta,
        loser_alpha: evidence.loser_alpha,
        loser_beta: evidence.loser_beta,
        loser_samples: evidence.loser_samples,
        confidence_threshold: evidence.confidence_threshold,
        source_trace_ids: evidence.source_trace_ids,
      },
    });
    decisions.push({
      ok: deprecateRes.status === 200,
      status: deprecateRes.status,
      variantId: loserId,
      operation: "deprecate",
      detail: deprecateRes.status === 200 ? "deprecated" : deprecateRes.text.slice(0, 200),
    });
  }

  const admitted = decisions.filter((d) => d.ok).length;
  const rejected = decisions.length - admitted;

  return {
    shape: "variantPromoteResult",
    body: {
      family_id,
      winner_variant_id,
      loser_variant_ids,
      evidence,
      decisions,
      admitted_count: admitted,
      rejected_count: rejected,
      // When every decision was admitted, the substrate has made a
      // complete lifecycle decision over the family.
      complete: rejected === 0,
    },
  };
}
