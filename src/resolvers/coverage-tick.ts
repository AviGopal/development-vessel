import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { META_TEMPLATE_IDS, normalizeTemplateId, isMetaTemplate } from "../lib/meta-templates.js";
import type { ResolverResult } from "./types.js";

export interface CoverageTickPointer {
  type: "coverage_tick";
  // Number of windows to compare (default 4, each 1 hour apart)
  num_windows?: number;
  // Size of each window in seconds (default 3600 = 1 hour)
  window_size_seconds?: number;
}

interface Template {
  id: string;
  output_shapes?: string[];
  created_at?: string;
}

interface TraceRow {
  activity_id?: string;
  variant_id?: string;
  /** Activity-api stores actual produced shapes as output_impulse_shapes
   *  (populated by ias-executor-ts trace-sink from real impulse metadata).
   *  This is the ground-truth field post extras-bag Phase 2 fix. */
  output_impulse_shapes?: string[];
  /** Legacy fallback — older traces may have output_shapes; prefer output_impulse_shapes. */
  output_shapes?: string[];
  executed_at?: string;
  created_at?: string;
}

interface CellCounts {
  // Window covers [since, until). until is the newer boundary.
  since: string;
  until: string;
  /** @deprecated kept for backward compat; equals `until` for newest-aligned semantics */
  timestamp: string;
  reachable_learned: number;
  reachable_unlearned: number;
  unknown: number;
  new_shapes_introduced: number;
  trace_count: number;
}

// Meta-activity templates that perform execution bookkeeping rather than substrate
// learning. Their executions dominate the trace corpus (~85% per investigation-048
// F-118) but don't represent topology discovery. Excluded from learned-shape counts
// to keep the coverage signal substantive rather than gameable by trace volume.
// Source of truth: src/lib/meta-templates.ts (also used by phantom_trace_scan and
// trace_failure_pattern_report).
const isMetaActivity = isMetaTemplate;

async function computeCountsForWindow(
  since: string,
  until: string,
  auth: Record<string, string>,
  allTemplates: Template[],
  templateShapes: Map<string, string[]>,
  advertisedShapes: Set<string>,
): Promise<{ counts: CellCounts; learnedSet: Set<string> }> {
  const traces: TraceRow[] = [];
  // Fetch a generous slice (limit=2000 ≈ 6h of activity) anchored at `since`,
  // then apply a client-side [since, until) filter. The server-side start_date
  // filter is unreliable for SurrealDB datetime types so we rely on the
  // client-side ISO-string comparison.
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?start_date=${encodeURIComponent(since)}&limit=2000`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    const all = trData.traces ?? trData.executions ?? [];
    const filtered = all.filter(tr => {
      const ts = tr.executed_at ?? tr.created_at;
      if (ts === undefined) return false;
      // [since, until) — half-open interval. Lexicographic compare on ISO-8601.
      return ts >= since && ts < until;
    });
    traces.push(...filtered);
  }

  // Collect learned shapes from THIS window's traces only — non-overlapping by design.
  // Exclude meta-activity executions from the learned-shape set: their output shapes
  // (validationResult, slotBinding, etc.) reflect execution bookkeeping, not topology
  // discovery. Traces from meta activities still count for trace_count so the
  // dominance pattern remains visible.
  const learnedShapes = new Set<string>();
  let substantiveTraces = 0;
  for (const tr of traces) {
    const actId = tr.activity_id ?? tr.variant_id ?? "";
    if (isMetaActivity(actId)) continue;
    substantiveTraces++;
    // Prefer output_impulse_shapes (actual shapes from impulse metadata,
    // populated by ias-executor-ts trace-sink post extras-bag Phase 2 fix).
    // Fall back to legacy output_shapes, then infer from template declarations.
    const actualShapes = tr.output_impulse_shapes?.length
      ? tr.output_impulse_shapes
      : tr.output_shapes?.length
        ? tr.output_shapes
        : null;
    if (actualShapes && actualShapes.length > 0) {
      for (const s of actualShapes) learnedShapes.add(s);
    } else {
      const inferredShapes = templateShapes.get(actId);
      if (inferredShapes) {
        for (const s of inferredShapes) learnedShapes.add(s);
      }
    }
  }

  const reachable_learned = [...advertisedShapes].filter(s => learnedShapes.has(s)).length;
  const reachable_unlearned = [...advertisedShapes].filter(s => !learnedShapes.has(s)).length;
  const unknown = [...learnedShapes].filter(s => !advertisedShapes.has(s)).length;

  return {
    counts: {
      since,
      until,
      timestamp: until,
      reachable_learned,
      reachable_unlearned,
      unknown,
      new_shapes_introduced: 0, // populated after all windows computed
      trace_count: substantiveTraces,
    },
    learnedSet: learnedShapes,
  };
}

export async function resolveCoverageTick(
  pointer: CoverageTickPointer,
): Promise<ResolverResult> {
  const numWindows = pointer.num_windows ?? 4;
  const windowSize = pointer.window_size_seconds ?? 3600;
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // Fetch all templates once (they don't change across windows)
  const allTemplates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  while (allTemplates.length < 500) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[] };
    const rows = page.templates ?? [];
    allTemplates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  // Build template-id → output_shapes lookup, excluding meta-activity templates
  // from the advertised-shapes set so they don't inflate reachable_unlearned either.
  const templateShapes = new Map<string, string[]>();
  const advertisedShapes = new Set<string>();
  for (const tpl of allTemplates) {
    if (!tpl.output_shapes || tpl.output_shapes.length === 0) continue;
    const rawId = tpl.id ?? "";
    const cleanId = normalizeTemplateId(rawId);
    templateShapes.set(cleanId, tpl.output_shapes);
    if (cleanId !== rawId) templateShapes.set(rawId, tpl.output_shapes);
    if (isMetaActivity(rawId)) continue;
    for (const s of tpl.output_shapes) advertisedShapes.add(s);
  }

  // Non-overlapping rolling windows.
  // cells_over_time[0] = newest = [now - 1h, now)
  // cells_over_time[i] = [now - (i+1)*windowSize, now - i*windowSize)
  // cells_over_time[N-1] = oldest
  //
  // Each window is INDEPENDENT — its reachable_learned counts shapes seen in
  // traces during that specific hour slice, not cumulatively. This fixes the
  // structural guarantee bug from investigation-048 F-123/F-119 where cumulative
  // windows trivially satisfied "reachable_learned strictly increasing" whenever
  // ANY traces existed.
  const now = Date.now();
  const cells_over_time: CellCounts[] = [];
  const learnedSetsByIndex: Array<Set<string>> = [];
  for (let i = 0; i < numWindows; i++) {
    const since = new Date(now - (i + 1) * windowSize * 1000).toISOString();
    const until = new Date(now - i * windowSize * 1000).toISOString();
    const { counts, learnedSet } = await computeCountsForWindow(
      since,
      until,
      auth,
      allTemplates,
      templateShapes,
      advertisedShapes,
    );
    cells_over_time.push(counts);
    learnedSetsByIndex.push(learnedSet);
  }

  // Compute new_shapes_introduced[i]: shapes first seen in window[i] (working
  // from oldest to newest, so a shape first encountered in window[N-1] counts
  // as "introduced" there; if it reappears in newer windows it does NOT count
  // there). This is the substantive learning signal.
  const cumulativeSeen = new Set<string>();
  for (let i = cells_over_time.length - 1; i >= 0; i--) {
    let intro = 0;
    for (const s of learnedSetsByIndex[i]!) {
      if (!cumulativeSeen.has(s)) {
        intro++;
        cumulativeSeen.add(s);
      }
    }
    cells_over_time[i]!.new_shapes_introduced = intro;
  }

  // Cumulative learned set: union of all windows' learned shapes (substantive
  // templates only). This is the total topology coverage observed over the
  // full lookback period.
  const total_learned_unique = cumulativeSeen.size;
  const total_unlearned_unique = [...advertisedShapes].filter(s => !cumulativeSeen.has(s)).length;
  const total_advertised = advertisedShapes.size;
  const coverage_fraction = total_advertised > 0
    ? Math.round((total_learned_unique / total_advertised) * 1000) / 1000
    : 0;

  // coverage_progress: the substrate must be DISCOVERING new shapes in recent
  // windows, not just executing meta-activity churn.
  //
  // Definition: at least one of the most-recent ⌈numWindows/2⌉ windows introduced
  // a new shape (not seen in any older window). This requires real topology
  // discovery, not just trace volume. Idle windows (no executions) do not
  // satisfy progress.
  const recentHalf = Math.max(1, Math.ceil(numWindows / 2));
  const recent_new_shapes_total = cells_over_time
    .slice(0, recentHalf)
    .reduce((acc, c) => acc + c.new_shapes_introduced, 0);
  const coverage_progress = recent_new_shapes_total > 0;

  // Count of consecutive newest-end non-overlapping rolling windows where at
  // least one new shape was introduced. Counts windows, NOT boredom firing
  // cycles — capped at num_windows. Audit F-128 (inv-053, inv-055): the
  // legacy field name `consecutive_progressing_cycles` was misleading
  // because "cycle" implied "boredom tick" rather than "rolling window."
  // The new field name `consecutive_windows_with_new_shapes` makes the
  // semantic explicit. The legacy field is preserved as an alias for
  // backward compatibility (existing consumers like health-tick read it).
  let consecutive_windows_with_new_shapes = 0;
  for (let i = 0; i < cells_over_time.length; i++) {
    if (cells_over_time[i]!.new_shapes_introduced > 0) consecutive_windows_with_new_shapes++;
    else break;
  }
  const consecutive_progressing_cycles = consecutive_windows_with_new_shapes; // legacy alias

  // Legacy monotonic flags retained for downstream consumers. With non-overlapping
  // windows these no longer have the structural-true bias of the previous design.
  let reachable_learned_strictly_increasing = cells_over_time.length >= 2;
  let reachable_unlearned_strictly_decreasing = cells_over_time.length >= 2;
  let unknown_strictly_decreasing = cells_over_time.length >= 2;
  for (let i = 1; i < cells_over_time.length; i++) {
    const prev = cells_over_time[i - 1]!; // newer
    const curr = cells_over_time[i]!;     // older
    if (curr.reachable_learned <= prev.reachable_learned) reachable_learned_strictly_increasing = false;
    if (curr.reachable_unlearned >= prev.reachable_unlearned) reachable_unlearned_strictly_decreasing = false;
    if (curr.unknown >= prev.unknown) unknown_strictly_decreasing = false;
  }

  return {
    shape: "coverageReport",
    body: {
      generated_at: new Date().toISOString(),
      window_design: "non_overlapping_rolling_v2",
      cells_over_time,
      monotonic_progress: {
        reachable_learned_strictly_increasing,
        reachable_unlearned_strictly_decreasing,
        unknown_strictly_decreasing,
      },
      consecutive_windows_with_new_shapes,
      consecutive_progressing_cycles,  // legacy alias (audit F-128); same value, retained for backward compat
      consecutive_windows_max: numWindows,  // upper bound — count caps here when every window contributes
      coverage_progress,
      // New substantive metrics — robust to trace-volume gaming:
      total_advertised_shapes: total_advertised,
      total_learned_unique,
      total_unlearned_unique,
      coverage_fraction,
      recent_new_shapes_introduced: recent_new_shapes_total,
      meta_activities_excluded: [...META_TEMPLATE_IDS],
    },
  };
}
