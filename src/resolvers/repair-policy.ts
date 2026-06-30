/**
 * repair_policy — producer for repairPolicy (capability-gap autoclosure).
 * Output shape: repairPolicy
 */

import type { ResolverResult } from "./types.js";

export interface RepairPolicyPointer {
  type: "repair_policy";
  [key: string]: unknown;
}

export async function resolveRepairPolicy(pointer: RepairPolicyPointer): Promise<ResolverResult> {
const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const devEndpoint = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
const apiKey = process.env.METABOB_API_KEY ?? "";
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

try {
  // Fetch activity templates to assess reliability metrics
  const templatesRes = await fetch(
    `${activityEndpoint}/v2/activities/templates?limit=100`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  if (!templatesRes.ok) {
    return { shape: "repairPolicy", body: { error: `templates http ${templatesRes.status}` } };
  }
  const templatesData = (await templatesRes.json()) as any;
  const templates: any[] = Array.isArray(templatesData?.templates) ? templatesData.templates : [];

  // Fetch composition graph to understand shape flow dependencies
  const graphRes = await fetch(
    `${activityEndpoint}/v2/activities/composition/graph?limit=200`,
    { headers, signal: AbortSignal.timeout(20000) }
  );
  const graphData = graphRes.ok ? ((await graphRes.json()) as any) : null;
  const edges: any[] = Array.isArray(graphData?.edges) ? graphData.edges : [];

  // Fetch substrate gaps from dev-vessel to understand unresolved demands
  const gapsRes = await fetch(
    `${devEndpoint}/v2/impulses/resolve`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", status: "open", limit: 200 } } }),
    }
  );
  const gapsData = gapsRes.ok ? ((await gapsRes.json()) as any) : null;
  const gaps: any[] = Array.isArray(gapsData?.body?.gaps) ? gapsData.body.gaps : [];

  // Analyze templates for failure-prone activities (low success rate or skewed thompson params)
  interface ActivityRisk {
    id: string;
    successRate: number;
    thompsonAlpha: number;
    thompsonBeta: number;
    riskScore: number;
    outputShapes: string[];
    repairRecommendation: string;
  }

  const activityRisks: ActivityRisk[] = [];

  for (const tmpl of templates) {
    const id: string = typeof tmpl?.id === "string" ? tmpl.id : String(tmpl?.id ?? "unknown");
    const metrics = tmpl?.metrics ?? {};
    const successRate: number = typeof metrics?.success_rate === "number" ? metrics.success_rate : 0;
    const alpha: number = typeof metrics?.thompson_alpha === "number" ? metrics.thompson_alpha : 1;
    const beta: number = typeof metrics?.thompson_beta === "number" ? metrics.thompson_beta : 1;
    const outputShapes: string[] = Array.isArray(tmpl?.output_shapes) ? tmpl.output_shapes : [];

    // Thompson posterior mean = alpha / (alpha + beta); risk is inverse
    const thompsonMean = (alpha + beta) > 0 ? alpha / (alpha + beta) : 0.5;
    // Composite risk: weight success_rate 60%, thompson mean 40%
    const compositeScore = (successRate * 0.6) + (thompsonMean * 0.4);
    const riskScore = Math.round((1 - compositeScore) * 100);

    let repairRecommendation = "monitor";
    if (riskScore >= 70) {
      repairRecommendation = "immediate-intervention";
    } else if (riskScore >= 40) {
      repairRecommendation = "schedule-review";
    } else if (riskScore >= 20) {
      repairRecommendation = "low-priority-watch";
    }

    activityRisks.push({
      id,
      successRate,
      thompsonAlpha: alpha,
      thompsonBeta: beta,
      riskScore,
      outputShapes,
      repairRecommendation,
    });
  }

  // Sort by riskScore descending
  activityRisks.sort((a, b) => b.riskScore - a.riskScore);

  // Summarise gap categories
  interface GapSummary {
    shape: string;
    count: number;
  }
  const gapMap: Record<string, number> = {};
  for (const gap of gaps) {
    const shape: string = typeof gap?.shape === "string" ? gap.shape : (typeof gap?.type === "string" ? gap.type : "unknown");
    gapMap[shape] = (gapMap[shape] ?? 0) + 1;
  }
  const gapSummary: GapSummary[] = Object.entries(gapMap).map(([shape, count]) => ({ shape, count }));
  gapSummary.sort((a, b) => b.count - a.count);

  // Correlate gaps with high-risk activities via output shapes
  const criticalShapes: string[] = gapSummary
    .filter((g) => g.count >= 2)
    .map((g) => g.shape);

  const criticalActivities = activityRisks.filter((a) =>
    a.outputShapes.some((s) => criticalShapes.includes(s))
  );

  // Compute edge-level repair surface: edges whose producer has high risk
  const highRiskIds = new Set(
    activityRisks.filter((a) => a.riskScore >= 40).map((a) => a.id)
  );
  const atRiskEdges: Array<{ producer: string; consumer: string; shape: string }> = [];
  for (const edge of edges) {
    const producer: string = typeof edge?.producer === "string" ? edge.producer : String(edge?.producer ?? "");
    const consumer: string = typeof edge?.consumer === "string" ? edge.consumer : String(edge?.consumer ?? "");
    const shape: string = typeof edge?.shape === "string" ? edge.shape : String(edge?.shape ?? "");
    if (highRiskIds.has(producer)) {
      atRiskEdges.push({ producer, consumer, shape });
    }
  }

  // Policy thresholds
  const policyThresholds = {
    immediateInterventionMinRisk: 70,
    scheduleReviewMinRisk: 40,
    lowPriorityWatchMinRisk: 20,
    criticalGapMinCount: 2,
  };

  // Overall health score: average (100 - riskScore) across all templates, or 100 if none
  const overallHealth =
    activityRisks.length > 0
      ? Math.round(
          activityRisks.reduce((sum, a) => sum + (100 - a.riskScore), 0) /
            activityRisks.length
        )
      : 100;

  const report = {
    overallHealthScore: overallHealth,
    totalActivitiesEvaluated: templates.length,
    totalGapsOpen: gaps.length,
    policyThresholds,
    activityRisks: activityRisks.slice(0, 50), // top 50 by risk
    gapSummary,
    criticalShapes,
    criticalActivities: criticalActivities.slice(0, 20),
    atRiskEdges: atRiskEdges.slice(0, 50),
    repairPriorityCounts: {
      immediateIntervention: activityRisks.filter((a) => a.repairRecommendation === "immediate-intervention").length,
      scheduleReview: activityRisks.filter((a) => a.repairRecommendation === "schedule-review").length,
      lowPriorityWatch: activityRisks.filter((a) => a.repairRecommendation === "low-priority-watch").length,
      monitor: activityRisks.filter((a) => a.repairRecommendation === "monitor").length,
    },
  };

  return { shape: "repairPolicy", body: report };
} catch (e) {
  return { shape: "repairPolicy", body: { error: String(e) } };
}
}
