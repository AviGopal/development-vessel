import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ReachableUnlearnedReportPointer {
  type: "reachable_unlearned_report";
  lookback_window_seconds?: number;
}

interface Template {
  id: string;
  output_shapes?: string[];
  thompson_alpha?: number;
}

interface TraceRow {
  output_shapes?: string[];
}

export async function resolveReachableUnlearnedReport(
  pointer: ReachableUnlearnedReportPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // Fetch all templates (paginated, up to 500)
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  // Fetch recent traces
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  // Build shape → templates map and best alpha per shape
  const shapeToTemplates = new Map<string, string[]>();
  const shapeToAlpha = new Map<string, number>();
  for (const tpl of templates) {
    for (const s of (tpl.output_shapes ?? [])) {
      if (!shapeToTemplates.has(s)) shapeToTemplates.set(s, []);
      shapeToTemplates.get(s)!.push(tpl.id);
      const existing = shapeToAlpha.get(s) ?? 0;
      shapeToAlpha.set(s, Math.max(existing, tpl.thompson_alpha ?? 1));
    }
  }

  // Learned shapes (≥1 trace)
  const learnedShapes = new Set<string>();
  for (const tr of traces) {
    for (const s of (tr.output_shapes ?? [])) learnedShapes.add(s);
  }

  // Reachable+Unlearned: advertised but no traces
  const advertisedShapes = Array.from(shapeToTemplates.keys());
  const unlearnedShapes = advertisedShapes.filter(s => !learnedShapes.has(s));

  const total = advertisedShapes.length || 1; // avoid division by zero

  const entries = unlearnedShapes.map(shape => {
    const producing = shapeToTemplates.get(shape) ?? [];
    // priority: more advertising vessels / more total shapes = higher
    // v1: approximate advertising_vessels = ["activity-api"] for all
    const priority = 1 / total;
    // best_template_id: highest thompson_alpha among producers
    let bestId = producing[0] ?? "";
    let bestAlpha = 0;
    for (const tplId of producing) {
      const tpl = templates.find(t => t.id === tplId);
      if (tpl && (tpl.thompson_alpha ?? 1) > bestAlpha) {
        bestAlpha = tpl.thompson_alpha ?? 1;
        bestId = tplId;
      }
    }
    return {
      shape,
      advertising_vessels: ["activity-api"],
      producing_templates: producing,
      best_template_id: bestId,
      priority: Math.round(priority * 1000) / 1000,
    };
  }).sort((a, b) => b.priority - a.priority);

  const topEntry = entries[0];

  return {
    shape: "reachableButUnlearnedReport",
    body: {
      generated_at: new Date().toISOString(),
      snapshot_id: `snapshot-${Date.now()}`,
      entries,
      total: entries.length,
      // Convenience fields so downstream tasks can access the top entry without
      // array-index path traversal (json_path_extract doesn't support [N] syntax).
      top_template_id: topEntry?.best_template_id ?? null,
      top_shape: topEntry?.shape ?? null,
    },
  };
}
