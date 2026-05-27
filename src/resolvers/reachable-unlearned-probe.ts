import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";

export interface ReachableUnlearnedProbePointer {
  type: "reachable_unlearned_probe";
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

/**
 * Combined probe resolver: gets the reachable-but-unlearned report, picks the
 * top unlearned shape's best producer, and dispatches it via goal-host-vessel
 * — closing the recommend→execute loop in a single resolver call.
 *
 * Replaces the 3-task probe-reachable-unlearned template that tried to use
 * {{get_report_top_template_id}} substitution inside an http_fetch body.
 * The ias-executor-ts engine does not interpolate {{}} in task configs for
 * non-llm resolvers, so the body was sent verbatim to goal-host.
 */
export async function resolveReachableUnlearnedProbe(
  pointer: ReachableUnlearnedProbePointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // ── 1. Fetch templates ────────────────────────────────────────────────────
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`,
      { headers: auth },
    );
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  // ── 2. Fetch recent traces ─────────────────────────────────────────────────
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  // ── 3. Identify unlearned shapes ──────────────────────────────────────────
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

  const learnedShapes = new Set<string>();
  for (const tr of traces) {
    for (const s of (tr.output_shapes ?? [])) learnedShapes.add(s);
  }

  const unlearnedShapes = Array.from(shapeToTemplates.keys()).filter(
    (s) => !learnedShapes.has(s),
  );

  if (unlearnedShapes.length === 0) {
    return {
      shape: "reachableUnlearnedReport",
      body: {
        generated_at: new Date().toISOString(),
        dispatched: false,
        reason: "no_unlearned_shapes",
        unlearned_count: 0,
        top_template_id: null,
        top_shape: null,
      },
    };
  }

  // ── 4. Pick the top unlearned shape and its best producer ─────────────────
  const total = Array.from(shapeToTemplates.keys()).length || 1;
  const topEntry = unlearnedShapes
    .map((shape) => {
      const producing = shapeToTemplates.get(shape) ?? [];
      let bestId = producing[0] ?? "";
      let bestAlpha = 0;
      for (const tplId of producing) {
        const tpl = templates.find((t) => t.id === tplId);
        if (tpl && (tpl.thompson_alpha ?? 1) > bestAlpha) {
          bestAlpha = tpl.thompson_alpha ?? 1;
          bestId = tplId;
        }
      }
      return { shape, best_template_id: bestId, priority: 1 / total };
    })
    .sort((a, b) => b.priority - a.priority)[0]!;

  if (!topEntry.best_template_id) {
    return {
      shape: "reachableUnlearnedReport",
      body: {
        generated_at: new Date().toISOString(),
        dispatched: false,
        reason: "no_producer_for_top_shape",
        unlearned_count: unlearnedShapes.length,
        top_template_id: null,
        top_shape: topEntry.shape,
      },
    };
  }

  // ── 5. Dispatch to goal-host-vessel ───────────────────────────────────────
  let dispatchResult: { dispatchId?: string; executionId?: string; error?: string } = {};
  let dispatchOk = false;
  try {
    const dispatchRes = await fetch(`${GOAL_HOST_ENDPOINT}/run-goal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        goal: `execute the top unlearned template to produce shape ${topEntry.shape}`,
        targetTemplateId: topEntry.best_template_id,
        tags: ["intent:topology_discovery", "intent:probe_dispatch"],
        variables: { source: "reachable-unlearned-probe" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    dispatchResult = (await dispatchRes.json()) as typeof dispatchResult;
    dispatchOk = dispatchRes.ok && !dispatchResult.error;
  } catch (err) {
    dispatchResult = { error: (err as Error).message };
  }

  return {
    shape: "reachableUnlearnedReport",
    body: {
      generated_at: new Date().toISOString(),
      dispatched: dispatchOk,
      unlearned_count: unlearnedShapes.length,
      top_template_id: topEntry.best_template_id,
      top_shape: topEntry.shape,
      dispatch_id: dispatchResult.dispatchId ?? null,
      dispatch_execution_id: dispatchResult.executionId ?? null,
      dispatch_error: dispatchResult.error ?? null,
    },
  };
}
