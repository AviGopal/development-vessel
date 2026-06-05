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

  return {
    shape: "templateAuditReport",
    body: {
      total_templates_scanned: rows.length,
      eligible_candidates: candidates.length,
      weak_threshold: weakThreshold,
      min_samples: minSamples,
      weak_templates: weak,
      generated_at: new Date().toISOString(),
    },
  };
}
