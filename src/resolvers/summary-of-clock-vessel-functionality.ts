/**
 * summary_of_clock_vessel_functionality — producer for summary_of_clock_vessel_functionality (capability-gap autoclosure).
 * Output shape: summary_of_clock_vessel_functionality
 */

import type { ResolverResult } from "./types.js";

export interface SummaryOfClockVesselFunctionalityPointer {
  type: "summary_of_clock_vessel_functionality";
  [key: string]: unknown;
}

export async function resolveSummaryOfClockVesselFunctionality(pointer: SummaryOfClockVesselFunctionalityPointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devVesselEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";

const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // --- Fetch 1: activity templates ---
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );

  let templates: any[] = [];
  if (templatesRes.ok) {
    const templatesData = (await templatesRes.json()) as any;
    templates = Array.isArray(templatesData?.templates) ? templatesData.templates : [];
  }

  // --- Fetch 2: composition graph ---
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );

  let compositionEdges: any[] = [];
  if (graphRes.ok) {
    const graphData = (await graphRes.json()) as any;
    // tolerate various envelope shapes
    if (Array.isArray(graphData?.edges)) {
      compositionEdges = graphData.edges;
    } else if (Array.isArray(graphData?.nodes)) {
      compositionEdges = graphData.nodes;
    } else if (Array.isArray(graphData)) {
      compositionEdges = graphData;
    }
  }

  // --- Fetch 3: substrate gaps from dev-vessel ---
  const gapsRes = await fetch(
    `${devVesselEndpoint}/v2/impulses/resolve`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        impulse: { pointer: { type: "substrateGap", status: "open", limit: 200 } },
      }),
    }
  );

  let gaps: any[] = [];
  if (gapsRes.ok) {
    const gapsData = (await gapsRes.json()) as any;
    const gapsBody = gapsData?.body ?? gapsData?.content ?? gapsData;
    gaps = Array.isArray(gapsBody?.gaps) ? gapsBody.gaps : [];
  }

  // --- Aggregate: clock-vessel relevant templates ---
  // Identify clock-vessel activities: those whose output_shapes mention "clock" or whose id mentions "clock"
  const clockTemplates: any[] = templates.filter((t: any) => {
    const id: string = typeof t?.id === "string" ? t.id : "";
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    const shapesStr = outputShapes.join(" ").toLowerCase();
    return id.toLowerCase().includes("clock") || shapesStr.includes("clock");
  });

  // Aggregate metrics for clock templates
  let totalSuccessRate = 0;
  let totalAlpha = 0;
  let totalBeta = 0;
  let clockTemplatesWithMetrics = 0;

  const clockTemplateSummaries: any[] = [];

  for (const t of clockTemplates) {
    const id: string = typeof t?.id === "string" ? t.id : "unknown";
    const metrics = t?.metrics ?? {};
    const successRate: number = typeof metrics?.success_rate === "number" ? metrics.success_rate : 0;
    const alpha: number = typeof metrics?.thompson_alpha === "number" ? metrics.thompson_alpha : 0;
    const beta: number = typeof metrics?.thompson_beta === "number" ? metrics.thompson_beta : 0;
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];

    totalSuccessRate += successRate;
    totalAlpha += alpha;
    totalBeta += beta;
    if (alpha > 0 || beta > 0) clockTemplatesWithMetrics++;

    clockTemplateSummaries.push({
      id,
      output_shapes: outputShapes,
      success_rate: successRate,
      thompson_alpha: alpha,
      thompson_beta: beta,
    });
  }

  const avgSuccessRate =
    clockTemplates.length > 0 ? totalSuccessRate / clockTemplates.length : 0;

  // --- Aggregate: composition edges touching clock shapes ---
  const clockEdges: any[] = compositionEdges.filter((e: any) => {
    const producer: string = typeof e?.producer === "string" ? e.producer : "";
    const consumer: string = typeof e?.consumer === "string" ? e.consumer : "";
    const fromShape: string = typeof e?.from_shape === "string" ? e.from_shape : "";
    const toShape: string = typeof e?.to_shape === "string" ? e.to_shape : "";
    const shape: string = typeof e?.shape === "string" ? e.shape : "";
    const combined = [producer, consumer, fromShape, toShape, shape].join(" ").toLowerCase();
    return combined.includes("clock");
  });

  // Unique shapes produced/consumed by clock activities
  const clockOutputShapesSet = new Set<string>();
  for (const t of clockTemplates) {
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const s of outputShapes) {
      if (typeof s === "string") clockOutputShapesSet.add(s);
    }
  }

  // --- Aggregate: gaps related to clock shapes ---
  const clockGaps: any[] = gaps.filter((g: any) => {
    const shape: string = typeof g?.shape === "string" ? g.shape : "";
    const type: string = typeof g?.type === "string" ? g.type : "";
    return shape.toLowerCase().includes("clock") || type.toLowerCase().includes("clock");
  });

  // --- All output shapes produced across all templates (for context) ---
  const allOutputShapes: string[] = [];
  for (const t of templates) {
    const outputShapes: string[] = Array.isArray(t?.output_shapes) ? t.output_shapes : [];
    for (const s of outputShapes) {
      if (typeof s === "string") allOutputShapes.push(s);
    }
  }

  const report = {
    summary: "Summary of clock-vessel functionality derived from live substrate data",
    total_templates_scanned: templates.length,
    clock_vessel: {
      template_count: clockTemplates.length,
      templates_with_thompson_metrics: clockTemplatesWithMetrics,
      avg_success_rate: avgSuccessRate,
      total_thompson_alpha: totalAlpha,
      total_thompson_beta: totalBeta,
      output_shapes_produced: Array.from(clockOutputShapesSet),
      templates: clockTemplateSummaries,
    },
    composition: {
      total_edges_scanned: compositionEdges.length,
      clock_related_edges: clockEdges.length,
      clock_edge_details: clockEdges.slice(0, 20),
    },
    substrate_gaps: {
      total_open_gaps: gaps.length,
      clock_related_gaps: clockGaps.length,
      clock_gap_details: clockGaps.slice(0, 20),
    },
    health_indicator:
      clockTemplates.length === 0
        ? "no_clock_templates_found"
        : avgSuccessRate >= 0.8
        ? "healthy"
        : avgSuccessRate >= 0.5
        ? "degraded"
        : "critical",
  };

  return { shape: "summary_of_clock_vessel_functionality", body: report };
} catch (e) {
  return { shape: "summary_of_clock_vessel_functionality", body: { error: String(e) } };
}
}
