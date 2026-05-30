import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ReachableUnlearnedReportPointer {
  type: "reachable_unlearned_report";
  lookback_window_seconds?: number;
  /** Floor for "needs more executions" reporting. Templates with total
   *  lifetime executions < confidence_floor are included in below_confidence_floor.
   *  Matches substrate-health-tick's default (10). */
  confidence_floor?: number;
}

interface Template {
  id: string;
  output_shapes?: string[];
  input_shapes?: string[];
  thompson_alpha?: number;
  proposed?: boolean;
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
  const confidenceFloor = pointer.confidence_floor ?? 10;
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

  // Fetch real posteriors from variant_performance_metrics (VPM).
  // The template API's thompson_alpha is unreliable (stale proposed/Redis cache keeps
  // all templates at α=1). VPM has the actual accumulated evidence.
  // success_rate = (α-1)/(α+β-2) for templates with at least 1 real execution.
  const vpmMap = new Map<string, { alpha: number; beta: number; executions: number }>();
  try {
    const vpmRes = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates/auto-promote?dry_run=true`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ min_samples: 0, min_success_rate: 0, dry_run: true }),
    });
    if (vpmRes.ok) {
      const vpmData = await vpmRes.json() as {
        promoted?: Array<{ template_id?: string; thompson_alpha?: number; thompson_beta?: number; total_executions?: number }>;
        skipped?: Array<{ template_id?: string; thompson_alpha?: number; thompson_beta?: number; total_executions?: number }>;
      };
      for (const entry of [...(vpmData.promoted ?? []), ...(vpmData.skipped ?? [])]) {
        const id = entry.template_id;
        if (id) {
          vpmMap.set(id, {
            alpha: entry.thompson_alpha ?? 1,
            beta: entry.thompson_beta ?? 1,
            executions: entry.total_executions ?? 0,
          });
        }
      }
    }
  } catch { /* fallback to execution counts */ }

  // Count ALL-TIME executions per template. The 24h wide window covers recent
  // activity; for confidence-floor purposes we need lifetime counts. Fetch a
  // larger slice (30-day) and count per activity_id.
  const allTimeSince = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const allTimeExecCounts = new Map<string, number>(); // normalizedId → count
  let allTimeOffset = 0;
  while (allTimeOffset < 5000) {
    const r = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=200&offset=${allTimeOffset}&since_iso=${encodeURIComponent(allTimeSince)}`,
      { headers: auth },
    ).catch(() => null);
    if (!r?.ok) break;
    const page = await r.json() as { executions?: TraceRow[] };
    const rows = page.executions ?? [];
    if (rows.length === 0) break;
    for (const tr of rows) {
      const id = tr.activity_id ?? tr.variant_id;
      if (!id) continue;
      const norm = normalizeTemplateId(id);
      allTimeExecCounts.set(norm, (allTimeExecCounts.get(norm) ?? 0) + 1);
      allTimeExecCounts.set(id, (allTimeExecCounts.get(id) ?? 0) + 1);
    }
    allTimeOffset += rows.length;
    if (rows.length < 200) break;
  }

  // Only consider ACTIVE templates for coverage dispatch:
  // - Not proposed (proposed=true means awaiting validation)
  // - Not a substrate-authored gap-closing template (id starts with "gap-closing:")
  //   These templates may use hallucinated resolvers (activity_fetch, gpt-4) even when
  //   proposed=false; they are TARGETS of the promotion pipeline, not sources for
  //   coverage discovery. The proposed=false state just means they survived an auto-promote
  //   cycle, not that they're actually executable in the current substrate.
  const normId = (id: string) => id.replace(/^activity:⟨(.+)⟩$/, "$1");

  // Build the set of shapes that have ACTUALLY BEEN PRODUCED in the 30-day trace window.
  // "Advertised" is not enough — a shape might be declared as an output but its producer
  // template has never successfully run in this substrate (e.g. test_audit_report is
  // declared by audit-test templates that aren't part of the normal execution graph).
  // Using historically-produced shapes as the gate ensures we only dispatch templates
  // whose inputs have been seen in real execution traces.
  const allTimeProducedShapes = new Set<string>();
  for (const tr of traces) { // short-window traces
    for (const s of (tr.output_shapes ?? [])) allTimeProducedShapes.add(s);
  }
  // Also fetch wider 30-day produced shapes from the same paginated traces we already
  // counted above — reuse allTimeExecCounts data source but track shapes too.
  // We approximate: any shape in the wide-window exec traces' output_shapes is "produced".
  // The wide fetch is the allTimeExecCounts loop above (rows have output_shapes).
  // Re-iterate allTimeOffset data isn't available, so use a separate dedicated fetch.
  try {
    const shapeRes = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=500&since_iso=${encodeURIComponent(allTimeSince)}`,
      { headers: auth },
    ).catch(() => null);
    if (shapeRes?.ok) {
      const shapeData = await shapeRes.json() as { executions?: TraceRow[] };
      for (const tr of shapeData.executions ?? []) {
        for (const s of (tr.output_shapes ?? [])) allTimeProducedShapes.add(s);
      }
    }
  } catch { /* fallback: allTimeProducedShapes stays small */ }

  // Unconditionally available shapes: shapes with no input requirements (always producible
  // without context) are always satisfiable regardless of history.
  const NO_INPUT_SHAPES_SENTINEL = new Set<string>(["*"]);

  const activeTemplates = templates.filter(t => {
    if (t.proposed) return false;
    const cleanId = normId(t.id);
    if (cleanId.startsWith("gap-closing:")) return false;
    if (cleanId.startsWith("variant-")) return false; // anonymous test artifacts
    // Input-availability gate: a template is dispatchable only if ALL its required
    // inputShapes have been produced at least once in the last 30 days. This prevents
    // the observer from repeatedly dispatching templates like debug-failing-audit whose
    // required context (test_audit_report, test_registration) has never materialized
    // in this substrate's execution history.
    const inputs = t.input_shapes ?? [];
    if (inputs.length > 0) {
      const unproduced = inputs.filter(s => !allTimeProducedShapes.has(s));
      if (unproduced.length > 0) return false;
    }
    return true;
  });

  // Build shape → templates map and best alpha per shape
  const shapeToTemplates = new Map<string, string[]>();
  const shapeToAlpha = new Map<string, number>();
  for (const tpl of activeTemplates) {
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

  // Below-confidence-floor templates: have been tried but not enough times.
  // alpha + beta = total_executions + 2. Floor requires alpha + beta >= confidenceFloor.
  // So: total_executions < confidenceFloor - 2.
  const execsNeeded = Math.max(0, confidenceFloor - 2);
  const belowFloor = templates
    .filter(tpl => !tpl.id.includes("gap-closing:") && !tpl.id.includes("variant-")) // exclude substrate-authored
    .map(tpl => {
      const norm = normalizeTemplateId(tpl.id);
      const count = allTimeExecCounts.get(norm) ?? allTimeExecCounts.get(tpl.id) ?? 0;
      return { template_id: tpl.id, total_executions: count, runs_needed: Math.max(0, execsNeeded - count) };
    })
    .filter(e => e.total_executions > 0 && e.runs_needed > 0)
    .sort((a, b) => a.runs_needed - b.runs_needed); // fewest needed first = cheapest fix

  // Reachable+Unlearned: advertised but no traces
  const advertisedShapes = Array.from(shapeToTemplates.keys());
  const unlearnedShapes = advertisedShapes.filter(s => !learnedShapes.has(s));

  const total = advertisedShapes.length || 1; // avoid division by zero

  const entries = unlearnedShapes.map(shape => {
    const producing = shapeToTemplates.get(shape) ?? [];
    // best_template_id: use real posteriors from variant_performance_metrics.
    // Prefer templates with a positive success rate over brand-new or all-fail ones.
    // This prevents the observer from repeatedly dispatching templates that consistently
    // fail (like repair-failed-activity which needs specific inputs not provided here).
    //
    // Score = empirical mean (α-1)/(α+β-2) when executions > 0, else 0.5 (uniform prior).
    // Ties broken by fewer total executions (less-tested templates get priority to build priors).
    let bestId = producing[0] ?? "";
    let bestScore = -Infinity;
    for (const tplId of producing) {
      const norm = normalizeTemplateId(tplId);
      const vpm = vpmMap.get(norm) ?? vpmMap.get(tplId);
      let score: number;
      if (vpm && vpm.executions > 0) {
        // Pure Thompson success rate: α/(α+β). This favours templates that
        // actually succeed. The secondary +executions*0.0001 breaks ties in
        // favour of MORE executions (more evidence = more confidence) — the
        // opposite of the earlier formulation which wrongly favoured fewer execs.
        score = vpm.alpha / (vpm.alpha + vpm.beta) + vpm.executions * 0.0001;
      } else {
        score = 0.5; // uniform prior for never-tried templates
      }
      if (score > bestScore) {
        bestScore = score;
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
      // Below-confidence-floor templates: have executions but fewer than the
      // health-tick's confidence floor (confidenceFloor - 2 real executions needed).
      // These are the templates the substrate should run more to pass confidence_passing.
      // Sorted cheapest-to-fix first so callers can dispatch the top N.
      below_confidence_floor: belowFloor,
      below_confidence_floor_count: belowFloor.length,
      confidence_floor: confidenceFloor,
      executions_needed_for_floor: execsNeeded,
      // Top pick: template that needs fewest additional runs to cross floor.
      top_below_floor_template_id: belowFloor[0]?.template_id ?? null,
      top_below_floor_runs_needed: belowFloor[0]?.runs_needed ?? 0,
    },
  };
}
