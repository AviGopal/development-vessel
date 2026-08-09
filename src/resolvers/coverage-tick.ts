import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { META_TEMPLATE_IDS, normalizeTemplateId, isMetaTemplate } from "../lib/meta-templates.js";
import type { ResolverResult } from "./types.js";
import { fetchWithRetry } from "./http-retry.js";

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
  /**
   * Advertised shapes that only a TEMPLATE DECLARATION vouches for — no trace in this
   * window actually carried them. These used to be folded into reachable_learned, which
   * made a claim indistinguishable from a demonstration. A non-zero value is a worklist:
   * edges to go exercise, not coverage already earned.
   */
  reachable_declared_only: number;
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
  // BOUND THE WINDOW ON BOTH SIDES, AND PAGINATE.
  //
  // This asked for `start_date=<since>&limit=500` with no end_date, then filtered
  // client-side to [since, until). Three things go wrong at once and they compound:
  //   1. the server CLAMPS limit to 100 (the comment above claimed 500 ≈ 6h; it was
  //      neither 500 nor 2000);
  //   2. with no end_date the query is bounded on one side only;
  //   3. rows come back newest-first, so the 100 returned are the newest 100 overall.
  // For every window except the newest, the client-side filter then discards all 100.
  //
  // Measured against the live store: asking start_date=03:01 with limit=500 returned
  // 100 rows, ALL from 05:55-06:02, and ZERO inside [03:00,04:00) — while the same
  // request WITH end_date returns 300+ real traces in that hour. So the three older
  // windows reported trace_count=0 during hours in which a 48-goal harness and the
  // autonomous loop were both running.
  //
  // That is not merely an undercount. `new_shapes_introduced` counts shapes not seen
  // in any OLDER window, and `coverage_progress` is true when the recent half of the
  // windows introduced any. With the comparison windows structurally empty, every
  // shape in the newest window reads as new and coverage_progress is TRUE BY
  // CONSTRUCTION — and that flag is what the lift criterion (SUBSTRATE_AS_MDP §9.5)
  // gates on. A proof criterion resting on an empty comparison proves nothing.
  const PAGE = 100;                     // the server's real clamp, not the one we asked for
  const MAX_PAGES = 40;                 // 4k traces per window; beyond that the window is degenerate
  for (let page = 0; page < MAX_PAGES; page++) {
    const trRes = await fetchWithRetry(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces`
      + `?start_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(until)}`
      + `&limit=${PAGE}&offset=${page * PAGE}`,
      { headers: auth },
    );
    if (!trRes || !trRes.ok) break;
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    const all = trData.traces ?? trData.executions ?? [];
    // Keep the client-side [since, until) filter as a belt-and-braces check: it is now
    // redundant with end_date, and if it ever starts discarding rows again that is the
    // signal the server-side bounds have stopped working.
    for (const tr of all) {
      const ts = tr.executed_at ?? tr.created_at;
      if (ts === undefined) continue;
      if (ts >= since && ts < until) traces.push(tr);
    }
    if (all.length < PAGE) break;
  }

  // Collect learned shapes from THIS window's traces only — non-overlapping by design.
  // Exclude meta-activity executions from the learned-shape set: their output shapes
  // (validationResult, slotBinding, etc.) reflect execution bookkeeping, not topology
  // discovery. Traces from meta activities still count for trace_count so the
  // dominance pattern remains visible.
  const learnedShapes = new Set<string>();
  // Shapes only a TEMPLATE DECLARATION vouches for — no trace carried them. Tracked
  // separately so a claim can never be counted as a demonstration; see the note at the
  // inference branch below.
  const inferredOnlyShapes = new Set<string>();
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
      // DECLARED IS NOT DEMONSTRATED (2026-08-09).
      //
      // This used to add the TEMPLATE'S DECLARED output shapes to `learnedShapes`
      // whenever a trace carried no actual ones — laundering an advertisement into
      // evidence. A template that declares it produces X and has never once produced
      // X then counted as X being learned, which is precisely the blind spot that let
      // a maintenance edge sit "covered" through 36 dispatches and five stacked
      // defects while its target metric never moved.
      //
      // Kept as a SEPARATE count rather than discarded: the gap between demonstrated
      // and inferred is itself the useful signal — it is the set of shapes the fleet
      // claims but has not shown. Reporting them apart makes the claim auditable;
      // merging them made it unfalsifiable.
      const inferredShapes = templateShapes.get(actId);
      if (inferredShapes) {
        for (const s of inferredShapes) inferredOnlyShapes.add(s);
      }
    }
  }

  // A shape counts as learned only where a trace actually carried it.
  const reachable_learned = [...advertisedShapes].filter(s => learnedShapes.has(s)).length;
  const reachable_unlearned = [...advertisedShapes].filter(s => !learnedShapes.has(s)).length;
  const unknown = [...learnedShapes].filter(s => !advertisedShapes.has(s)).length;
  // Advertised, and claimed by some template's declaration, but never demonstrated in
  // a trace this window. A non-zero value here is a list of edges to go exercise.
  const reachable_declared_only = [...advertisedShapes]
    .filter(s => !learnedShapes.has(s) && inferredOnlyShapes.has(s)).length;

  return {
    counts: {
      since,
      until,
      timestamp: until,
      reachable_learned,
      reachable_unlearned,
      unknown,
      reachable_declared_only,
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
  // Fetch the FULL catalogue. Prior bug: the `< 500` cap plus `break` on the
  // first short page truncated this — the corpus is ~1500 and the templates
  // endpoint intermittently returns a short first page under load, so the
  // detector emitted (lift-gate) verdicts over a sliver of reality. Loop until
  // the endpoint-reported `total` is fetched or a page is empty; a short page
  // is NOT a stop signal.
  let templatesTotal = Infinity;
  for (let guard = 0; allTemplates.length < templatesTotal && guard < 100; guard++) {
    const r = await fetchWithRetry(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r || !r.ok) break;
    const page = await r.json() as { templates?: Template[]; total?: number };
    if (typeof page.total === "number") templatesTotal = page.total;
    const rows = page.templates ?? [];
    if (rows.length === 0) break;
    allTemplates.push(...rows);
    offset += rows.length;
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
  const total_advertised = advertisedShapes.size;
  // Coverage numerator must be the ADVERTISED shapes actually learned. The rest
  // of cumulativeSeen are "unknown" shapes outside the advertised set; counting
  // them pushed coverage_fraction > 1.0 (observed 1.65) — a meaningless
  // self-image that feeds the lift gate. Keep them as a separate breadth metric.
  const advertised_learned_unique = [...advertisedShapes].filter(s => cumulativeSeen.has(s)).length;
  const total_unlearned_unique = total_advertised - advertised_learned_unique;
  const unknown_shapes_learned = total_learned_unique - advertised_learned_unique;
  const coverage_fraction = total_advertised > 0
    ? Math.round((advertised_learned_unique / total_advertised) * 1000) / 1000
    : 0; // in [0,1]: fraction of ADVERTISED shapes learned

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
  // SUPPORT-REGION GUARD — a rate is not evidence when its comparison region is empty.
  //
  // `new_shapes_introduced` counts shapes absent from every OLDER window, so if those
  // windows hold no traces, EVERY shape in the newest window reads as new and
  // coverage_progress is true by construction. That is exactly what happened here: the
  // per-window query was bounded on one side only and clamped to 100 newest rows, so three
  // of four windows reported trace_count=0 during hours when a 48-goal harness and the
  // autonomous loop were both running, and the flag the lift criterion gates on
  // (SUBSTRATE_AS_MDP §9.5) could not fail. Fixed upstream; this is the guard that makes the
  // failure SELF-EVIDENT if it ever returns.
  //
  // Generalised, this is a TEMPORAL HORIZON in the sense of §8.4 — a region of its own state
  // the substrate cannot reach. §8.4 names three horizon classes (orphaned-shape, bridge,
  // tier-refinement), all in S x A, and the loop has detectors for each. It has none for the
  // regions of its own HISTORY it cannot see, which is why this class kept recurring: the same
  // shape appeared as an empty comparison window, a command-only cache read as pathway
  // diversity, an AND-matched recall query, a non-existent namespace answering count:0, and
  // lifetime aggregates read as current behaviour. Every one was a measurement whose support
  // region excluded the answer.
  //
  // The rule this encodes: before trusting a rate, ask what its support region EXCLUDES and
  // whether that is where the answer lives. Here the answer is cheap — a comparison window
  // with no observations cannot supply counter-evidence, so progress computed against it is
  // unfalsifiable and must be reported as such rather than as a green flag.
  const comparison_windows = cells_over_time.slice(recentHalf);
  const empty_comparison_windows = comparison_windows.filter((c) => c.trace_count === 0).length;
  const support_region_degenerate = comparison_windows.length > 0 && empty_comparison_windows === comparison_windows.length;
  const coverage_progress = recent_new_shapes_total > 0 && !support_region_degenerate;
  if (support_region_degenerate) {
    console.warn('[coverage-tick] SUPPORT REGION DEGENERATE — every comparison window is empty, so "new shape" is true by construction; reporting coverage_progress=false rather than an unfalsifiable pass', {
      comparison_windows: comparison_windows.length,
      empty_comparison_windows,
      recent_new_shapes_total,
    });
  }

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
      // Reported so a consumer can tell "no progress" from "could not have detected progress".
      support_region_degenerate,
      empty_comparison_windows,
      // New substantive metrics — robust to trace-volume gaming:
      total_advertised_shapes: total_advertised,
      total_learned_unique,
      advertised_learned_unique,
      unknown_shapes_learned,
      total_unlearned_unique,
      coverage_fraction,
      recent_new_shapes_introduced: recent_new_shapes_total,
      meta_activities_excluded: [...META_TEMPLATE_IDS],
    },
  };
}
