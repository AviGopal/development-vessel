import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * template_audit_report — minimal weak-template detector.
 *
 * Scans activity-api templates, ranks by Thompson posterior mean α/(α+β),
 * and emits a templateAuditReport listing the weakest families with enough
 * samples to be statistically meaningful. The downstream
 * template-mitosis-tick template consumes weak_templates[0].template_id as
 * the parent to author an improved variant from.
 *
 * Variant-first repair (RBAC): this resolver only READS. The downstream
 * template authors variants via activity_create_variant (write-scope) —
 * no admin-scope template mutation anywhere.
 */

export interface TemplateAuditReportPointer {
  type: "template_audit_report";
  /** Max templates to scan from activity-api. Default 500. */
  limit?: number;
  /** Posterior-mean threshold below which a family counts as "weak". Default 0.3. */
  weakThreshold?: number;
  /** Minimum executed samples (α+β-2) before a family is eligible. Default 10. */
  minSamples?: number;
  /** Cap on weak entries emitted. Default 20. */
  emitCap?: number;
  /** Minimum posterior-mean delta between winner and loser to count as dominant. Default 0.15. */
  promoteMinDelta?: number;
  /** Minimum samples on the winner to count as dominant. Default 10. */
  promoteMinSamples?: number;
}

interface TemplateRow {
  id?: unknown;
  thompson_alpha?: unknown;
  thompson_beta?: unknown;
  total_executions?: unknown;
  successful_executions?: unknown;
  failed_executions?: unknown;
  proposed?: unknown;
  deprecated?: unknown;
  metrics?: { thompson_alpha?: unknown; thompson_beta?: unknown; total_executions?: unknown };
}

function normalizeId(raw: string): string {
  return raw.replace(/^activity:⟨(.+)⟩$/, "$1");
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export async function resolveTemplateAuditReport(
  pointer: TemplateAuditReportPointer,
): Promise<ResolverResult> {
  const limit = pointer.limit ?? 500;
  const weakThreshold = pointer.weakThreshold ?? 0.3;
  const minSamples = pointer.minSamples ?? 10;
  const emitCap = pointer.emitCap ?? 20;
  const promoteMinDelta = pointer.promoteMinDelta ?? 0.15;
  const promoteMinSamples = pointer.promoteMinSamples ?? 10;

  const url = `${METABOB_ENDPOINT}/v2/activities/templates?limit=${limit}`;
  const res = await fetch(url, {
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "template_audit_report", status: res.status, detail: (await res.text()).slice(0, 200) },
    };
  }
  const json = (await res.json()) as { templates?: TemplateRow[] };
  const rows = Array.isArray(json.templates) ? json.templates : [];

  type Entry = { template_id: string; alpha: number; beta: number; samples: number; posterior_mean: number };
  const candidates: Entry[] = [];
  for (const t of rows) {
    if (t.deprecated === true) continue;
    if (t.proposed === true) continue;
    const idRaw = typeof t.id === "string" ? t.id : "";
    if (!idRaw) continue;
    const id = normalizeId(idRaw);
    const metrics = t.metrics ?? {};
    const alpha = asNum(metrics.thompson_alpha, asNum(t.thompson_alpha, 1));
    const beta = asNum(metrics.thompson_beta, asNum(t.thompson_beta, 1));
    const samples = Math.max(0, alpha + beta - 2);
    if (samples < minSamples) continue;
    const mean = alpha / (alpha + beta);
    candidates.push({ template_id: id, alpha, beta, samples, posterior_mean: Math.round(mean * 1000) / 1000 });
  }

  candidates.sort((a, b) => a.posterior_mean - b.posterior_mean);
  const weak = candidates.filter((c) => c.posterior_mean < weakThreshold).slice(0, emitCap);

  // Family grouping for strongest_families: peel off variant suffixes layered
  // by activity_create_variant + template-mitosis. Observed forms:
  //   gap-closing:auto-<ts>-<rand>-<ts2>                 (initial create_variant)
  //   gap-closing:auto-<ts>-<rand>-variant-<ts2>         (manual variant)
  //   gap-closing:auto-<ts>-<rand>-variant-mitosis-<ts2> (mitosis-tick)
  //   gap-closing:auto-<ts>-<rand>-variant-mitosis-improved-<ts2>
  // Family root is gap-closing:auto-<ts>-<rand>.
  const familyOf = (id: string): string => {
    let f = id;
    // Strip nested -variant[-<word>]*-<digits> suffix groups, then any leftover trailing -<digits>.
    f = f.replace(/(-variant(?:-[a-z]+)*-\d{8,})+$/i, "");
    f = f.replace(/-\d{10,}$/, "");
    return f;
  };
  const byFamily = new Map<string, Entry[]>();
  for (const c of candidates) {
    const fam = familyOf(c.template_id);
    const arr = byFamily.get(fam) ?? [];
    arr.push(c);
    byFamily.set(fam, arr);
  }
  const strongest_families: Array<Record<string, unknown>> = [];
  for (const [family_id, variants] of byFamily) {
    if (variants.length < 2) continue;
    const sorted = [...variants].sort((a, b) => b.posterior_mean - a.posterior_mean);
    const winner = sorted[0]!;
    const losers = sorted.slice(1);
    if (winner.samples < promoteMinSamples) continue;
    const topLoser = losers[0]!;
    const delta = winner.posterior_mean - topLoser.posterior_mean;
    if (delta < promoteMinDelta) continue;
    strongest_families.push({
      family_id,
      winner_id: winner.template_id,
      loser_id: topLoser.template_id,
      winner_variant_id: winner.template_id,
      loser_variant_ids: losers.map((l) => l.template_id),
      evidence: {
        winner_alpha: winner.alpha,
        winner_beta: winner.beta,
        winner_samples: winner.samples,
        loser_alpha: topLoser.alpha,
        loser_beta: topLoser.beta,
        loser_samples: topLoser.samples,
        reason: `winner ${winner.template_id} (mean=${winner.posterior_mean}) dominates loser ${topLoser.template_id} (mean=${topLoser.posterior_mean}) by ${Math.round(delta * 1000) / 1000} over ${winner.samples} winner samples`,
        confidence_threshold: promoteMinDelta,
      },
    });
  }
  strongest_families.sort((a, b) => {
    const av = (a.evidence as { winner_samples: number }).winner_samples;
    const bv = (b.evidence as { winner_samples: number }).winner_samples;
    return bv - av;
  });

  return {
    shape: "templateAuditReport",
    body: {
      total_templates_scanned: rows.length,
      eligible_candidates: candidates.length,
      weak_threshold: weakThreshold,
      min_samples: minSamples,
      weak_templates: weak,
      strongest_families,
      promote_min_delta: promoteMinDelta,
      promote_min_samples: promoteMinSamples,
      generated_at: new Date().toISOString(),
    },
  };
}
