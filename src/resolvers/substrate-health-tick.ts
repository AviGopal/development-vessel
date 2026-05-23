import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SubstrateHealthTickPointer {
  type: "substrate_health_tick";
  lookback_window_seconds?: number;
  // Operator-tunable thresholds (defaults match spec §G table)
  confidence_floor?: number;           // default 10 (α+β)
  confidence_ratio_threshold?: number; // default 0.5
  stability_rate_ceiling?: number;     // default 1.0 per hour
  optimality_ratio_ceiling?: number;   // default 2.0
}

interface VariantMetrics {
  id: string;
  activity_template_id?: string;
  thompson_alpha?: number;
  thompson_beta?: number;
  sample_size?: number;
}

interface Template {
  id: string;
  created_at?: string;
}

interface CompositionEdge {
  from_activity: string;
  via_shape: string;
  to_activity: string;
  created_at?: string;
}

interface HarnessReport {
  mean_optimality_ratio?: number;
  run_at?: string;
  generated_at?: string;
}

async function readMostRecentHarnessReport(workspace: string): Promise<HarnessReport | null> {
  const resultsDir = join(workspace, "validation", "results");
  let files: string[] = [];
  try {
    const entries = await readdir(resultsDir, { withFileTypes: true });
    files = entries
      .filter(e => e.isFile() && e.name.endsWith(".json") && e.name.includes("harness"))
      .map(e => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic date prefix)
  } catch {
    return null;
  }
  for (const fname of files.slice(0, 5)) {
    try {
      const raw = await readFile(join(resultsDir, fname), "utf-8");
      const parsed = JSON.parse(raw) as HarnessReport;
      return parsed;
    } catch { /* try next */ }
  }
  return null;
}

export async function resolveSubstrateHealthTick(
  pointer: SubstrateHealthTickPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  const confidenceFloor = pointer.confidence_floor ?? 10;
  const confidenceRatioThreshold = pointer.confidence_ratio_threshold ?? 0.5;
  const stabilityRateCeiling = pointer.stability_rate_ceiling ?? 1.0;
  const optimalityRatioCeiling = pointer.optimality_ratio_ceiling ?? 2.0;

  // — Posterior confidence: fetch variant_performance_metrics via templates list —
  // Activity-api exposes thompson_alpha/beta at the template level (no separate
  // variant_performance_metrics endpoint in v1); use templates as proxy.
  const templates: Template[] = [];
  const variantPairs: { alpha: number; beta: number }[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: (Template & { thompson_alpha?: number; thompson_beta?: number })[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    for (const tpl of rows) {
      variantPairs.push({ alpha: tpl.thompson_alpha ?? 1, beta: tpl.thompson_beta ?? 1 });
    }
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  const total_pairs = variantPairs.length;
  const pairs_above_floor = variantPairs.filter(p => (p.alpha + p.beta) >= confidenceFloor).length;
  const alphaBetaSums = variantPairs.map(p => p.alpha + p.beta);
  alphaBetaSums.sort((a, b) => a - b);
  const median_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs / 2)]
    : 0;
  const p25_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.25)]
    : 0;
  const p75_alpha_plus_beta = total_pairs > 0
    ? alphaBetaSums[Math.floor(total_pairs * 0.75)]
    : 0;
  const mean_variance = total_pairs > 0
    ? variantPairs.reduce((sum, p) => {
        const ab = p.alpha + p.beta;
        return sum + (p.alpha * p.beta) / (ab * ab * (ab + 1));
      }, 0) / total_pairs
    : 0;

  const posterior_confidence = {
    total_pairs,
    pairs_above_floor,
    floor: confidenceFloor,
    median_alpha_plus_beta,
    p25_alpha_plus_beta,
    p75_alpha_plus_beta,
    mean_variance,
  };

  // — Graph stability: new templates + edges in the lookback window —
  const recentTemplates = templates.filter(t => t.created_at && t.created_at >= since);
  const new_templates_added = recentTemplates.length;
  const template_count_at_window_start = templates.length - new_templates_added;
  const template_count_at_window_end = templates.length;

  // Composition edges: fetch from composition success endpoint (best-effort)
  let new_edges_added = 0;
  try {
    const edgeRes = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/composition?since=${encodeURIComponent(since)}&limit=200`,
      { headers: auth },
    );
    if (edgeRes.ok) {
      const edgeData = await edgeRes.json() as { edges?: CompositionEdge[]; compositions?: CompositionEdge[] };
      const edges = edgeData.edges ?? edgeData.compositions ?? [];
      new_edges_added = edges.filter(e => e.created_at && e.created_at >= since).length;
    }
  } catch { /* non-critical */ }

  const hours = lookbackSecs / 3600;
  const mutation_rate_per_hour = (new_templates_added + new_edges_added) / Math.max(hours, 0.001);

  const graph_stability = {
    new_templates_added,
    new_edges_added,
    template_count_at_window_start,
    template_count_at_window_end,
    mutation_rate_per_hour,
  };

  // — Optimality: read most recent harness report —
  const harnessReport = await readMostRecentHarnessReport(WORKSPACE_ROOT);
  const optimality = {
    most_recent_harness_run_at: harnessReport?.run_at ?? harnessReport?.generated_at ?? null,
    mean_optimality_ratio: harnessReport?.mean_optimality_ratio ?? null,
  };

  // — Health verdict —
  const confidence_passing =
    total_pairs === 0 ? false : pairs_above_floor / total_pairs >= confidenceRatioThreshold;
  const stability_passing = mutation_rate_per_hour <= stabilityRateCeiling;
  const optimality_passing =
    optimality.mean_optimality_ratio !== null
      ? optimality.mean_optimality_ratio <= optimalityRatioCeiling
      : null;
  const overall_passing =
    confidence_passing &&
    stability_passing &&
    (optimality_passing === null ? true : optimality_passing);

  return {
    shape: "substrateHealthReport",
    body: {
      generated_at: new Date().toISOString(),
      lookback_window_seconds: lookbackSecs,
      posterior_confidence,
      graph_stability,
      optimality,
      health_verdict: {
        confidence_passing,
        stability_passing,
        optimality_passing,
        overall_passing,
      },
    },
  };
}
