import { env } from "../config.js";
/**
 * learning_mode — shape-driven mode-priority controller (P3, Seam ③).
 * Output shape: learningMode
 *
 * Reads the SHAPE LATTICE and emits which work MODE the substrate should
 * emphasize, as an emergent read-out (not a hardcoded switch):
 *   - necessary ∧ available                          → exploit/use   (no mode urgency)
 *   - necessary ∧ unavailable ∧ producible-by-reuse  → develop-by-reuse
 *   - necessary ∧ unavailable ∧ no producer          → develop-by-mint / collect
 *   - shape-flow continuity broken (fails/incomplete) → reflect/reconcile
 *
 * necessary = shapeClosureDemand (ranked missing-producer demand) ∪ open-gap
 *   demanded shapes (substrateGap.expected_output_shapes).
 * available  = advertised producers (discover-by-shapes forward).
 * need-to-be-made-available = necessary ∧ ¬available → the develop/collect frontier.
 * reflect signal = selectionEntropy (collapsed→collect exploration) +
 *   traceCompletenessReport (low completeness→reflect).
 *
 * Emits per_shape_boost for the top necessary-but-unavailable shapes and the
 * mode read-out. HYSTERESIS: require ~2 consecutive same-driver reads before
 * flipping mode (last mode persisted to WORKSPACE_ROOT/state). FLOOR: no mode
 * is ever fully starved (every mode keeps a minimum weight).
 */

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface LearningModePointer {
  type: "learning_mode" | "learningMode";
  devVesselUrl?: string;
  activityApiUrl?: string;
  apiKey?: string;
  limit?: number;
  [key: string]: unknown;
}

type Mode = "develop" | "collect" | "reflect";

interface PersistedModeState {
  mode: Mode;
  driver: string;
  pending_driver?: string;
  pending_count?: number;
  updated_at?: string;
}

// FLOOR: no mode is ever fully starved. Boost weights sit above this floor.
const MODE_FLOOR = Number(process.env["LEARNING_MODE_FLOOR"] ?? 0.5) || 0.5;
// Emphasis weight applied to the emphasized mode's candidates / shapes.
const MODE_EMPHASIS = Number(process.env["LEARNING_MODE_EMPHASIS"] ?? 1.8) || 1.8;
// Per-shape boost ceiling for necessary-but-unavailable shapes.
const SHAPE_BOOST = Number(process.env["LEARNING_MODE_SHAPE_BOOST"] ?? 2.5) || 2.5;
// HYSTERESIS: consecutive same-driver reads required before flipping mode.
const HYSTERESIS_READS = Number(process.env["LEARNING_MODE_HYSTERESIS"] ?? 2) || 2;
// selectionEntropy / traceCompleteness thresholds for the reflect signal.
const COMPLETENESS_LOW_PCT = Number(process.env["LEARNING_MODE_COMPLETENESS_LOW"] ?? 60) || 60;
// Number of top necessary-but-unavailable shapes to boost.
const TOP_SHAPES = Number(process.env["LEARNING_MODE_TOP_SHAPES"] ?? 8) || 8;

function stateFilePath(): string {
  return path.join(WORKSPACE_ROOT, "state", "learning-mode-state.json");
}

async function readPersisted(): Promise<PersistedModeState | null> {
  try {
    const raw = await fsp.readFile(stateFilePath(), "utf8");
    return JSON.parse(raw) as PersistedModeState;
  } catch {
    return null;
  }
}

async function writePersisted(s: PersistedModeState): Promise<void> {
  try {
    const p = stateFilePath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(s, null, 2), "utf8");
  } catch {
    // persistence is best-effort; a missing state file just resets hysteresis.
  }
}

export async function resolveLearningMode(pointer: LearningModePointer): Promise<ResolverResult> {
  const p = pointer;
  // env() rather than `?? default`: this container exports some endpoint vars as EMPTY strings,
  // and `??` does not fall back on "" — it would hand a fetch the empty endpoint. Same defect
  // class as 3409fac in config.ts. An explicit pointer field still wins over both.
  const devBase = (p.devVesselUrl ?? env("DEV_VESSEL_ENDPOINT", "http://127.0.0.1:8090")).replace(/\/$/, "");
  const DEV = devBase.endsWith("/v2/impulses/resolve") ? devBase : `${devBase}/v2/impulses/resolve`;
  const ACT = p.activityApiUrl ?? env("ACTIVITY_API_ENDPOINT", "http://127.0.0.1:8080");
  const API_KEY = p.apiKey ?? process.env["METABOB_API_KEY"] ?? "";
  const now = Date.now();

  const devResolve = async (impulsePointer: Record<string, unknown>): Promise<unknown> => {
    try {
      const r = await fetch(DEV, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${API_KEY}` },
        body: JSON.stringify({ impulse: { pointer: impulsePointer } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };

  // 1. necessary shapes — shapeClosureDemand ranked missing-producer demand.
  const scd = await devResolve({ type: "shape_closure_demand", limit: p.limit ?? 200 }) as Record<string, unknown> | null;
  const ranked: Array<{ shape: string; demand_count?: number; priority_score?: number }> =
    ((scd?.body as Record<string, unknown> | undefined)?.ranked ?? []) as Array<{ shape: string; demand_count?: number; priority_score?: number }>;
  const necessary = new Map<string, number>(); // shape -> demand weight
  for (const r of ranked) {
    if (!r?.shape) continue;
    necessary.set(r.shape, Math.max(necessary.get(r.shape) ?? 0, Number(r.priority_score ?? r.demand_count ?? 1)));
  }

  // Also fold open-gap demanded shapes (substrateGap.expected_output_shapes).
  const gapsResp = await devResolve({ type: "substrateGap", status: "open", limit: p.limit ?? 200 }) as Record<string, unknown> | null;
  const gaps: Array<{ expected_output_shapes?: string[]; classification_metadata?: { missing_shape?: string } }> =
    ((gapsResp?.body as Record<string, unknown> | undefined)?.gaps ?? []) as Array<{ expected_output_shapes?: string[]; classification_metadata?: { missing_shape?: string } }>;
  for (const g of gaps) {
    for (const s of g.expected_output_shapes ?? []) {
      necessary.set(s, Math.max(necessary.get(s) ?? 0, 1));
    }
    const ms = g.classification_metadata?.missing_shape;
    if (ms) necessary.set(ms, Math.max(necessary.get(ms) ?? 0, 1));
  }

  // 2. available — advertised producers via discover-by-shapes forward mode.
  //    A necessary shape with a live producer is "available" (→ exploit, not develop).
  const necessaryShapes = Array.from(necessary.keys());
  const available = new Set<string>();
  if (necessaryShapes.length > 0) {
    try {
      const r = await fetch(`${ACT}/v2/activities/discover-by-shapes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${API_KEY}` },
        body: JSON.stringify({ output_shapes: necessaryShapes, mode: "candidates_with_scores", direction: "forward" }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json() as Record<string, unknown>;
        const matches: Array<Record<string, unknown>> = (j?.candidates ?? j?.matches ?? []) as Array<Record<string, unknown>>;
        for (const m of matches) {
          const outs = (m["output_shapes"] ?? m["produces"] ?? []) as string[];
          for (const s of outs) if (necessary.has(s)) available.add(s);
        }
      }
    } catch {
      // fail soft — treat as unavailable (conservative: leans toward develop)
    }
  }

  // 3. need-to-be-made-available frontier = necessary ∧ ¬available.
  const frontier = necessaryShapes
    .filter((s) => !available.has(s))
    .map((s) => ({ shape: s, demand: necessary.get(s) ?? 1 }))
    .sort((a, b) => b.demand - a.demand);

  // 4. reflect signal — selectionEntropy (collapsed) + traceCompletenessReport (low).
  const se = await devResolve({ type: "selectionEntropy" }) as Record<string, unknown> | null;
  const entropyCollapsed = (se?.body as Record<string, unknown> | undefined)?.collapsed === true;
  const tcr = await devResolve({ type: "trace_completeness_report" }) as Record<string, unknown> | null;
  const completenessPct = Number((tcr?.body as Record<string, unknown> | undefined) !== undefined ? ((tcr?.body as Record<string, unknown>)?.summary as Record<string, unknown> | undefined)?.completenessPercent : undefined);
  const completenessLow = Number.isFinite(completenessPct) && completenessPct < COMPLETENESS_LOW_PCT;

  // 5. Derive the raw (pre-hysteresis) driver + mode.
  //    Priority order of concerns:
  //    reflect (continuity broken) > develop (frontier exists) > collect (entropy collapsed / no frontier).
  let rawMode: Mode;
  let driver: string;
  if (completenessLow) {
    rawMode = "reflect";
    driver = `trace_completeness_low(${Number.isFinite(completenessPct) ? completenessPct : "?"}<${COMPLETENESS_LOW_PCT})`;
  } else if (frontier.length > 0) {
    rawMode = "develop";
    driver = `frontier(${frontier.length} necessary-but-unavailable; top=${frontier[0]!.shape})`;
  } else if (entropyCollapsed) {
    rawMode = "collect";
    driver = "selection_entropy_collapsed(broaden exploration)";
  } else {
    // necessary ∧ available, no collapse → exploit; nothing urgent → collect (routine gather).
    rawMode = "collect";
    driver = necessaryShapes.length === 0 ? "no_open_demand(routine collect)" : "necessary_all_available(exploit)";
  }

  // 6. HYSTERESIS — require HYSTERESIS_READS consecutive same-driver-family reads
  //    before flipping the emphasized mode. Persist last mode + pending streak.
  const prev = await readPersisted();
  let emphasizeMode: Mode = rawMode;
  let pendingDriver = rawMode;
  let pendingCount = 1;
  if (prev) {
    if (prev.mode === rawMode) {
      // already in the target mode — reset any pending flip
      emphasizeMode = prev.mode;
      pendingDriver = rawMode;
      pendingCount = 0;
    } else if (prev.pending_driver === rawMode) {
      pendingCount = (prev.pending_count ?? 1) + 1;
      pendingDriver = rawMode;
      if (pendingCount >= HYSTERESIS_READS) {
        emphasizeMode = rawMode; // flip confirmed
        pendingCount = 0;
      } else {
        emphasizeMode = prev.mode; // hold previous mode until streak confirms
      }
    } else {
      // new candidate driver — start a fresh streak, hold previous mode
      emphasizeMode = prev.mode;
      pendingDriver = rawMode;
      pendingCount = 1;
    }
  }

  await writePersisted({
    mode: emphasizeMode,
    driver,
    pending_driver: pendingDriver,
    pending_count: pendingCount,
    updated_at: new Date(now).toISOString(),
  });

  // 7. per_shape_boost — top necessary-but-unavailable shapes get a boost scaled
  //    by demand, clamped to SHAPE_BOOST. FLOOR guarantees nothing starves: the
  //    consumer defaults absent shapes to 1.0, and no boost drops below MODE_FLOOR.
  const per_shape_boost: Record<string, number> = {};
  const maxDemand = frontier.reduce((mx, f) => Math.max(mx, f.demand), 1) || 1;
  for (const f of frontier.slice(0, TOP_SHAPES)) {
    const scaled = 1 + (SHAPE_BOOST - 1) * (f.demand / maxDemand);
    per_shape_boost[f.shape] = Math.max(MODE_FLOOR, Number(scaled.toFixed(3)));
  }

  // 8. mode_weights — emphasized mode gets MODE_EMPHASIS, others get MODE_FLOOR
  //    (never zero — the FLOOR keeps every mode alive).
  const mode_weights: Record<Mode, number> = {
    develop: MODE_FLOOR,
    collect: MODE_FLOOR,
    reflect: MODE_FLOOR,
  };
  mode_weights[emphasizeMode] = MODE_EMPHASIS;

  return {
    shape: "learningMode",
    body: {
      emphasize_mode: emphasizeMode,
      per_shape_boost,
      mode_weights,
      driver,
      raw_mode: rawMode,
      hysteresis: { pending_driver: pendingDriver, pending_count: pendingCount, reads_required: HYSTERESIS_READS },
      floor: MODE_FLOOR,
      evidence: {
        necessary_shapes: necessaryShapes.length,
        available_shapes: available.size,
        frontier_shapes: frontier.length,
        top_frontier: frontier.slice(0, TOP_SHAPES).map((f) => f.shape),
        selection_entropy_collapsed: entropyCollapsed,
        trace_completeness_percent: Number.isFinite(completenessPct) ? completenessPct : null,
        open_gaps_considered: gaps.length,
        closure_demand_considered: ranked.length,
      },
      generated_at: new Date(now).toISOString(),
      pointer_type: pointer.type,
    },
  };
}
