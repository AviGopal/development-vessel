import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
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
  output_shapes?: string[];
  created_at?: string;
}

interface CellCounts {
  timestamp: string;
  reachable_learned: number;
  reachable_unlearned: number;
  unknown: number;
}

async function computeCountsForWindow(
  since: string,
  auth: Record<string, string>,
  allTemplates: Template[],
): Promise<CellCounts> {
  // Fetch traces within the window
  const traces: TraceRow[] = [];
  const trRes = await fetch(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes.ok) {
    const trData = await trRes.json() as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  const advertisedShapes = new Set<string>();
  for (const tpl of allTemplates) {
    for (const s of (tpl.output_shapes ?? [])) advertisedShapes.add(s);
  }

  const learnedShapes = new Set<string>();
  for (const tr of traces) {
    for (const s of (tr.output_shapes ?? [])) learnedShapes.add(s);
  }

  const reachable_learned = [...advertisedShapes].filter(s => learnedShapes.has(s)).length;
  const reachable_unlearned = [...advertisedShapes].filter(s => !learnedShapes.has(s)).length;
  // unknown: in traces but not in templates
  const unknown = [...learnedShapes].filter(s => !advertisedShapes.has(s)).length;

  return { timestamp: since, reachable_learned, reachable_unlearned, unknown };
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

  // Compute counts for each window (oldest to most recent)
  // Window i looks back (numWindows - i) * windowSize seconds
  const now = Date.now();
  const cells_over_time: CellCounts[] = [];
  for (let i = numWindows - 1; i >= 0; i--) {
    const since = new Date(now - (i + 1) * windowSize * 1000).toISOString();
    const counts = await computeCountsForWindow(since, auth, allTemplates);
    cells_over_time.push(counts);
  }

  // Compute monotonicity over the time series.
  // "strictly" = every adjacent pair satisfies the strict inequality.
  // For coverage_progress we use non-worsening (≤/≥) for the "decreasing"
  // metrics because unknown=0 throughout is valid steady-state, not a failure.
  let reachable_learned_strictly_increasing = cells_over_time.length >= 2;
  let reachable_unlearned_strictly_decreasing = cells_over_time.length >= 2;
  let unknown_strictly_decreasing = cells_over_time.length >= 2;
  let reachable_unlearned_non_increasing = true;
  let unknown_non_increasing = true;

  for (let i = 1; i < cells_over_time.length; i++) {
    const prev = cells_over_time[i - 1]!;
    const curr = cells_over_time[i]!;
    if (curr.reachable_learned <= prev.reachable_learned) reachable_learned_strictly_increasing = false;
    if (curr.reachable_unlearned >= prev.reachable_unlearned) reachable_unlearned_strictly_decreasing = false;
    if (curr.unknown >= prev.unknown) unknown_strictly_decreasing = false;
    if (curr.reachable_unlearned > prev.reachable_unlearned) reachable_unlearned_non_increasing = false;
    if (curr.unknown > prev.unknown) unknown_non_increasing = false;
  }

  // consecutive_progressing_cycles: how many consecutive windows at the end show progress
  let consecutive_progressing_cycles = 0;
  for (let i = cells_over_time.length - 1; i >= 1; i--) {
    const prev = cells_over_time[i - 1]!;
    const curr = cells_over_time[i]!;
    const progressing =
      curr.reachable_learned > prev.reachable_learned ||
      curr.reachable_unlearned < prev.reachable_unlearned ||
      curr.unknown < prev.unknown;
    if (progressing) consecutive_progressing_cycles++;
    else break;
  }

  // coverage_progress: learned is strictly improving, decreasing metrics are
  // non-worsening (plateau at 0 is valid), and ≥3 consecutive progressing cycles.
  const coverage_progress =
    reachable_learned_strictly_increasing &&
    reachable_unlearned_non_increasing &&
    unknown_non_increasing &&
    consecutive_progressing_cycles >= 3;

  return {
    shape: "coverageReport",
    body: {
      generated_at: new Date().toISOString(),
      cells_over_time,
      monotonic_progress: {
        reachable_learned_strictly_increasing,
        reachable_unlearned_strictly_decreasing,
        unknown_strictly_decreasing,
      },
      consecutive_progressing_cycles,
      coverage_progress,
    },
  };
}
