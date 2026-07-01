/**
 * source_code — producer for sourceCode (capability-gap autoclosure).
 * Output shape: sourceCode
 */

import type { ResolverResult } from "./types.js";

export interface SourceCodePointer {
  type: "source_code";
  [key: string]: unknown;
}

export async function resolveSourceCode(pointer: SourceCodePointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // Fetch activity templates to find resolvers/activities that produce or relate to sourceCode
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  if (!templatesRes.ok) {
    return { shape: "sourceCode", body: { error: `templates http ${templatesRes.status}` } };
  }
  const templatesData = (await templatesRes.json()) as any;
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // Filter templates whose output_shapes include "sourceCode"
  const sourceCodeProducers: any[] = [];
  const allShapeCounts: Record<string, number> = {};

  for (const t of templates) {
    const outputShapes: any[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const s of outputShapes) {
      const shapeName = typeof s === "string" ? s : String(s ?? "");
      allShapeCounts[shapeName] = (allShapeCounts[shapeName] ?? 0) + 1;
    }
    const producesSourceCode = outputShapes.some(
      (s) => (typeof s === "string" ? s : String(s ?? "")) === "sourceCode"
    );
    if (producesSourceCode) {
      sourceCodeProducers.push({
        id: t?.id ?? null,
        successRate: t?.metrics?.success_rate ?? null,
        thompsonAlpha: t?.metrics?.thompson_alpha ?? null,
        thompsonBeta: t?.metrics?.thompson_beta ?? null,
        outputShapes,
      });
    }
  }

  // Fetch composition graph to find edges flowing into/from sourceCode
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : null;
  const edges: any[] = Array.isArray(graphData?.edges)
    ? graphData.edges
    : Array.isArray(graphData?.nodes)
    ? []
    : Array.isArray(graphData)
    ? graphData
    : [];

  const sourceCodeEdgesAsProducer: any[] = [];
  const sourceCodeEdgesAsConsumer: any[] = [];

  for (const edge of edges) {
    const producerShape = typeof edge?.producer_shape === "string" ? edge.producer_shape : String(edge?.producer_shape ?? "");
    const consumerShape = typeof edge?.consumer_shape === "string" ? edge.consumer_shape : String(edge?.consumer_shape ?? "");
    if (producerShape === "sourceCode") {
      sourceCodeEdgesAsProducer.push({
        from: producerShape,
        to: consumerShape,
        activityId: edge?.activity_id ?? null,
        weight: edge?.weight ?? null,
      });
    }
    if (consumerShape === "sourceCode") {
      sourceCodeEdgesAsConsumer.push({
        from: producerShape,
        to: consumerShape,
        activityId: edge?.activity_id ?? null,
        weight: edge?.weight ?? null,
      });
    }
  }

  // Fetch substrate gaps to see if sourceCode is an unsatisfied demand
  const gapsRes = await fetch(`${devEndpoint}/v2/impulses/resolve`, {
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
    : Array.isArray(gapsData?.content?.gaps)
    ? gapsData.content.gaps
    : [];

  const sourceCodeGaps: any[] = [];
  for (const gap of gaps) {
    const shape = typeof gap?.shape === "string" ? gap.shape : String(gap?.shape ?? "");
    if (shape === "sourceCode") {
      sourceCodeGaps.push({
        id: gap?.id ?? null,
        status: gap?.status ?? null,
        demandCount: gap?.demand_count ?? null,
        description: gap?.description ?? null,
      });
    }
  }

  // Aggregate metrics across sourceCode producers
  let totalSuccessRate = 0;
  let successRateCount = 0;
  for (const p of sourceCodeProducers) {
    if (typeof p?.successRate === "number") {
      totalSuccessRate += p.successRate;
      successRateCount += 1;
    }
  }
  const avgSuccessRate = successRateCount > 0 ? totalSuccessRate / successRateCount : null;

  const report = {
    shape: "sourceCode",
    producerCount: sourceCodeProducers.length,
    producers: sourceCodeProducers,
    avgSuccessRate,
    compositionEdgesAsProducer: sourceCodeEdgesAsProducer,
    compositionEdgesAsConsumer: sourceCodeEdgesAsConsumer,
    openGaps: sourceCodeGaps.length,
    gaps: sourceCodeGaps,
    totalTemplatesScanned: templates.length,
    allOutputShapeCounts: allShapeCounts,
  };

  return { shape: "sourceCode", body: report };
} catch (e) {
  return { shape: "sourceCode", body: { error: String(e) } };
}
}
