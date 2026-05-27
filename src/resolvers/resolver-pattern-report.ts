import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ResolverPatternReportPointer {
  type: "resolver_pattern_report";
  /** How far back to look for traces (default 24h). */
  lookback_window_seconds?: number;
  /** Cap on aggregation result rows (default 200). */
  limit?: number;
  /** Minimum sample count to include a row in the report (default 1). */
  min_count?: number;
}

interface TemplateTaskRow {
  id?: string;
  resolver?: string;
  outputShapes?: string[];
  output_shapes?: string[];
}

interface TemplateRow {
  id?: string;
  tasks?: TemplateTaskRow[];
  output_shapes?: string[];
}

interface TraceRow {
  activity_id?: string;
  variant_id?: string;
  success?: boolean;
  status?: string;
  executed_at?: string;
  created_at?: string;
}

function normalizeId(rawId: string): string {
  return rawId.replace(/^activity:⟨(.+)⟩$/, "$1");
}

/**
 * resolver_pattern_report — trace-side aggregation for audit recommendation
 * inv-028 B. Records empirical success rates for `(resolver_id, output_shape)`
 * combinations across recent traces.
 *
 * Per audit investigation-028: the engine is tier-agnostic — `task.resolver_tier`
 * is recorded but never branches behavior, and there is no `(resolver_id,
 * shape_pair) → success_rate` table at runtime. This resolver provides the
 * aggregation entirely from existing trace + template data, with no engine
 * changes and no new shapes (the report itself is the new shape).
 *
 * The aggregation lets future template synthesis (ribosome, make-activity)
 * bias toward proven resolver/shape combinations rather than LLM-picked
 * defaults. Also makes the F-127 Thompson skew observable: if validator-dispatch
 * has 96% of traces but `(validator-dispatch, validationResult)` has a high
 * success rate while `(probe-X, X)` has a low one, the skew is data-supported
 * not just structural.
 *
 * Algorithm:
 *   1. Fetch templates (cap 500), build task-resolver-shape map per template.
 *   2. Fetch traces in lookback window.
 *   3. For each trace, for each task in its template:
 *      - For each output_shape in the task:
 *        - Key = (resolver_id, output_shape)
 *        - Increment count; if trace.success, increment success_count.
 *   4. Compute success_rate = success_count / count for each key.
 *   5. Sort by count desc; return up to `limit` rows with count >= min_count.
 */
export async function resolveResolverPatternReport(
  pointer: ResolverPatternReportPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 24 * 3600;
  const limit = pointer.limit ?? 200;
  const minCount = pointer.min_count ?? 1;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // ── 1. Templates ──────────────────────────────────────────────────────────
  const templates: TemplateRow[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`,
      { headers: auth },
    );
    if (!r.ok) break;
    const page = await r.json() as { templates?: TemplateRow[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  // Build template-id → list of (resolver, outputShapes)
  type TaskCell = { resolver: string; outputShapes: string[] };
  const templateTasksMap = new Map<string, TaskCell[]>();
  for (const tpl of templates) {
    const tasks = tpl.tasks ?? [];
    const cells: TaskCell[] = [];
    for (const t of tasks) {
      const resolver = t.resolver ?? "";
      const outputShapes = t.outputShapes ?? t.output_shapes ?? [];
      if (!resolver || outputShapes.length === 0) continue;
      cells.push({ resolver, outputShapes });
    }
    // If task-level outputShapes are absent (older templates), fall back
    // to template-level output_shapes shared across all tasks.
    if (cells.length === 0 && (tpl.output_shapes ?? []).length > 0 && tasks.length > 0) {
      for (const t of tasks) {
        const resolver = t.resolver ?? "";
        if (!resolver) continue;
        cells.push({ resolver, outputShapes: tpl.output_shapes ?? [] });
      }
    }
    if (cells.length === 0) continue;
    const id = normalizeId(tpl.id ?? "");
    templateTasksMap.set(id, cells);
    templateTasksMap.set(tpl.id ?? "", cells);
  }

  // ── 2. Traces ─────────────────────────────────────────────────────────────
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=2000`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  // Client-side filter on time (server-side filter may be unreliable for
  // SurrealDB datetime types; same pattern as coverage-tick).
  const filteredTraces = traces.filter((tr) => {
    const ts = tr.executed_at ?? tr.created_at;
    return ts !== undefined && ts >= since;
  });

  // ── 3. Aggregate ──────────────────────────────────────────────────────────
  // key: `${resolver}|${output_shape}`
  type Stats = { count: number; success_count: number };
  const stats = new Map<string, Stats>();

  for (const tr of filteredTraces) {
    const actId = tr.activity_id ?? tr.variant_id ?? "";
    if (!actId) continue;
    const cells = templateTasksMap.get(actId) ?? templateTasksMap.get(normalizeId(actId));
    if (!cells) continue;
    const isSuccess = tr.success === true || tr.status === "success" || tr.status === "completed";
    for (const cell of cells) {
      for (const shape of cell.outputShapes) {
        const key = `${cell.resolver}|${shape}`;
        const s = stats.get(key) ?? { count: 0, success_count: 0 };
        s.count++;
        if (isSuccess) s.success_count++;
        stats.set(key, s);
      }
    }
  }

  // ── 4. Build report ──────────────────────────────────────────────────────
  const rows = Array.from(stats.entries())
    .map(([key, s]) => {
      const sep = key.indexOf("|");
      const resolver_id = key.slice(0, sep);
      const output_shape = key.slice(sep + 1);
      return {
        resolver_id,
        output_shape,
        count: s.count,
        success_count: s.success_count,
        failure_count: s.count - s.success_count,
        success_rate: s.count > 0 ? Math.round((s.success_count / s.count) * 1000) / 1000 : 0,
      };
    })
    .filter((r) => r.count >= minCount)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.success_rate !== a.success_rate) return b.success_rate - a.success_rate;
      return a.resolver_id.localeCompare(b.resolver_id);
    })
    .slice(0, limit);

  // Summary metrics for downstream signals
  const total_observations = rows.reduce((acc, r) => acc + r.count, 0);
  const total_successes = rows.reduce((acc, r) => acc + r.success_count, 0);
  const overall_success_rate = total_observations > 0
    ? Math.round((total_successes / total_observations) * 1000) / 1000
    : 0;
  const unique_resolvers = new Set(rows.map((r) => r.resolver_id)).size;
  const unique_output_shapes = new Set(rows.map((r) => r.output_shape)).size;

  return {
    shape: "resolverPatternReport",
    body: {
      generated_at: new Date().toISOString(),
      lookback_window_seconds: lookbackSecs,
      rows,
      total_rows: rows.length,
      total_observations,
      total_successes,
      overall_success_rate,
      unique_resolvers,
      unique_output_shapes,
      traces_examined: filteredTraces.length,
      templates_indexed: templateTasksMap.size / 2, // we add both raw + normalized id
    },
  };
}
