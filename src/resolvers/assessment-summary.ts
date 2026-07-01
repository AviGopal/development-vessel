/**
 * assessment_summary — producer for assessment_summary (capability-gap autoclosure).
 * Output shape: assessment_summary
 */

import type { ResolverResult } from "./types.js";

export interface AssessmentSummaryPointer {
  type: "assessment_summary";
  [key: string]: unknown;
}

export async function resolveAssessmentSummary(pointer: AssessmentSummaryPointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // 1. Fetch activity templates
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const templatesData = templatesRes.ok ? ((await templatesRes.json()) as any) : {};
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // 2. Fetch composition graph
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : {};
  const edges: any[] = Array.isArray(graphData?.edges)
    ? graphData.edges
    : Array.isArray(graphData?.nodes)
    ? graphData.nodes
    : [];

  // 3. Fetch substrate gaps from dev-vessel
  const gapsRes = await fetch(`${devEndpoint}/v2/impulses/resolve`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      impulse: { pointer: { type: "substrateGap", status: "open", limit: 200 } },
    }),
  });
  const gapsData = gapsRes.ok ? ((await gapsRes.json()) as any) : {};
  const gaps: any[] = Array.isArray(gapsData?.body?.gaps)
    ? gapsData.body.gaps
    : Array.isArray(gapsData?.gaps)
    ? gapsData.gaps
    : [];

  // --- Aggregate template metrics ---
  let totalTemplates = templates.length;
  let totalSuccessRate = 0;
  let totalAlpha = 0;
  let totalBeta = 0;
  let highConfidenceCount = 0;
  let lowConfidenceCount = 0;
  const outputShapeCounts: Record<string, number> = {};
  const templateSummaries: any[] = [];

  for (const t of templates) {
    const metrics = t?.metrics ?? {};
    const alpha: number = typeof metrics?.thompson_alpha === "number" ? metrics.thompson_alpha : 0;
    const beta: number = typeof metrics?.thompson_beta === "number" ? metrics.thompson_beta : 0;
    const successRate: number = typeof metrics?.success_rate === "number" ? metrics.success_rate : 0;

    totalSuccessRate += successRate;
    totalAlpha += alpha;
    totalBeta += beta;

    const confidence = alpha + beta > 0 ? alpha / (alpha + beta) : 0;
    if (confidence >= 0.7) highConfidenceCount += 1;
    else lowConfidenceCount += 1;

    const shapes: any[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const s of shapes) {
      const shapeName: string = typeof s === "string" ? s : String(s ?? "unknown");
      outputShapeCounts[shapeName] = (outputShapeCounts[shapeName] ?? 0) + 1;
    }

    templateSummaries.push({
      id: t?.id ?? null,
      success_rate: successRate,
      thompson_alpha: alpha,
      thompson_beta: beta,
      thompson_confidence: confidence,
      output_shapes: shapes,
    });
  }

  const avgSuccessRate = totalTemplates > 0 ? totalSuccessRate / totalTemplates : 0;
  const avgAlpha = totalTemplates > 0 ? totalAlpha / totalTemplates : 0;
  const avgBeta = totalTemplates > 0 ? totalBeta / totalTemplates : 0;
  const avgThompsonConfidence = avgAlpha + avgBeta > 0 ? avgAlpha / (avgAlpha + avgBeta) : 0;

  // --- Aggregate composition graph ---
  const producerShapes = new Set<string>();
  const consumerShapes = new Set<string>();
  for (const edge of edges) {
    const producer: string = typeof edge?.producer === "string" ? edge.producer : String(edge?.producer ?? "");
    const consumer: string = typeof edge?.consumer === "string" ? edge.consumer : String(edge?.consumer ?? "");
    if (producer) producerShapes.add(producer);
    if (consumer) consumerShapes.add(consumer);
  }
  const totalEdges = edges.length;

  // --- Aggregate gaps ---
  const totalGaps = gaps.length;
  const openGapShapes: string[] = [];
  const gapStatusCounts: Record<string, number> = {};
  for (const g of gaps) {
    const shape: string = typeof g?.shape === "string" ? g.shape : String(g?.shape ?? "unknown");
    const status: string = typeof g?.status === "string" ? g.status : "unknown";
    openGapShapes.push(shape);
    gapStatusCounts[status] = (gapStatusCounts[status] ?? 0) + 1;
  }

  // --- Build top output shapes list ---
  const topOutputShapes = Object.entries(outputShapeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([shape, count]) => ({ shape, count }));

  const report = {
    total_templates: totalTemplates,
    avg_success_rate: avgSuccessRate,
    avg_thompson_alpha: avgAlpha,
    avg_thompson_beta: avgBeta,
    avg_thompson_confidence: avgThompsonConfidence,
    high_confidence_templates: highConfidenceCount,
    low_confidence_templates: lowConfidenceCount,
    top_output_shapes: topOutputShapes,
    composition_graph: {
      total_edges: totalEdges,
      unique_producer_shapes: producerShapes.size,
      unique_consumer_shapes: consumerShapes.size,
    },
    substrate_gaps: {
      total_open_gaps: totalGaps,
      gap_status_breakdown: gapStatusCounts,
      open_gap_shapes: openGapShapes.slice(0, 50),
    },
    templates: templateSummaries,
  };

  return { shape: "assessment_summary", body: report };
} catch (e) {
  return { shape: "assessment_summary", body: { error: String(e) } };
}
}
