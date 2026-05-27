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
  activity_id?: string;
  variant_id?: string;
  executed_at?: string;
  created_at?: string;
}

function normalizeTemplateId(rawId: string): string {
  return rawId.replace(/^activity:⟨(.+)⟩$/, "$1");
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

  // Fetch traces from the lookback window (for "learned" classification) AND a
  // wider window (for rotation freshness). Without the wider window, every
  // probe cycle selects the same #1 producer because tied priorities resolve by
  // iteration order — observed live: 3 consecutive observer dispatches all to
  // release-change. Wider window = 24h, sufficient to capture which producers
  // have been recently exercised even when their output didn't land in 1h.
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  const wideSince = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const lastExecByTemplate = new Map<string, number>(); // template id → ms epoch
  const wideRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(wideSince)}&limit=500`,
    { headers: auth },
  );
  if (wideRes.ok) {
    const wideData = await wideRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    const wideTraces = wideData.traces ?? wideData.executions ?? [];
    for (const tr of wideTraces) {
      const actId = tr.activity_id ?? tr.variant_id;
      const tsStr = tr.executed_at ?? tr.created_at;
      if (!actId || !tsStr) continue;
      const ts = Date.parse(tsStr);
      if (!Number.isFinite(ts)) continue;
      const norm = normalizeTemplateId(actId);
      const existing = lastExecByTemplate.get(norm) ?? 0;
      if (ts > existing) lastExecByTemplate.set(norm, ts);
      const existingRaw = lastExecByTemplate.get(actId) ?? 0;
      if (ts > existingRaw) lastExecByTemplate.set(actId, ts);
    }
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
    // best_template_id: highest thompson_alpha among producers (unchanged)
    let bestId = producing[0] ?? "";
    let bestAlpha = 0;
    for (const tplId of producing) {
      const tpl = templates.find(t => t.id === tplId);
      if (tpl && (tpl.thompson_alpha ?? 1) > bestAlpha) {
        bestAlpha = tpl.thompson_alpha ?? 1;
        bestId = tplId;
      }
    }
    // Rotation: when priority would tie (it always does in v1, all = 1/total),
    // prefer producers that haven't been exercised recently. We compute the
    // last-execution timestamp of the best producer and surface it; the sort
    // below uses it as a secondary key so older = higher priority.
    const bestLastExecMs = bestId
      ? (lastExecByTemplate.get(bestId) ?? lastExecByTemplate.get(normalizeTemplateId(bestId)) ?? 0)
      : 0;
    const priority = 1 / total;
    return {
      shape,
      advertising_vessels: ["activity-api"],
      producing_templates: producing,
      best_template_id: bestId,
      priority: Math.round(priority * 1000) / 1000,
      best_template_last_executed_ms: bestLastExecMs,
    };
  }).sort((a, b) => {
    // Primary: higher priority first (currently always tied at 1/total)
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Rotation key: producer not exercised recently wins (smaller ms first).
    // Producers never exercised (ms=0) sort first — they're the most-stale.
    // Among ties on ms, fall back to shape name for deterministic order.
    if (a.best_template_last_executed_ms !== b.best_template_last_executed_ms) {
      return a.best_template_last_executed_ms - b.best_template_last_executed_ms;
    }
    return a.shape.localeCompare(b.shape);
  });

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
      top_template_last_executed_ms: topEntry?.best_template_last_executed_ms ?? 0,
      // Rotation evidence: producers exercised in last 24h (debug aid)
      producers_exercised_last_24h: lastExecByTemplate.size,
    },
  };
}
