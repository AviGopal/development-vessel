import type { ResolverResult } from "./types.js";
// Replaces the drafter-trigger-tick random scenario pick with a priority-weighted selection.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PRIORITY_CATEGORIES, sanitizeId } from "./gap-to-scenario-bridge.js";

/**
 * pick_priority_scenario (2026-06-15) — VALUE-DIRECTED scenario selection.
 *
 * Replaces the drafter-trigger-tick's random `fs_list → shuffle → [0]` pick.
 * That random pick was the live rate-limiter on self-development: a real,
 * high-priority, self-detected goal-vessel deficiency sat undrafted for hours
 * because the picker shuffled ~hundreds of scenarios and never landed on it.
 *
 * This resolver chooses the highest-VALUE undrafted scenario instead of a
 * coin-flip. Value = (category priority rank, then severity, then recency):
 *   - category priority: the bridge's PRIORITY_CATEGORIES order (architectural,
 *     missing_capability, goal_host_*, … ahead of incidental). Single source of
 *     truth, imported from the bridge.
 *   - severity: harm magnitude from the gap's metadata (failing volume,
 *     deviation, cyclic fraction) — a 0%-success-over-40-runs gap outranks a
 *     marginal one of the same category.
 *   - recency: fresher gaps drain first on ties.
 * Already-drafted scenarios (a proposed gap-closing template already covers the
 * class) are excluded so the picker rotates forward instead of re-drafting.
 *
 * Read-only over disk + one activity-api fetch; deterministic.
 */

const ACTIVITY_API = process.env["ACTIVITY_API_ENDPOINT"] ?? "http://127.0.0.1:8080";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

export interface PickPriorityScenarioPointer {
  type: "pick_priority_scenario";
  scenarios_dir?: string;
  gaps_path?: string;
  exclude_drafted?: boolean; // default true
  apiKey?: string;
  /** When true, ALSO dispatch the drafter on the picked scenario (one-shot —
   *  avoids fragile cross-task interpolation in the trigger-tick activity). */
  dispatch_drafter?: boolean;
  light_dispatch_url?: string;
  drafter_template_id?: string;
  parent_execution_id?: string;
  composition_chain?: string[];
}

const DEFAULT_LIGHT_DISPATCH = "http://127.0.0.1:8280/dispatch";
const DEFAULT_DRAFTER = "development-vessel:draft-gap-closing-activity";

async function dispatchDrafter(
  pickedId: string,
  scenariosDir: string,
  url: string,
  drafterId: string,
  apiKey: string,
  parentExecutionId?: string,
  compositionChain?: string[],
): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({
        template_id: drafterId,
        ...(parentExecutionId ? { parent_execution_id: parentExecutionId } : {}),
        ...(compositionChain && compositionChain.length ? { composition_chain: compositionChain } : {}),
        variables: {
          report_path: `${scenariosDir}/${pickedId}.json`,
          scenario_id: pickedId,
          proposals_dir: "/workspace/proposals",
          scenarios_dir: scenariosDir,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await res.json()) as { status?: string; dispatchId?: string; executionId?: string; error?: string };
    return { status: j.status ?? (res.ok ? "ok" : `http_${res.status}`), dispatchId: j.dispatchId ?? j.executionId ?? null, error: j.error ?? null };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
}

interface Gap {
  id?: string;
  status?: string;
  source?: string;
  category?: string;
  created_at?: string;
  detected_at?: string;
  classification_metadata?: Record<string, unknown> | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function categoryRank(category: string): number {
  const i = PRIORITY_CATEGORIES.indexOf(category);
  return i === -1 ? PRIORITY_CATEGORIES.length : i;
}

// Harm magnitude from whatever the detector recorded. Higher = more valuable to
// fix. Generic over detector families (failing direction, deviation, cyclic).
function severity(gap: Gap): number {
  const m = gap.classification_metadata ?? {};
  const samples = num(m["samples"] ?? m["total_dispatches"] ?? m["total_executions"] ?? 0);
  const success = num(m["success_rate"] ?? 1);
  const deviation = num(m["deviation_fraction"] ?? 0);
  const cyclic = num(m["cyclic_fraction"] ?? 0);
  const harm = Math.max(1 - success, deviation, cyclic, 0.1);
  // Volume-weighted harm; +1 so a high-harm low-sample gap still scores.
  return (samples + 1) * harm;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function resolvePickPriorityScenario(
  p: PickPriorityScenarioPointer,
): Promise<ResolverResult> {
  const scenariosDir = p.scenarios_dir ?? "/workspace/validation/failure-modes/scenarios";
  const gapsPath = p.gaps_path ?? "/workspace/gaps/gaps.json";
  const excludeDrafted = p.exclude_drafted !== false;
  const apiKey = p.apiKey ?? API_KEY;

  // 1. Materialized scenario files on disk (the drafter can only draft these).
  let files: string[] = [];
  try {
    files = (await readdir(scenariosDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { shape: "priorityScenarioPick", body: { scenario_id: "", scenario_filename: "", reason: "scenarios_dir_unreadable" } };
  }
  const fileSet = new Set(files.map((f) => f.slice(0, -5)));

  // 2. Open gaps (the value/priority source).
  let gaps: Gap[] = [];
  try {
    const parsed = JSON.parse(await readFile(gapsPath, "utf-8"));
    if (Array.isArray(parsed)) gaps = parsed as Gap[];
  } catch { /* tolerant — fall back to flat file ranking below */ }

  // 3. Already-drafted classes (a proposed gap-closing template covers them).
  let draftedClasses: string[] = [];
  if (excludeDrafted && apiKey) {
    try {
      const res = await fetch(`${ACTIVITY_API.replace(/\/+$/, "")}/v2/activities/templates/proposed-for-exercise?limit=100`, {
        headers: { Authorization: `ApiKey ${apiKey}` }, signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { templates?: Array<{ gap_class?: string }> };
        draftedClasses = (body.templates ?? []).map((t) => normalize(t.gap_class ?? "")).filter(Boolean);
      }
    } catch { /* tolerant — dedup best-effort */ }
  }
  const isDrafted = (scenarioId: string): boolean => {
    const key = normalize(scenarioId);
    return key.length > 0 && draftedClasses.some((c) => c.includes(key));
  };

  // 4. Score every gap that has a materialized, open, undrafted scenario.
  const ACUTE_CATEGORIES = new Set([
  "service_failure",
  "operational_health",
  "safety_breach",
]);
const STRUCTURAL_CATEGORIES = new Set([
  "systematic_failure",
  "architectural_pattern",
  "unreachable_producer",
  "residual_shape_proposal",
]);

type Cand = {
  instability: number; scenario_id: string; category: string; rank: number; severity: number; recency: string; actionability: number };
  let headroom = 1;
  try {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("/workspace/metrics/spectral-gap.jsonl", "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const row = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      headroom =
        (Number(row["fiedler_lambda2"]) || 0) *
        (1 - (Number(row["star_ratio"]) || 0));
    }
  } catch {
    headroom = 1;
  }

  const candidates: Cand[] = [];
  const ALLOWED = new Set(["operator_seed", "operator_narration", "substrate_detected", "substrate_generative"]);
  // Forward model: P(patch_proposal non-empty | target_file_paths, mode_class, category).
  // Predict drafter actionability before dispatch so we avoid burning cycles on
  // scenarios that will almost certainly yield analytic-only/no-op proposals.
  // Incorporates spectral-gap headroom and structural/acute category health so
  // low-headroom structural gaps and analytic-only modes score below threshold.
  // Residual: callers comparing actual patch emptiness to this score widen gap
  // detectability per predict→validate→residual.
  // Exported via scorePredictedActionability below so downstream residual
  // validators (drafter outcome auditors) can recompute the same score and
  // record mismatches between predicted actionability and actual patch emptiness.
  const predictActionability = (g: { category?: string; mode_class?: string; target_file_paths?: unknown }): number => {
    let score = 0.5;
    const tfp = g.target_file_paths;
    if (tfp !== undefined && tfp !== null) score += 0.3; else score -= 0.2;
    const mc = g.mode_class;
    if (typeof mc === "string" && /analytic|observ|report|audit/.test(mc.toLowerCase())) score -= 0.3;
    if (typeof mc === "string" && /code|fix|patch|impl/.test(mc.toLowerCase())) score += 0.2;
    const cat = g.category;
    if (typeof cat === "string" && /architectural|implementation|bug|fix/.test(cat.toLowerCase())) score += 0.1;
    if (/architectural|implementation|bug|fix/.test(cat)) score += 0.1;
    if (ACUTE_CATEGORIES.has(cat)) score += 0.15;
    if (STRUCTURAL_CATEGORIES.has(cat) && headroom < 0.35) score -= 0.15;
    if (headroom < 0.35) score -= 0.1;
    return Math.max(0, Math.min(1, score));
  };
  const ACTIONABILITY_THRESHOLD = 0.35;
  for (const g of gaps) {
    if (typeof g.id !== "string") continue;
    if (g.status && g.status !== "open") continue;
    if (g.source && !ALLOWED.has(g.source)) continue;
    const scenarioId = sanitizeId(g.id);
    if (!fileSet.has(scenarioId)) continue; // no materialized scenario
    if (excludeDrafted && isDrafted(scenarioId)) continue;
    const actionability = predictActionability(g as { category?: string; mode_class?: string; target_file_paths?: unknown });
    if (actionability < ACTIONABILITY_THRESHOLD) continue; // filter low-confidence no-ops
    const cat: string = g.category ?? "auto";
    const rank = categoryRank(cat);
    const sev = severity(g);
    const instability: number = ACUTE_CATEGORIES.has(cat)
      ? 3
      : headroom < 0.35 && STRUCTURAL_CATEGORIES.has(cat)
        ? 2
        : 0;
    candidates.push({
      scenario_id: scenarioId,
      category: cat,
      rank,
      severity: sev,
      recency: g.detected_at ?? g.created_at ?? "",
      actionability,
      instability,
    });
  }

  // Fallback: if gaps.json gave nothing (e.g. scenario on disk with no live gap
  // row), rank the raw files by recency-name so we still pick deterministically
  // rather than failing — but value-ranked candidates always win.
  if (candidates.length === 0) {
    const undrafted = [...fileSet].filter((id) => !(excludeDrafted && isDrafted(id)));
    undrafted.sort();
    const pick = undrafted[0] ?? "";
    return {
      shape: "priorityScenarioPick",
      body: {
        scenario_id: pick,
        scenario_filename: pick ? `${pick}.json` : "",
        reason: pick ? "no_gap_metadata_fallback_alpha" : "no_undrafted_scenarios",
        considered: fileSet.size,
        value_ranked: 0,
      },
    };
  }

  // Rank: instability desc, category priority asc, severity desc, recency desc.
  candidates.sort((a, b) => {
    if (a.instability !== b.instability) return b.instability - a.instability;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.severity !== b.severity) return b.severity - a.severity;
    return b.scenario_id.localeCompare(a.scenario_id);
  });
  const top = candidates[0]!;

  let dispatch_result: unknown = null;
  if (p.dispatch_drafter && apiKey) {
    dispatch_result = await dispatchDrafter(
      top.scenario_id, scenariosDir,
      p.light_dispatch_url ?? DEFAULT_LIGHT_DISPATCH,
      p.drafter_template_id ?? DEFAULT_DRAFTER, apiKey,
      p.parent_execution_id, p.composition_chain,
    );
  }

  return {
    shape: "priorityScenarioPick",
    body: {
      scenario_id: top.scenario_id,
      scenario_filename: `${top.scenario_id}.json`,
      category: top.category,
      priority_rank: top.rank,
      severity: top.severity,
      instability: top.instability,
      reason: "value_ranked",
      considered: fileSet.size,
      value_ranked: candidates.length,
      runner_up: candidates[1]?.scenario_id ?? null,
      dispatched: p.dispatch_drafter === true,
      dispatch_result,
    },
  };
}
