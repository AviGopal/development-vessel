import { METABOB_ENDPOINT, METABOB_API_KEY, DISCOVERY_ENDPOINT } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface LearnedTopologySnapshotPointer {
  type: "learned_topology_snapshot";
  lookback_window_seconds?: number;
}

interface Template {
  id: string;
  output_shapes?: string[];
  input_shapes?: string[];
  thompson_alpha?: number;
}

interface TraceRow {
  output_shapes?: string[];
  output_impulse_shapes?: string[];
  input_shapes?: string[];
  input_impulse_shapes?: string[];
  activity_template_id?: string;
  activity_id?: string;
  created_at?: string;
}

export async function resolveLearnedTopologySnapshot(
  pointer: LearnedTopologySnapshotPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // — 1. Fetch all templates (paginated, up to 500) —
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  let keepFetching = true;
  while (keepFetching) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[]; total?: number };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize || templates.length >= 500) keepFetching = false;
  }

  // — 2. Fetch recent traces (up to 200) for learned-shape counts —
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  // — 3. Discovery registry stats (best-effort; doesn't require auth on stats endpoint) —
  let discoveryStats: Record<string, unknown> = {};
  try {
    const dsRes = await fetch(`${DISCOVERY_ENDPOINT}/registry/stats`, { headers: auth });
    if (dsRes.ok) discoveryStats = await dsRes.json() as Record<string, unknown>;
  } catch { /* non-critical */ }

  // — 4. Build advertised_shapes: output_shapes from templates —
  const shapeToTemplates = new Map<string, string[]>();  // shape → [templateId]
  const shapeToAlpha = new Map<string, number>();        // shape → best alpha

  for (const tpl of templates) {
    const id = tpl.id ?? "";
    for (const s of (tpl.output_shapes ?? [])) {
      if (!shapeToTemplates.has(s)) shapeToTemplates.set(s, []);
      shapeToTemplates.get(s)!.push(id);
      const existing = shapeToAlpha.get(s) ?? 0;
      shapeToAlpha.set(s, Math.max(existing, tpl.thompson_alpha ?? 1));
    }
  }

  const advertised_shapes = Array.from(shapeToTemplates.entries()).map(([shape, producing]) => ({
    shape,
    advertising_vessels: ["activity-api"],   // v1: all templates are hosted in activity-api
    producing_templates: producing,
  }));

  // — 5. Trace counts per shape (learned = shape appears in a trace's output shapes) —
  // output_impulse_shapes is the canonical field (activity-api); output_shapes is the legacy alias
  const trace_counts: Record<string, number> = {};
  for (const tr of traces) {
    const shapes = tr.output_impulse_shapes ?? tr.output_shapes ?? [];
    for (const s of shapes) {
      trace_counts[s] = (trace_counts[s] ?? 0) + 1;
    }
  }

  // — 6. Composition edges: pair templates where A.output_shapes ∩ B.input_shapes ≠ ∅ —
  //    traversal_count > 0 iff we see both A and B in traces with shape S flowing between them
  const composition_edges: Array<{
    from_activity: string;
    via_shape: string;
    to_activity: string;
    traversal_count: number;
  }> = [];

  // Build a quick lookup: input_shape → templates that consume it
  const inputShapeToTemplates = new Map<string, string[]>();
  for (const tpl of templates) {
    for (const s of (tpl.input_shapes ?? [])) {
      if (!inputShapeToTemplates.has(s)) inputShapeToTemplates.set(s, []);
      inputShapeToTemplates.get(s)!.push(tpl.id);
    }
  }

  // Pair each producer–shape–consumer combination
  // v1: traversal_count = 1 if we see both templates in traces within the window, 0 otherwise
  const tracedTemplateIds = new Set(traces.map(t => t.activity_template_id ?? t.activity_id ?? "").filter(Boolean));

  const edgeSet = new Set<string>(); // dedup
  for (const tpl of templates) {
    for (const s of (tpl.output_shapes ?? [])) {
      const consumers = inputShapeToTemplates.get(s) ?? [];
      for (const consumerId of consumers) {
        if (consumerId === tpl.id) continue; // skip self-loops
        const key = `${tpl.id}|${s}|${consumerId}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        // v1 traversal: both endpoints traced AND shape appears in source's trace output_shapes
        const traversed = tracedTemplateIds.has(tpl.id) && tracedTemplateIds.has(consumerId);
        composition_edges.push({
          from_activity: tpl.id,
          via_shape: s,
          to_activity: consumerId,
          traversal_count: traversed ? 1 : 0,
        });
      }
    }
  }

  const untraversed_edges = composition_edges
    .filter(e => e.traversal_count === 0)
    .map(({ from_activity, via_shape, to_activity }) => ({ from_activity, via_shape, to_activity }));

  // — 7. 4-cell counts —
  const advertisedShapeSet = new Set(shapeToTemplates.keys());
  const learnedShapeSet = new Set(Object.keys(trace_counts).filter(s => (trace_counts[s] ?? 0) > 0));

  const reachable_learned = [...advertisedShapeSet].filter(s => learnedShapeSet.has(s)).length;
  const reachable_unlearned = [...advertisedShapeSet].filter(s => !learnedShapeSet.has(s)).length;
  // unknown = shapes in traces that aren't in templates (appeared in execution but not registered)
  const unknown_shapes_in_traces = [...learnedShapeSet].filter(s => !advertisedShapeSet.has(s));
  const unreachable_but_known = 0;   // v1: not distinguished from unknown
  const unknown = unknown_shapes_in_traces.length + Number(discoveryStats["totalShapes"] ?? 0) - advertisedShapeSet.size;

  return {
    shape: "learnedTopologySnapshot",
    body: {
      generated_at: new Date().toISOString(),
      lookback_window_seconds: lookbackSecs,
      advertised_shapes,
      trace_counts,
      composition_edges,
      untraversed_edges,
      counts: {
        reachable_learned,
        reachable_unlearned,
        unreachable_but_known,
        unknown: Math.max(0, unknown),
      },
    },
  };
}
