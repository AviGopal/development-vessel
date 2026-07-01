/**
 * goal_summary — producer for goal_summary (capability-gap autoclosure).
 * Output shape: goal_summary
 */

import type { ResolverResult } from "./types.js";

export interface GoalSummaryPointer {
  type: "goal_summary";
  [key: string]: unknown;
}

export async function resolveGoalSummary(pointer: GoalSummaryPointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devVesselEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // --- 1. Fetch activity templates ---
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const templatesData = templatesRes.ok ? ((await templatesRes.json()) as any) : {};
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // --- 2. Fetch composition graph ---
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

  // --- 3. Fetch substrate gaps from dev-vessel ---
  const gapsRes = await fetch(`${devVesselEndpoint}/v2/impulses/resolve`, {
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

  // --- 4. Aggregate template-level metrics ---
  let totalAlpha = 0;
  let totalBeta = 0;
  let totalSuccessRate = 0;
  let metricsCount = 0;
  let totalShapes = 0;

  const shapeProducerMap: Record<string, number> = {};
  const topTemplates: Array<{ id: string; success_rate: number; output_shapes: string[] }> = [];

  for (const t of templates) {
    const alpha: number = typeof t?.metrics?.thompson_alpha === "number" ? t.metrics.thompson_alpha : 0;
    const beta: number = typeof t?.metrics?.thompson_beta === "number" ? t.metrics.thompson_beta : 0;
    const sr: number = typeof t?.metrics?.success_rate === "number" ? t.metrics.success_rate : 0;
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];

    totalAlpha += alpha;
    totalBeta += beta;
    totalSuccessRate += sr;
    metricsCount += 1;
    totalShapes += outputShapes.length;

    for (const shape of outputShapes) {
      if (typeof shape === "string") {
        shapeProducerMap[shape] = (shapeProducerMap[shape] ?? 0) + 1;
      }
    }

    const id: string = typeof t?.id === "string" ? t.id : String(t?.id ?? "unknown");
    topTemplates.push({ id, success_rate: sr, output_shapes: outputShapes });
  }

  topTemplates.sort((a, b) => b.success_rate - a.success_rate);
  const top5 = topTemplates.slice(0, 5).map((t) => ({
    id: t.id,
    success_rate: t.success_rate,
    output_shapes: t.output_shapes,
  }));

  const avgSuccessRate = metricsCount > 0 ? totalSuccessRate / metricsCount : 0;
  const avgAlpha = metricsCount > 0 ? totalAlpha / metricsCount : 0;
  const avgBeta = metricsCount > 0 ? totalBeta / metricsCount : 0;

  // --- 5. Aggregate composition graph ---
  const uniqueProducers = new Set<string>();
  const uniqueConsumers = new Set<string>();
  for (const edge of edges) {
    if (typeof edge?.producer === "string") uniqueProducers.add(edge.producer);
    if (typeof edge?.consumer === "string") uniqueConsumers.add(edge.consumer);
    if (typeof edge?.from === "string") uniqueProducers.add(edge.from);
    if (typeof edge?.to === "string") uniqueConsumers.add(edge.to);
  }

  // --- 6. Aggregate gaps ---
  const gapShapes: string[] = [];
  const gapsByStatus: Record<string, number> = {};
  for (const gap of gaps) {
    const shape: string = typeof gap?.shape === "string" ? gap.shape : String(gap?.shape ?? "unknown");
    const status: string = typeof gap?.status === "string" ? gap.status : "unknown";
    gapShapes.push(shape);
    gapsByStatus[status] = (gapsByStatus[status] ?? 0) + 1;
  }

  // --- 7. Identify unsatisfied shapes (gaps with no known producer) ---
  const unsatisfiedShapes = gapShapes.filter((s) => !(s in shapeProducerMap));

  // --- 8. Build report ---
  const report = {
    template_count: templates.length,
    avg_success_rate: Math.round(avgSuccessRate * 10000) / 10000,
    avg_thompson_alpha: Math.round(avgAlpha * 10000) / 10000,
    avg_thompson_beta: Math.round(avgBeta * 10000) / 10000,
    total_output_shapes_registered: totalShapes,
    unique_produced_shapes: Object.keys(shapeProducerMap).length,
    top_templates_by_success_rate: top5,
    composition_graph: {
      edge_count: edges.length,
      unique_producer_nodes: uniqueProducers.size,
      unique_consumer_nodes: uniqueConsumers.size,
    },
    substrate_gaps: {
      total_open_gaps: gaps.length,
      gaps_by_status: gapsByStatus,
      unsatisfied_shape_count: unsatisfiedShapes.length,
      unsatisfied_shapes: unsatisfiedShapes.slice(0, 20),
    },
    goal_health: {
      has_producers: templates.length > 0,
      composition_connected: edges.length > 0,
      open_gaps_present: gaps.length > 0,
      coverage_ratio:
        gaps.length > 0
          ? Math.round(((gaps.length - unsatisfiedShapes.length) / gaps.length) * 10000) / 10000
          : 1,
    },
  };

  return { shape: "goal_summary", body: report };
} catch (e) {
  return { shape: "goal_summary", body: { error: String(e) } };
}
}
