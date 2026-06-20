/**
 * generative_frontier_gap_tick — Seam ①: closure-driven GENERATIVE gap source.
 *
 * The substrate's existing gap sources are REACTIVE: a failed trace, an unmet
 * template demand, a detector firing on an observed pathology. None of them
 * ORIGINATE intent — they only respond to something that already broke or is
 * already wanted. This resolver gives the substrate a generative intent source:
 * it proposes the next REACHABLE capability from the topology frontier
 * (closure-driven, NOT greenfield) and emits a substrateGap with a new source
 * `substrate_generative`.
 *
 * FRONTIER HEURISTIC (mirrors learned-topology-snapshot's producer/consumer
 * derivation): from templates + recent traces, build producedShapes (template
 * output_shapes ∪ traced output shapes) and consumedShapes (template input_shapes
 * ∪ traced input shapes). The FRONTIER is shapes that are PRODUCED and TRACED
 * (trace_count > 0 — REAL, not merely advertised) but ABSENT from consumed
 * (produced-but-uncomposed). Ranked by trace_count desc, the top candidate's
 * proposed capability is "a consumer for shape X" — extending the composition
 * graph one reachable hop.
 *
 * HEADROOM GATE (primary throttle, FAIL-CLOSED): the governor enforces
 * λ₁ ≳ ρ_grow — capability must not be minted into a degenerate star. headroom =
 * fiedler_lambda2 * (1 - star_ratio), read from the spectral-gap JSONL. Emit ONLY
 * if headroom >= HEADROOM_THRESHOLD (default 0.35) AND components === 1 AND
 * nodes >= MIN_NODES (8). If the JSONL is missing/unreadable → fail CLOSED
 * (reason "spectral_signal_unavailable", emitted:false). The live substrate is a
 * near-pure star (star_ratio ~0.97 → headroom ~0.03), so the gate correctly
 * REFUSES all emission now — intended until genuine composition raises the gap.
 *
 * RATE-LIMIT + DEDUP make this STRUCTURALLY incapable of flooding:
 *   - ≤ 1 emit / min_rate_limit_hours (reads the gaps store for the most recent
 *     substrate_generative gap).
 *   - stable gap id `generative-frontier-<shape>` (NO timestamp) → re-proposals
 *     UPSERT one row; an already-open generative gap for that shape short-circuits
 *     ("already_open").
 */

import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT as DEFAULT_WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { fetchWithRetry } from "./http-retry.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GenerativeFrontierGapTickPointer {
  type: "generative_frontier_gap_tick";
  lookback_window_seconds?: number;
  dry_run?: boolean;
  /** Headroom floor; defaults to env GENERATIVE_HEADROOM_THRESHOLD or 0.35. */
  headroom_threshold?: number;
  /** Min hours between two substrate_generative emits. Default 6. */
  min_rate_limit_hours?: number;
  /** Override for the spectral-gap JSONL (tests). */
  spectral_metrics_path?: string;
  /** Override for the dev-vessel resolve endpoint the write POSTs to. */
  emit_url?: string;
  /** Override for the gaps store path (tests). */
  gaps_path?: string;
}

interface Template {
  id?: string;
  output_shapes?: string[];
  input_shapes?: string[];
}

interface TraceRow {
  output_shapes?: string[];
  output_impulse_shapes?: string[];
  input_shapes?: string[];
  input_impulse_shapes?: string[];
}

interface SpectralLine {
  fiedler_lambda2?: number;
  star_ratio?: number;
  components?: number;
  nodes?: number;
}

interface GapRow {
  id?: unknown;
  source?: unknown;
  status?: unknown;
  classification_metadata?: Record<string, unknown> | null;
  created_at?: unknown;
  updated_at?: unknown;
  detected_at?: unknown;
}

const DEFAULT_HEADROOM_THRESHOLD = 0.35;
const MIN_NODES = 8;
const DEFAULT_EMIT_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

function workspaceRoot(): string {
  return process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
}

/** Read the last line of the spectral-gap JSONL (in-container path, then host fallback). */
async function readSpectral(explicitPath?: string): Promise<SpectralLine | null> {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        "/workspace/metrics/spectral-gap.jsonl",
        join(workspaceRoot(), "metrics", "spectral-gap.jsonl"),
        "scripts/substrate/workspace/metrics/spectral-gap.jsonl",
      ];
  for (const path of candidates) {
    try {
      const raw = await readFile(path, "utf-8");
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      return JSON.parse(lines[lines.length - 1]!) as SpectralLine;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function resolveGenerativeFrontierGapTick(
  pointer: GenerativeFrontierGapTickPointer,
): Promise<ResolverResult> {
  const lookbackSecs = pointer.lookback_window_seconds ?? 3600;
  const dryRun = pointer.dry_run === true;
  const headroomThreshold =
    pointer.headroom_threshold ??
    Number(process.env["GENERATIVE_HEADROOM_THRESHOLD"] ?? DEFAULT_HEADROOM_THRESHOLD);
  const minRateLimitHours = pointer.min_rate_limit_hours ?? 6;
  const emitUrl = pointer.emit_url ?? DEFAULT_EMIT_URL;
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  const fail = (reason: string, extra: Record<string, unknown> = {}): ResolverResult => ({
    shape: "generativeFrontierGapReport",
    body: {
      emitted: false,
      reason,
      candidate_shape: null,
      headroom: null,
      fiedler_lambda2: null,
      star_ratio: null,
      frontier_size: 0,
      ...extra,
    },
  });

  // — 1. HEADROOM GATE (primary throttle, fail-CLOSED) —
  // Gate on the GENUINE capability subgraph (lifecycle hooks excluded), NOT the full graph.
  // The full-graph headroom is PERVERSE: every execution nests validator-dispatch/slot-binding,
  // so the hub grows with activity → headroom FALLS as the substrate composes more, and this
  // gate would never unlock (it would punish the very growth that should open it). genuine
  // headroom is the honest signal — it is 0 while the capability graph is FRAGMENTED
  // (components>1), so the gate stays closed until composition BRIDGES the components, then
  // unlocks once the connected capability graph has real headroom. (2026-06-19) Falls back to
  // the top-level (full) fields for spectral entries predating the genuine{} block.
  const spectral = await readSpectral(pointer.spectral_metrics_path);
  const gspec: any =
    spectral && (spectral as any).genuine && typeof (spectral as any).genuine.fiedler_lambda2 === "number"
      ? (spectral as any).genuine
      : spectral;
  if (
    !gspec ||
    typeof gspec.fiedler_lambda2 !== "number" ||
    typeof gspec.star_ratio !== "number"
  ) {
    return fail("spectral_signal_unavailable");
  }
  const lambda2 = gspec.fiedler_lambda2;
  const starRatio = gspec.star_ratio;
  const components = typeof gspec.components === "number" ? gspec.components : NaN;
  const nodes = typeof gspec.nodes === "number" ? gspec.nodes : 0;
  const headroom = lambda2 * (1 - starRatio);

  const spectralFields = {
    headroom,
    fiedler_lambda2: lambda2,
    star_ratio: starRatio,
  };

  if (components !== 1) {
    return fail("headroom_gate_blocked", { ...spectralFields, components });
  }
  if (nodes < MIN_NODES) {
    return fail("headroom_gate_blocked", { ...spectralFields, nodes });
  }
  if (headroom < headroomThreshold) {
    return fail("headroom_gate_blocked", { ...spectralFields, headroom_threshold: headroomThreshold });
  }

  // — 2. FRONTIER HEURISTIC (closure-driven) —
  // Fetch templates (≤500, paginated) + recent traces (lookback window).
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  let keepFetching = true;
  while (keepFetching) {
    const r = await fetchWithRetry(
      `${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`,
      { headers: auth },
    );
    if (!r || !r.ok) break;
    const page = (await r.json()) as { templates?: Template[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize || templates.length >= 500) keepFetching = false;
  }

  const since = new Date(Date.now() - lookbackSecs * 1000).toISOString();
  const traces: TraceRow[] = [];
  const trRes = await fetchWithRetry(
    `${METABOB_ENDPOINT}/v2/activities/execution-traces?since=${encodeURIComponent(since)}&limit=200`,
    { headers: auth },
  );
  if (trRes && trRes.ok) {
    const trData = (await trRes.json()) as { traces?: TraceRow[]; executions?: TraceRow[] };
    traces.push(...(trData.traces ?? trData.executions ?? []));
  }

  // producedShapes = template output_shapes ∪ traced output shapes.
  // consumedShapes = template input_shapes ∪ traced input shapes.
  // trace_count = times a shape appears as a TRACED output (REAL production).
  const consumedShapes = new Set<string>();
  const tracedOutputCount: Record<string, number> = {};

  for (const tpl of templates) {
    for (const s of tpl.input_shapes ?? []) consumedShapes.add(s);
  }
  for (const tr of traces) {
    for (const s of tr.output_impulse_shapes ?? tr.output_shapes ?? []) {
      tracedOutputCount[s] = (tracedOutputCount[s] ?? 0) + 1;
    }
    for (const s of tr.input_impulse_shapes ?? tr.input_shapes ?? []) {
      consumedShapes.add(s);
    }
  }

  // FRONTIER = produced shapes that are TRACED (trace_count > 0) AND absent from
  // consumed (produced-but-uncomposed). Rank by trace_count desc.
  const frontier = Object.entries(tracedOutputCount)
    .filter(([shape, count]) => count > 0 && !consumedShapes.has(shape))
    .sort((a, b) => b[1] - a[1]);

  if (frontier.length === 0) {
    return fail("no_frontier_candidate", spectralFields);
  }

  const [candidateShape, producedCount] = frontier[0]!;
  const frontierSize = frontier.length;
  const gapId = `generative-frontier-${candidateShape}`;

  // — 3. RATE-LIMIT + DEDUP (read the gaps store) —
  const gapsPath = pointer.gaps_path ?? join(workspaceRoot(), "gaps", "gaps.json");
  let gaps: GapRow[] = [];
  try {
    const raw = await readFile(gapsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) gaps = parsed as GapRow[];
  } catch {
    // No gaps store yet → no rate-limit / dedup constraint.
  }

  // DEDUP: an OPEN substrate_generative gap for this exact shape already exists.
  const alreadyOpen = gaps.some(
    (g) =>
      g.source === "substrate_generative" &&
      g.status === "open" &&
      typeof g.id === "string" &&
      g.id === gapId,
  );
  if (alreadyOpen) {
    return fail("already_open", { ...spectralFields, candidate_shape: candidateShape, frontier_size: frontierSize });
  }

  // RATE-LIMIT: most recent substrate_generative gap within the window blocks.
  const windowMs = minRateLimitHours * 3600 * 1000;
  const now = Date.now();
  const generativeTimes = gaps
    .filter((g) => g.source === "substrate_generative")
    .map((g) => {
      const t = (g.created_at ?? g.updated_at ?? g.detected_at) as unknown;
      return typeof t === "string" ? Date.parse(t) : NaN;
    })
    .filter((t) => !Number.isNaN(t));
  const mostRecent = generativeTimes.length > 0 ? Math.max(...generativeTimes) : -Infinity;
  if (now - mostRecent < windowMs) {
    return fail("rate_limited", { ...spectralFields, candidate_shape: candidateShape, frontier_size: frontierSize });
  }

  // — 4. EMIT (unless dry_run) —
  const summary =
    `Shape '${candidateShape}' produced (${producedCount} traces) but no consumer; ` +
    `propose a consumer capability (closure-frontier extension).`;

  if (dryRun) {
    return {
      shape: "generativeFrontierGapReport",
      body: {
        emitted: false,
        reason: "dry_run",
        candidate_shape: candidateShape,
        headroom,
        fiedler_lambda2: lambda2,
        star_ratio: starRatio,
        frontier_size: frontierSize,
        gap_id: gapId,
      },
    };
  }

  let postOk = false;
  let postStatus: number | "error" = "error";
  let postError: string | undefined;
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: gapId,
          category: "missing_capability",
          source: "substrate_generative",
          summary,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            gap_subtype: "generative_frontier",
            shape: candidateShape,
            produced_count: producedCount,
            headroom,
          },
        },
      },
    },
  };
  try {
    const resp = await fetch(emitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    postStatus = resp.status;
    postOk = resp.ok;
    if (!resp.ok) postError = (await resp.text()).slice(0, 200);
  } catch (err) {
    postStatus = "error";
    postError = (err as Error).message;
  }

  return {
    shape: "generativeFrontierGapReport",
    body: {
      emitted: postOk,
      reason: postOk ? "emitted" : "emit_failed",
      candidate_shape: candidateShape,
      headroom,
      fiedler_lambda2: lambda2,
      star_ratio: starRatio,
      frontier_size: frontierSize,
      gap_id: gapId,
      post_status: postStatus,
      ...(postError ? { post_error: postError } : {}),
    },
  };
}
