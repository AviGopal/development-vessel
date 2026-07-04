/**
 * selection_entropy — substrate-authored resolver (Seam ③).
 * Output shape: selectionEntropy
 */

import type { ResolverResult } from "./types.js";

export interface SelectionEntropyPointer {
  type: "selection_entropy";
  [key: string]: unknown;
}

export async function resolveSelectionEntropy(pointer: SelectionEntropyPointer): Promise<ResolverResult> {
  // selection_entropy — measure anti-crystallization of Thompson selection.
  // Reads REAL per-template posteriors from activity-api, treats normalized
  // posterior means as a selection distribution, computes Shannon entropy
  // (normalized 0..1), bins by success-rate bucket, flags collapsed buckets.
  const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
  const apiKey = process.env.METABOB_API_KEY ?? "";
  const p = pointer as Record<string, unknown>;
  const limit = Number(p.limit ?? 100) || 100;
  const floor = Number(p.entropy_floor ?? 0.5) || 0.5;

  const normEntropy = (means: number[]): number => {
    const positive = means.filter((m) => m > 0);
    const total = positive.reduce((a, b) => a + b, 0);
    const n = positive.length;
    if (n <= 1 || total <= 0) return n <= 1 ? 0 : 1;
    let h = 0;
    for (const m of positive) {
      const q = m / total;
      if (q > 0) h -= q * Math.log(q);
    }
    return h / Math.log(n);
  };

  try {
    const res = await fetch(`${endpoint}/v2/activities/templates?limit=${limit}`, {
      headers: { Authorization: `ApiKey ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      return {
        shape: "selectionEntropy",
        body: {
          overall_entropy: 0,
          collapsed: true,
          per_bucket: [],
          recommendation: `could not read templates: http ${res.status}`,
          error: `templates http ${res.status}`,
        },
      };
    }
    const data = (await res.json()) as { templates?: Array<Record<string, unknown>> };
    const templates = Array.isArray(data.templates) ? data.templates : [];

    type Row = { id: string; mean: number; success: number };
    const rows: Row[] = [];
    for (const t of templates) {
      const m = (t.metrics ?? {}) as Record<string, unknown>;
      const alpha = Number(m.thompson_alpha ?? 1) || 1;
      const beta = Number(m.thompson_beta ?? 1) || 1;
      const denom = alpha + beta;
      if (denom <= 0) continue;
      const mean = alpha / denom;
      const success = Number(m.success_rate ?? 0) || 0;
      const id = typeof t.id === "string" ? t.id : String(t.id ?? "unknown");
      rows.push({ id, mean, success });
    }

    const overall = normEntropy(rows.map((r) => r.mean));

    // Bucket by success-rate band as a coarse context proxy.
    const buckets = new Map<string, number[]>([
      ["success_0.00_0.33", []],
      ["success_0.33_0.66", []],
      ["success_0.66_1.00", []],
    ]);
    for (const r of rows) {
      const key =
        r.success < 0.33 ? "success_0.00_0.33" : r.success < 0.66 ? "success_0.33_0.66" : "success_0.66_1.00";
      const arr = buckets.get(key);
      if (arr) arr.push(r.mean);
    }

    const per_bucket: Array<{ bucket: string; entropy: number; count: number; collapsed: boolean }> = [];
    for (const [bucket, means] of buckets) {
      if (means.length === 0) continue;
      const e = normEntropy(means);
      per_bucket.push({
        bucket,
        entropy: Math.round(e * 10000) / 10000,
        count: means.length,
        collapsed: e < floor,
      });
    }

    const collapsedBuckets = per_bucket.filter((b) => b.collapsed).map((b) => b.bucket);
    const collapsed = overall < floor || collapsedBuckets.length > 0;
    // Never-converging check: maximal entropy with every sampled template stuck
    // in the low-success band means nothing is winning — that is not healthy
    // exploration, it is a posterior that never converges.
    const lowBucket = per_bucket.find((b) => b.bucket === "success_0.00_0.33");
    const neverConverging = !collapsed && lowBucket !== undefined && lowBucket.count === rows.length && rows.length >= 10;
    const recommendation = collapsed
      ? `Selection has crystallized (overall_entropy=${Math.round(overall * 1000) / 1000} < floor=${floor}` +
        (collapsedBuckets.length ? `; collapsed buckets: ${collapsedBuckets.join(", ")}` : "") +
        `). Increase exploration: widen Thompson priors, inject novel templates, or reduce reuse bias.`
      : neverConverging
        ? `Selection is NEVER-CONVERGING (overall_entropy=${Math.round(overall * 1000) / 1000}, but all ${rows.length} sampled templates sit in success_0.00_0.33). Entropy is high because nothing wins, not because exploration is healthy. Investigate reward flow: are successes being credited (alpha) at all for these templates?`
        : `Selection is healthy (overall_entropy=${Math.round(overall * 1000) / 1000} >= floor=${floor}); exploration spread is adequate.`;

    return {
      shape: "selectionEntropy",
      body: {
        overall_entropy: Math.round(overall * 10000) / 10000,
        collapsed,
        never_converging: neverConverging,
        template_count: rows.length,
        entropy_floor: floor,
        collapsed_buckets: collapsedBuckets,
        per_bucket,
        recommendation,
      },
    };
  } catch (e) {
    return {
      shape: "selectionEntropy",
      body: {
        overall_entropy: 0,
        collapsed: true,
        per_bucket: [],
        recommendation: `entropy computation failed: ${e instanceof Error ? e.message : String(e)}`,
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }

}
