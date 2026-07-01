/**
 * substantive_findings — producer for substantive_findings (capability-gap autoclosure).
 * Output shape: substantive_findings
 */

import type { ResolverResult } from "./types.js";

export interface SubstantiveFindingsPointer {
  type: "substantive_findings";
  [key: string]: unknown;
}

export async function resolveSubstantiveFindings(pointer: SubstantiveFindingsPointer): Promise<ResolverResult> {
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
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const templatesData = templatesRes.ok
    ? ((await templatesRes.json()) as any)
    : null;
  const templates: any[] = Array.isArray(templatesData?.templates)
    ? templatesData.templates
    : [];

  // --- 2. Fetch composition graph ---
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : null;
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
  const gapsData = gapsRes.ok ? ((await gapsRes.json()) as any) : null;
  const gaps: any[] = Array.isArray(gapsData?.body?.gaps)
    ? gapsData.body.gaps
    : Array.isArray(gapsData?.gaps)
    ? gapsData.gaps
    : [];

  // --- 4. Aggregate template metrics ---
  let totalSuccessRate = 0;
  let totalAlpha = 0;
  let totalBeta = 0;
  let highConfidenceCount = 0;
  let lowConfidenceCount = 0;
  const shapeCoverage: Record<string, number> = {};
  const templateSummaries: any[] = [];

  for (const tmpl of templates) {
    const metrics = tmpl?.metrics ?? {};
    const alpha = typeof metrics?.thompson_alpha === "number" ? metrics.thompson_alpha : 0;
    const beta = typeof metrics?.thompson_beta === "number" ? metrics.thompson_beta : 0;
    const successRate =
      typeof metrics?.success_rate === "number" ? metrics.success_rate : 0;

    totalSuccessRate += successRate;
    totalAlpha += alpha;
    totalBeta += beta;

    const confidence = alpha + beta > 0 ? alpha / (alpha + beta) : 0;
    if (confidence >= 0.7) highConfidenceCount += 1;
    else lowConfidenceCount += 1;

    const outputShapes: any[] = Array.isArray(tmpl?.output_shapes)
      ? tmpl.output_shapes
      : [];
    for (const shape of outputShapes) {
      if (typeof shape === "string") {
        shapeCoverage[shape] = (shapeCoverage[shape] ?? 0) + 1;
      }
    }

    templateSummaries.push({
      id: tmpl?.id ?? null,
      success_rate: successRate,
      thompson_alpha: alpha,
      thompson_beta: beta,
      thompson_confidence: confidence,
      output_shapes: outputShapes,
    });
  }

  const avgSuccessRate =
    templates.length > 0 ? totalSuccessRate / templates.length : 0;
  const avgAlpha =
    templates.length > 0 ? totalAlpha / templates.length : 0;
  const avgBeta =
    templates.length > 0 ? totalBeta / templates.length : 0;

  // --- 5. Aggregate composition graph edges ---
  const producerShapes = new Set<string>();
  const consumerShapes = new Set<string>();
  const edgeSummaries: any[] = [];

  for (const edge of edges) {
    const producer =
      typeof edge?.producer === "string"
        ? edge.producer
        : typeof edge?.from === "string"
        ? edge.from
        : null;
    const consumer =
      typeof edge?.consumer === "string"
        ? edge.consumer
        : typeof edge?.to === "string"
        ? edge.to
        : null;
    if (typeof producer === "string") producerShapes.add(producer);
    if (typeof consumer === "string") consumerShapes.add(consumer);
    edgeSummaries.push({ producer, consumer });
  }

  // Shapes that are consumed but not produced — potential gaps in graph
  const unconsumedShapes: string[] = [];
  for (const s of consumerShapes) {
    if (!producerShapes.has(s)) unconsumedShapes.push(s);
  }

  // --- 6. Aggregate substrate gaps ---
  const gapsByShape: Record<string, number> = {};
  const openGapSummaries: any[] = [];

  for (const gap of gaps) {
    const shape =
      typeof gap?.shape === "string"
        ? gap.shape
        : typeof gap?.output_shape === "string"
        ? gap.output_shape
        : "unknown";
    gapsByShape[shape] = (gapsByShape[shape] ?? 0) + 1;
    openGapSummaries.push({
      shape,
      id: gap?.id ?? null,
      status: gap?.status ?? null,
      description: gap?.description ?? null,
    });
  }

  // --- 7. Identify top performers and underperformers ---
  const sorted = [...templateSummaries].sort(
    (a, b) => (b?.success_rate ?? 0) - (a?.success_rate ?? 0)
  );
  const topPerformers = sorted.slice(0, 5).map((t) => ({
    id: t?.id,
    success_rate: t?.success_rate,
    thompson_confidence: t?.thompson_confidence,
  }));
  const underperformers = sorted
    .slice(-5)
    .reverse()
    .map((t) => ({
      id: t?.id,
      success_rate: t?.success_rate,
      thompson_confidence: t?.thompson_confidence,
    }));

  // --- 8. Compose final report ---
  const report = {
    summary: {
      total_templates: templates.length,
      avg_success_rate: avgSuccessRate,
      avg_thompson_alpha: avgAlpha,
      avg_thompson_beta: avgBeta,
      high_confidence_templates: highConfidenceCount,
      low_confidence_templates: lowConfidenceCount,
    },
    top_performers: topPerformers,
    underperformers: underperformers,
    shape_coverage: shapeCoverage,
    composition_graph: {
      total_edges: edges.length,
      unique_producer_shapes: producerShapes.size,
      unique_consumer_shapes: consumerShapes.size,
      shapes_consumed_but_not_produced: unconsumedShapes,
    },
    substrate_gaps: {
      total_open_gaps: gaps.length,
      gaps_by_shape: gapsByShape,
      gap_details: openGapSummaries.slice(0, 50),
    },
    data_health: {
      templates_endpoint_ok: templatesRes.ok,
      graph_endpoint_ok: graphRes.ok,
      gaps_endpoint_ok: gapsRes.ok,
    },
  };

  return { shape: "substantive_findings", body: report };
} catch (e) {
  return { shape: "substantive_findings", body: { error: String(e) } };
}
}
