/**
 * activity_metrics — producer for activity_metrics (capability-gap autoclosure).
 * Output shape: activity_metrics
 */

import type { ResolverResult } from "./types.js";

export interface ActivityMetricsPointer {
  type: "activity_metrics";
  [key: string]: unknown;
}

export async function resolveActivityMetrics(pointer: ActivityMetricsPointer): Promise<ResolverResult> {
const endpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const apiKey = process.env.METABOB_API_KEY ?? "";
const limit = Number((pointer as Record<string, unknown>).limit ?? 100);

try {
  // --- fetch activity templates ---
  const templatesRes = await fetch(
    `${endpoint}/v2/activities/templates?limit=${limit}`,
    {
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!templatesRes.ok) {
    return { shape: "activity_metrics", body: { error: `templates http ${templatesRes.status}` } };
  }
  const templatesData = (await templatesRes.json()) as any;
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // --- fetch composition graph ---
  const graphRes = await fetch(
    `${endpoint}/v2/activities/composition/graph?limit=200`,
    {
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : null;
  const edges: any[] = Array.isArray(graphData?.edges)
    ? graphData.edges
    : Array.isArray(graphData?.nodes)
    ? graphData.nodes
    : [];

  // --- aggregate template metrics ---
  let totalAlpha = 0;
  let totalBeta = 0;
  let totalSuccessRate = 0;
  let metricsCount = 0;
  let minSuccessRate = 1;
  let maxSuccessRate = 0;

  const shapeProducerCount: Record<string, number> = {};
  const lowConfidenceTemplates: any[] = [];

  for (const t of templates) {
    const metrics = t?.metrics;
    if (metrics != null) {
      const alpha = typeof metrics.thompson_alpha === "number" ? metrics.thompson_alpha : 0;
      const beta = typeof metrics.thompson_beta === "number" ? metrics.thompson_beta : 0;
      const sr = typeof metrics.success_rate === "number" ? metrics.success_rate : 0;

      totalAlpha += alpha;
      totalBeta += beta;
      totalSuccessRate += sr;
      metricsCount += 1;

      if (sr < minSuccessRate) minSuccessRate = sr;
      if (sr > maxSuccessRate) maxSuccessRate = sr;

      if (alpha + beta < 10) {
        lowConfidenceTemplates.push({
          id: t?.id ?? null,
          thompson_alpha: alpha,
          thompson_beta: beta,
          success_rate: sr,
        });
      }
    }

    const outputShapes: any[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const shape of outputShapes) {
      const key = typeof shape === "string" ? shape : String(shape ?? "unknown");
      shapeProducerCount[key] = (shapeProducerCount[key] ?? 0) + 1;
    }
  }

  const avgSuccessRate = metricsCount > 0 ? totalSuccessRate / metricsCount : 0;
  const avgAlpha = metricsCount > 0 ? totalAlpha / metricsCount : 0;
  const avgBeta = metricsCount > 0 ? totalBeta / metricsCount : 0;

  // --- aggregate composition edges ---
  let edgeCount = 0;
  const producerShapes = new Set<string>();
  const consumerShapes = new Set<string>();

  for (const edge of edges) {
    edgeCount += 1;
    const producer = edge?.producer ?? edge?.from ?? edge?.source;
    const consumer = edge?.consumer ?? edge?.to ?? edge?.target;
    if (typeof producer === "string") producerShapes.add(producer);
    if (typeof consumer === "string") consumerShapes.add(consumer);
  }

  // shapes that are consumed but never produced (potential gaps)
  const unsatisfiedShapes: string[] = [];
  for (const s of consumerShapes) {
    if (!producerShapes.has(s)) {
      unsatisfiedShapes.push(s);
    }
  }

  const report = {
    template_count: templates.length,
    metrics_bearing_count: metricsCount,
    avg_success_rate: avgSuccessRate,
    min_success_rate: metricsCount > 0 ? minSuccessRate : null,
    max_success_rate: metricsCount > 0 ? maxSuccessRate : null,
    avg_thompson_alpha: avgAlpha,
    avg_thompson_beta: avgBeta,
    low_confidence_template_count: lowConfidenceTemplates.length,
    low_confidence_templates: lowConfidenceTemplates,
    output_shape_producer_counts: shapeProducerCount,
    composition_edge_count: edgeCount,
    distinct_producer_shapes: producerShapes.size,
    distinct_consumer_shapes: consumerShapes.size,
    unsatisfied_consumer_shapes: unsatisfiedShapes,
  };

  return { shape: "activity_metrics", body: report };
} catch (e) {
  return { shape: "activity_metrics", body: { error: String(e) } };
}
}
