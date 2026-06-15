import type { ResolverResult } from "./types.js";

/**
 * goal_host_behavior_scan (2026-06-15) — learn how the goal executor OPERATES.
 *
 * The obsidian mechanism transposed to the goal vessel: instead of probing an
 * external app's commands, OBSERVE the goal-host's own executions (it is always
 * producing traces) and build a behavioral / expectation model of it. No gating
 * — the substrate is self-prompted, so this characterizes rather than blocks.
 *
 *   - GOAL DIRECTION = the output-shape signature an execution produces (the
 *     direction in shape space; cf. SUBSTRATE_AS_MDP goal-direction g).
 *   - For each direction, the EXPECTATION model = what the executor does: the
 *     modal template it selects/auto-authors, its dominant resolver tier, its
 *     effect class (read|navigate|mutate|destructive — a descriptor, not a
 *     gate), success rate, cost, and how often it had to auto-author rather
 *     than reuse.
 *   - DEVIATIONS = executions that depart from their direction's modal behavior
 *     (different template, or failure) — "the executor behaved unexpectedly."
 *   - COVERAGE = which goal directions are well-modeled vs thin (the residual /
 *     under-explored directions to map next).
 *
 * Persists one `goal_host_behavior` prior per modeled direction to concept-db,
 * so the substrate accumulates expectations about its own goal executor.
 */

const ACTIVITY_API = process.env["ACTIVITY_API_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DEFAULT_CONCEPT_DB = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];

// Lifecycle-internal templates whose deficiencies are structural noise already
// covered by other detectors (cyclic-flow). Excluded from improvement gaps so we
// only route GENUINE goal-vessel deficiencies into the autonomous loop.
const LIFECYCLE_TEMPLATES = /validator-dispatch|slot-binding|lifecycle/i;

/**
 * Emit a substrateGap for a goal-vessel deficiency so the existing
 * detect→draft→exercise→promote loop autonomously IMPROVES the goal vessel.
 * This is what turns the behavior model from a passive observer into a driver of
 * autonomous improvement.
 */
async function emitGoalHostGap(
  emitUrl: string,
  apiKey: string,
  kind: "failing" | "inconsistent",
  m: any,
): Promise<boolean> {
  const cls = kind === "failing" ? "goal_host_failing_direction" : "goal_host_inconsistent_direction";
  const slug = String(m.goal_direction).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 60);
  const summary =
    kind === "failing"
      ? `goal-host fails on direction [${m.goal_direction}]: modal template ${m.expected_template} succeeds only ${(m.success_rate * 100).toFixed(0)}% over ${m.samples} runs — the goal vessel has no effective path for this direction.`
      : `goal-host thrashes on direction [${m.goal_direction}]: ${m.distinct_templates} templates, ${(m.deviation_fraction * 100).toFixed(0)}% deviation from modal over ${m.samples} runs — the goal vessel has no settled approach for this direction.`;
  const remediation =
    kind === "failing"
      ? `Author an activity that reliably produces output shapes [${m.goal_direction}]; the executor's current approach (${m.expected_template}) fails. Improve the goal vessel's coverage of this direction.`
      : `Author or consolidate a settled activity for output shapes [${m.goal_direction}] so the executor stops thrashing across ${m.distinct_templates} templates.`;
  const body = {
    impulse: { pointer: { type: "substrateGap_write", gap: {
      id: `${cls}-${slug}`,
      category: cls,
      source: "substrate_detected",
      summary,
      detected_at: new Date().toISOString(),
      status: "open",
      classification_metadata: {
        detector: "goal_host_behavior_scan",
        gap_class: cls,
        goal_direction: m.goal_direction,
        expected_template: m.expected_template,
        success_rate: m.success_rate,
        samples: m.samples,
        deviation_fraction: m.deviation_fraction,
        distinct_templates: m.distinct_templates,
        effect_class: m.effect_class,
        suggested_remediation: remediation,
      },
    } } },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const r = await fetch(emitUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

export type EffectClass = "read" | "navigate" | "mutate" | "destructive";

export interface GoalHostBehaviorScanPointer {
  type: "goal_host_behavior_scan";
  windowHours?: number;   // trace window, default 24
  limit?: number;         // trace fetch cap, default 2000
  minSamples?: number;    // min traces per direction to model, default 3
  persist?: boolean;      // persist priors to concept-db, default true
  emit_gaps?: boolean;    // emit substrateGap for deficiencies, default true
  minGapSamples?: number; // min samples before a direction is gap-worthy, default 8
  failThreshold?: number; // success_rate <= this ⇒ failing-direction gap, default 0.2
  deviationThreshold?: number; // deviation_fraction >= this ⇒ inconsistent gap, default 0.5
  conceptDbBase?: string;
  devVesselImpulsesUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface TraceRow {
  activity_id?: string; variant_id?: string;
  execution_id?: string; id?: string;
  status?: string; success?: boolean;
  output_impulse_shapes?: string[];
  cost_usd?: number;
  tags?: string[];
  failure_mode?: { type?: string } | null;
  tasks?: Array<{ resolver?: string; resolver_tier?: string }>;
}

const normalizeActivityId = (raw: string): string =>
  raw.replace(/^activity:/, "").replace(/⟨|⟩/g, "");

const isSuccess = (t: TraceRow): boolean =>
  t.success === true || t.status === "success" || t.status === "completed";

// Effect class as a behavioral DESCRIPTOR (not an authorization gate).
function classifyEffect(resolvers: string[], activityId: string): EffectClass {
  const hay = (resolvers.join(" ") + " " + activityId).toLowerCase();
  if (/gh[-_]?pr[-_]?merge|gh[-_]?repo[-_]?create|git[-_]?push|force[-_]?deploy|publish|deprecate|delete|destroy/.test(hay)) return "destructive";
  if (/fs[-_]?write|fs[-_]?edit|code[-_]?replace|apply[-_]?proposal|concept[-_]?create|concept[-_]?write|template[-_]?update|_write\b|mitosis|patch|scaffold/.test(hay)) return "mutate";
  if (/report|scan|audit|recommend|search|fs[-_]?read|coverage|measure|snapshot|catalog|gate\b|classify|detect/.test(hay)) return "read";
  return "navigate";
}

const modeOf = (counts: Map<string, number>): { key: string; n: number; total: number } => {
  let best = "", bn = 0, total = 0;
  for (const [k, v] of counts) { total += v; if (v > bn) { bn = v; best = k; } }
  return { key: best, n: bn, total };
};

export async function resolveGoalHostBehaviorScan(
  p: GoalHostBehaviorScanPointer,
): Promise<ResolverResult> {
  const windowHours = p.windowHours ?? 24;
  const limit = p.limit ?? 2000;
  const minSamples = p.minSamples ?? 3;
  const persist = p.persist !== false;
  const conceptBase = (p.conceptDbBase ?? DEFAULT_CONCEPT_DB).replace(/\/+$/, "");
  const apiKey = p.apiKey ?? API_KEY;
  const timeoutMs = p.timeoutMs ?? 20_000;
  const generatedAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - windowHours * 3600_000).toISOString();

  if (!apiKey) return { shape: "goalHostBehaviorModel", body: { error: "missing_api_key", directions: 0 } };

  let traces: TraceRow[];
  try {
    const res = await fetch(
      `${ACTIVITY_API.replace(/\/+$/, "")}/v2/activities/execution-traces?since=${encodeURIComponent(windowStart)}&limit=${limit}`,
      { headers: { Authorization: `ApiKey ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return { shape: "goalHostBehaviorModel", body: { error: `traces fetch ${res.status}`, directions: 0, generated_at: generatedAt } };
    const json = (await res.json()) as { traces?: TraceRow[]; executions?: TraceRow[] } | TraceRow[];
    traces = Array.isArray(json) ? json : (json.traces ?? json.executions ?? []);
  } catch (err) {
    return { shape: "goalHostBehaviorModel", body: { error: err instanceof Error ? err.message.slice(0, 120) : "fetch error", directions: 0, generated_at: generatedAt } };
  }

  // Group by goal DIRECTION = sorted output-shape signature.
  interface DirAccum {
    n: number; successes: number;
    activities: Map<string, number>;
    tiers: Map<string, number>;
    effects: Map<EffectClass, number>;
    costs: number[];
    autoAuthored: number;
    deviationExecs: string[];
  }
  const dirs = new Map<string, DirAccum>();
  let scanned = 0;

  for (const t of traces) {
    const actId = normalizeActivityId(t.activity_id ?? t.variant_id ?? "");
    if (!actId) continue;
    const shapes = (t.output_impulse_shapes ?? []).filter(Boolean);
    const direction = shapes.length ? [...shapes].sort().join("+") : "(no-output-shape)";
    scanned++;
    const resolvers = (t.tasks ?? []).map((x) => x.resolver ?? "").filter(Boolean);
    const tier = (t.tasks ?? []).map((x) => x.resolver_tier).filter(Boolean).pop() ?? "unknown";
    const effect = classifyEffect(resolvers, actId);
    let d = dirs.get(direction);
    if (!d) { d = { n: 0, successes: 0, activities: new Map(), tiers: new Map(), effects: new Map(), costs: [], autoAuthored: 0, deviationExecs: [] }; dirs.set(direction, d); }
    d.n++;
    if (isSuccess(t)) d.successes++;
    d.activities.set(actId, (d.activities.get(actId) ?? 0) + 1);
    d.tiers.set(tier, (d.tiers.get(tier) ?? 0) + 1);
    d.effects.set(effect, (d.effects.get(effect) ?? 0) + 1);
    if (typeof t.cost_usd === "number") d.costs.push(t.cost_usd);
    if (/^(gap-closing:|proposed_pattern_authored_)/.test(actId)) d.autoAuthored++;
  }

  // Build the expectation model for directions with enough samples.
  const model: any[] = [];
  for (const [direction, d] of dirs) {
    if (d.n < minSamples) continue;
    const modalAct = modeOf(d.activities);
    const modalTier = modeOf(d.tiers);
    const modalEffect = modeOf(d.effects as unknown as Map<string, number>);
    const costs = [...d.costs].sort((a, b) => a - b);
    const costP50 = costs.length ? costs[Math.floor(costs.length / 2)] : null;
    // Deviations: executions NOT using the modal template for this direction.
    const deviation_fraction = d.activities.size > 1 ? 1 - modalAct.n / modalAct.total : 0;
    model.push({
      goal_direction: direction,
      samples: d.n,
      success_rate: Math.round((d.successes / d.n) * 1000) / 1000,
      expected_template: modalAct.key,
      template_consistency: Math.round((modalAct.n / modalAct.total) * 1000) / 1000,
      distinct_templates: d.activities.size,
      dominant_tier: modalTier.key,
      effect_class: modalEffect.key as EffectClass,
      auto_authored_fraction: Math.round((d.autoAuthored / d.n) * 1000) / 1000,
      cost_usd_p50: costP50,
      deviation_fraction: Math.round(deviation_fraction * 1000) / 1000,
    });
  }
  model.sort((a, b) => b.samples - a.samples);

  const thinDirections = Array.from(dirs.entries()).filter(([, d]) => d.n < minSamples).length;

  // Route genuine goal-vessel deficiencies into the autonomous improvement loop.
  // A direction is gap-worthy if it has enough samples and is either consistently
  // FAILING or THRASHING — excluding lifecycle-internal noise (already covered by
  // the cyclic-flow detector) and no-output structural rows.
  const emitGaps = p.emit_gaps !== false;
  const minGapSamples = p.minGapSamples ?? 8;
  const failThreshold = p.failThreshold ?? 0.2;
  const deviationThreshold = p.deviationThreshold ?? 0.5;
  const emitUrl = p.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  let gaps_emitted = 0;
  const gap_directions: Array<{ goal_direction: string; kind: string }> = [];
  if (emitGaps) {
    for (const m of model) {
      if (m.samples < minGapSamples) continue;
      if (m.goal_direction === "(no-output-shape)") continue;
      if (LIFECYCLE_TEMPLATES.test(String(m.expected_template))) continue;
      let kind: "failing" | "inconsistent" | null = null;
      if (m.success_rate <= failThreshold) kind = "failing";
      else if (m.deviation_fraction >= deviationThreshold && m.distinct_templates >= 3) kind = "inconsistent";
      if (!kind) continue;
      if (await emitGoalHostGap(emitUrl, apiKey, kind, m)) {
        gaps_emitted++;
        gap_directions.push({ goal_direction: m.goal_direction, kind });
      }
    }
  }

  // Persist each modeled direction as a durable goal_host_behavior prior.
  let persisted = 0, perr = 0;
  if (persist) {
    const auth = { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` };
    for (const m of model) {
      try {
        const summary = `goal-host: direction [${m.goal_direction}] -> ${m.expected_template} (tier=${m.dominant_tier}, effect=${m.effect_class}, success=${m.success_rate}, n=${m.samples}, consistency=${m.template_consistency})`;
        const res = await fetch(`${conceptBase}/v2/impulses/resolve`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ impulse: { pointer: { type: "concept_create_write", conceptData: {
            shape: "goal_host_behavior", source_type: "extracted",
            summary, content: JSON.stringify(m), priority: 0.5, budget: 2000,
          } } } }),
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) persisted++; else perr++;
      } catch { perr++; }
    }
  }

  return {
    shape: "goalHostBehaviorModel",
    body: {
      window_hours: windowHours,
      scanned,
      directions_modeled: model.length,
      thin_directions: thinDirections,
      persisted, persist_errors: perr,
      // Deficiencies routed into the autonomous improvement loop.
      gaps_emitted,
      gap_directions,
      // The behavioral expectation model + the goal-direction map.
      model,
      generated_at: generatedAt,
    },
  };
}
