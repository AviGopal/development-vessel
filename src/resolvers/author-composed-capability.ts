/**
 * author_composed_capability — DECOMPOSITION-BASED AUTHORING (2026-06-27).
 *
 * The S2 capability-BREADTH lever. `author_producer` (its sibling) authors a
 * producer for a target shape X ONLY by WRAPPING a single LIVE resolver that
 * already produces X. For a genuinely NOVEL operator capability — a goal whose
 * completion shape NO single resolver produces (e.g. "a failure report") — there
 * is nothing to wrap, so author_producer (and the walk's escalate/stop branch)
 * gives up. BUT the path to the goal frequently EXISTS as a CHAIN of existing
 * resolvers: query activity-api for the raw data, then have the LLM format it.
 *
 * This resolver closes that gap. Given a goal + its target shapes + the pool of
 * already-available shapes, it:
 *   1. Builds a CATALOGUE of EXISTING resolvers/data-shapes the chain may use
 *      (discovery's advertised shapes + a curated description of activity-api's
 *      data resolvers and the canonical llm formatter).
 *   2. Asks the LLM (via the canonical llm_completion_dispatch path — no inline
 *      LLM) to PLAN a short ordered chain of those EXISTING resolvers that
 *      produces the goal's output from available data. Each planned task names a
 *      real resolver id, its config (with {{...}} bindings between tasks), and
 *      its declared input/output shapes.
 *   3. VALIDATES every planned task references a REAL resolver/shape id from the
 *      catalogue (rejects hallucinated ids) and that the plan is non-empty.
 *   4. AUTHORS the chain as a multi-task composite activity template and MINTS it
 *      via resolveActivityCreateVariant (the same write path author_producer uses
 *      for its bridge) — making it immediately Thompson-selectable and durable.
 *   5. Returns { minted_activity_id, output_shapes, tasks } or a structuredError.
 *
 * The caller (goal-host recovery loop) then DISPATCHES the minted composite and
 * runs the reach-gate; reached:true keeps it (ribosome + goal_execution_paths
 * record it as a durable new capability), reached:false β-penalises it. This
 * resolver does NOT execute — it only authors. Execution + the reach verdict are
 * the goal-host's job (one-shot, bounded by authoringTried). Strictly additive:
 * it only fires AFTER author_producer wrap-single fails and never changes the
 * happy path.
 *
 * Robust by construction: discovery failure, LLM failure, malformed JSON, a plan
 * referencing unknown ids, or a failed mint all degrade to a structuredError
 * rather than throwing — never worse than today's escalate/stop.
 */

import { resolveLlmCompletionDispatch } from "./llm-completion-dispatch.js";
import { resolveActivityCreateVariant } from "./activity-create-variant.js";
import { DISCOVERY_ENDPOINT, METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface AuthorComposedCapabilityPointer {
  type: "author_composed_capability";
  /** The operator goal this capability must reach. */
  goal: string;
  /** The completion-state shapes the goal needs produced (from the reach-gate). */
  target_shapes?: string[];
  /** Shapes already present in the pool the chain may consume. */
  available_shapes?: string[];
  /** Max LLM planning attempts before giving up. Defaults to 2. */
  max_attempts?: number;
}

function structuredError(detail: string, extra?: Record<string, unknown>): ResolverResult {
  return { shape: "structuredError", body: { resolver: "author_composed_capability", error: detail, ...(extra ?? {}) } };
}

/**
 * A curated description of the activity-api DATA resolvers most useful for
 * composing operator report/aggregate capabilities, plus the canonical LLM
 * formatter. These are real, live shapes (verified advertised by discovery); the
 * descriptions teach the LLM their pointer contracts so the planned config binds
 * correctly. We pair this with the full discovery catalogue (for id validation)
 * so the planner can also reach shapes not described here.
 */
const CURATED_RESOLVER_HINTS: Array<{ shape: string; produces_shape: string; produces: string; how: string }> = [
  {
    // THE PREFERRED DATA RESOLVER for report/ranking/sum goals. Computes the
    // GROUP BY / COUNT / SUM server-side over the indexed trace table and returns
    // a SMALL, already-aggregated result — fast (~1s) and load-robust. Use this
    // for ANY goal about counts / rankings / totals grouped by template, status,
    // or variant over a time window. It REPLACES the raw-trace scan for these.
    shape: "traceAggregateReport",
    produces_shape: "traceAggregateReport",
    produces:
      "ALREADY-AGGREGATED rows {key,value} computed in the database: failure/success/total counts or cost sums, grouped by activity template (activity_id), status, or variant, over a time window, sorted highest-first. The DIRECT answer to report/ranking/sum goals — no raw rows shipped to the LLM.",
    how:
      `config { "type":"traceAggregateReport", "group_by":"activity_id"|"status"|"variant_id", "metric":"failure_count"|"success_count"|"count"|"cost_sum", "window_hours":24, "limit":10, "order":"desc" }. ` +
      `e.g. "5 templates with most failures in 24h" → group_by:"activity_id", metric:"failure_count", window_hours:24, limit:5. ` +
      `"total cost by status this week" → group_by:"status", metric:"cost_sum", window_hours:168. ` +
      `Returns { rows:[{key,value}], empty }. The format step renders rows directly.`,
  },
  {
    shape: "executionTraceWithSignatures",
    produces_shape: "executionTraceWithSignatures",
    produces:
      "RAW hydrated execution traces (per-trace activity_id, status, per-task signatures). SLOW + LOAD-FRAGILE over the large trace table — use ONLY when the goal needs PER-TRACE detail that an aggregate cannot give (e.g. inspecting specific task signatures), NOT for counts/rankings/sums. For any aggregate/report goal, use traceAggregateReport instead.",
    how: `config { "type":"executionTraceWithSignatures", "limit":200 } — capped hard; only for per-trace detail, never for aggregation.`,
  },
  {
    shape: "trace_recurring_pattern_scan",
    produces_shape: "recurringPatternCluster",
    produces: "clusters of recurring failure signatures across recent traces (which templates/tasks recur as failures)",
    how: `config { "type":"trace_recurring_pattern_scan", "limit":200 } — fast aggregator of recurring failure PATTERNS (use when the goal asks about recurring/clustered failures, not simple counts).`,
  },
  {
    // THE PREFERRED RESOLVER for orphan/coverage goals — "shapes consumed as input
    // with no producer", "producer/consumer coverage gaps", "unconnected shapes".
    // Computes the set-difference server-side and returns the answer directly.
    shape: "composition_coverage_report",
    produces_shape: "composition_coverage_report",
    produces:
      "ALREADY-COMPUTED coverage gaps: missing_input_shapes (shapes some activity CONSUMES as input but NOTHING produces, with the consuming activities), orphan_producers (output shapes with no consumer), unconnected_pairs. The DIRECT answer to any orphan/coverage/'consumed-but-unproduced'/'no producer' goal — do NOT scan raw traces or run a pattern detector for these.",
    how: `config { "type":"composition_coverage_report" }. Returns { missing_input_shapes:[{shape,consumers}], orphan_producers, unconnected_pairs }. The format step renders it directly.`,
  },
  {
    shape: "orphaned_capability_scan",
    produces_shape: "orphaned_capability_scan",
    produces: "advertised OUTWARD capabilities (shapes) that have NO producer activity — the demand-driven orphan set. Use for 'which advertised capabilities/shapes are unbacked/orphaned' goals.",
    how: `config { "type":"orphaned_capability_scan" }. Returns the orphaned capability list. Pair with composition_coverage_report for input-consumption orphans.`,
  },
  {
    shape: "llm_completion_dispatch",
    produces_shape: "llm_completion_result",
    produces: "the formatted report text",
    how: `config { "type":"llm_completion_dispatch", "prompt":"Format ... from this data: {{impulse:<upstream_slot>}}", "max_tokens":1500 } — the FORMAT/REPORT step. Bind the upstream data task's output slot into the prompt.`,
  },
];

/** Fetch the full live shape catalogue from discovery for id validation. Cached briefly. */
let _catalogueCache: { shapes: Set<string>; at: number } | null = null;
const CATALOGUE_TTL_MS = 60_000;
async function fetchCatalogue(): Promise<Set<string>> {
  const now = Date.now();
  if (_catalogueCache && now - _catalogueCache.at < CATALOGUE_TTL_MS) return _catalogueCache.shapes;
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT.replace(/\/$/, "")}/registry/shapes`, {
      method: "GET",
      headers: { ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return _catalogueCache?.shapes ?? new Set<string>();
    const j: any = await r.json();
    const shapes = new Set<string>((Array.isArray(j?.shapes) ? j.shapes : []).map((s: unknown) => String(s)).filter(Boolean));
    if (shapes.size > 0) _catalogueCache = { shapes, at: now };
    return shapes;
  } catch {
    return _catalogueCache?.shapes ?? new Set<string>();
  }
}

/**
 * Fetch the merged shape→description catalogue from discovery (the
 * resolver-DESCRIPTION advertisement, 2026-06-28). This is THE generality
 * lever: every vessel advertises a one-line description per shape it owns, so
 * the planner can compose ANY described resolver WITHOUT a hand-written hint.
 * Cached briefly like fetchCatalogue. Discovery failure → empty map (planner
 * falls back to curated-only). (2026-06-28)
 */
let _descCache: { descriptions: Record<string, string>; at: number } | null = null;
async function fetchShapeDescriptions(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_descCache && now - _descCache.at < CATALOGUE_TTL_MS) return _descCache.descriptions;
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT.replace(/\/$/, "")}/registry/shape-descriptions`, {
      method: "GET",
      headers: { ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return _descCache?.descriptions ?? {};
    const j: any = await r.json();
    const raw = j?.shape_descriptions;
    const descriptions: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [shape, desc] of Object.entries(raw)) {
        if (typeof desc === "string" && desc.trim().length > 0) descriptions[shape] = desc.trim();
      }
    }
    if (Object.keys(descriptions).length > 0) _descCache = { descriptions, at: now };
    return descriptions;
  } catch {
    return _descCache?.descriptions ?? {};
  }
}

/**
 * A resolver-catalogue entry the planner shows the LLM: each is a shape id with
 * a one-line "produces" description and a "how"/config hint. Built from the
 * UNION of CURATED_RESOLVER_HINTS (richer `how`, OVERRIDE on conflict) and every
 * advertised shape that carries a description. This is what eliminates the
 * per-class hint treadmill: a purpose-built resolver becomes planner-matchable
 * the moment its owning vessel advertises a description for it. (2026-06-28)
 */
interface CatalogueEntry { shape: string; produces_shape: string; produces: string; how: string }

/**
 * Build the planner's resolver catalogue from advertised descriptions + curated
 * hints. Curated hints OVERRIDE descriptions on conflict (they carry richer
 * config detail). Every other described shape becomes an entry whose `produces`
 * is the advertised description and whose `how` points the LLM at the canonical
 * `config { type:'<shape>' }` form. Excludes shapes already covered by a curated
 * hint. Sorted: curated first, then described, for prompt stability.
 */
function buildResolverCatalogue(descriptions: Record<string, string>): CatalogueEntry[] {
  const curatedShapes = new Set(CURATED_RESOLVER_HINTS.map((h) => h.shape));
  const entries: CatalogueEntry[] = CURATED_RESOLVER_HINTS.map((h) => ({
    shape: h.shape,
    produces_shape: h.produces_shape,
    produces: h.produces,
    how: h.how,
  }));
  for (const [shape, desc] of Object.entries(descriptions)) {
    if (curatedShapes.has(shape)) continue; // curated hint OVERRIDES
    // Skip pure write/mutation + obviously-non-data resolvers that a report
    // chain never composes as a data step. Heuristic, not a hard list — keep
    // it conservative so we don't silently hide a genuinely useful resolver.
    if (/_write$|_delete$|_deprecate$|^vessel_register|^systemd_/.test(shape)) continue;
    entries.push({
      shape,
      produces_shape: shape,
      produces: desc,
      how: `config { "type":"${shape}" } — see the discovery advertisement for this shape. Add any pointer fields the description implies; bind upstream data with {{impulse:<slot>}} when this is a format step.`,
    });
  }
  return entries;
}

/** Extract the first balanced JSON value (object or array) from a fenced/prose LLM reply. */
function extractJson(text: string): unknown | null {
  const raw = text.replace(/^```(?:json)?\n?/i, "").trimStart();
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  if (startObj < 0) start = startArr;
  else if (startArr < 0) start = startObj;
  else start = Math.min(startObj, startArr);
  if (start < 0) return null;
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === "\\") { esc = true; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

interface PlannedTask {
  id: string;
  description?: string;
  resolver: string;
  config: Record<string, unknown>;
  input_shapes?: string[];
  output_shapes?: string[];
  outputImpulses?: string[];
  inputImpulses?: string[];
  dependencies?: string[];
}

function buildPlanPrompt(
  p: AuthorComposedCapabilityPointer,
  deliverable: string,
  catalogueEntries: CatalogueEntry[],
): string {
  const hints = catalogueEntries.map(
    (h) => `- resolver "${h.shape}" → output_shapes:["${h.produces_shape}"]\n    produces: ${h.produces}\n    use: ${h.how}`,
  ).join("\n");
  return (
    `You are PLANNING a short chain of EXISTING resolvers that, run in order, REACHES an operator goal.\n` +
    `No single resolver produces the goal's output, so you must COMPOSE existing ones (e.g. query data, then format it).\n\n` +
    `GOAL: ${p.goal}\n` +
    (p.target_shapes?.length ? `TARGET COMPLETION SHAPES (what "reached" means): ${p.target_shapes.join(", ")}\n` : "") +
    (p.available_shapes?.length ? `ALREADY-AVAILABLE POOL SHAPES (you may consume these): ${p.available_shapes.join(", ")}\n` : "") +
    `\nUSEFUL EXISTING RESOLVERS (the "resolver" field of a task MUST be one of these shape ids, exactly):\n${hints}\n\n` +
    `PLANNING RULES:\n` +
    `1. Typically TWO tasks: (a) a DATA task that queries the real data the goal needs, (b) an llm_completion_dispatch task that FORMATS that data into the exact output the goal asks for.\n` +
    `2. The format task binds the data task's output by referencing {{impulse:<data_task_slot>}} inside its prompt, where <data_task_slot> is the data task's outputImpulses[0].\n` +
    `3. Use ONLY resolver ids from the list above. Do NOT invent resolver names. Do NOT use file/git/bash resolvers.\n` +
    `4. PREFER THE AGGREGATE RESOLVER over a raw-trace scan whenever the goal asks for COUNTS, RANKINGS, TOTALS, or SUMS grouped by template/status/variant over a window (every "top N", "highest", "total", "how many", "per template/tier/status" report goal). Use "traceAggregateReport" as the data task — it computes the GROUP BY in the database (fast, ~1s) and returns already-aggregated {key,value} rows. Do NOT use "executionTraceWithSignatures" to fetch raw traces and count them in the LLM: that raw scan TIMES OUT over the large trace table and the report comes back empty. e.g. "5 templates with the highest failure counts in 24h" → traceAggregateReport group_by:"activity_id", metric:"failure_count", window_hours:24, limit:5. Only use executionTraceWithSignatures when the goal genuinely needs per-trace detail an aggregate cannot provide.\n` +
    `5. The final task's output is the goal's deliverable; its prompt must instruct the LLM to emit EXACTLY the requested format (e.g. "5 lines, each '<template_id>  <failure_count>', sorted descending"). Set the final task's "output_shapes" to ["${deliverable}"].\n\n` +
    `Return STRICT JSON: an ordered array of tasks, each:\n` +
    `{\n` +
    `  "id": "<short_id>",\n` +
    `  "description": "<what this task does>",\n` +
    `  "resolver": "<one of the resolver shape ids above>",\n` +
    `  "config": { "type": "<same resolver id>", ...pointer fields... },\n` +
    `  "output_shapes": ["<shape the resolver produces>"],\n` +
    `  "outputImpulses": ["<slot_name>"],\n` +
    `  "dependencies": ["<id of a task whose output this consumes>"]\n` +
    `}\n` +
    `Output ONLY the JSON array. No prose, no markdown fences.`
  );
}

/**
 * Derive a goal-specific DELIVERABLE shape name for the composite's final output.
 * A formatter task naturally produces the generic `llm_completion_result`, which
 * makes reuse-before-mint collapse every report composite into one. Naming the
 * deliverable after the goal's target (or a goal slug) gives each composed
 * capability a distinct reuse key — so reuse fires only on a TRULY equivalent
 * prior capability, not on "anything that ends in an LLM format step". (2026-06-27)
 */
function deliverableShape(goal: string, targetShapes?: string[]): string {
  const fromTarget = (targetShapes ?? []).find(
    (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && s !== "report" && s !== "llm_completion_result",
  );
  if (fromTarget) return fromTarget;
  const slug = goal.replace(/[^a-zA-Z0-9]+/g, "_").replace(/(^_+|_+$)/g, "").toLowerCase().slice(0, 40) || "deliverable";
  return `composedDeliverable_${slug}`;
}

/**
 * Heuristic: is this an AGGREGATE/report goal — one asking for counts, rankings,
 * totals, or sums grouped over a window? Such goals must use the server-side
 * aggregate resolver (traceAggregateReport), not a raw-trace scan. (2026-06-27)
 */
function isAggregateGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  // Verbs / nouns of aggregation, ranking, and reporting over traces.
  const aggSignals =
    /\b(count|counts|number of|how many|total|totals|sum|sums|aggregate|average|avg|tally)\b/.test(g) ||
    /\b(top \d+|highest|lowest|most|least|ranked|ranking|sorted|descending|ascending|leaderboard)\b/.test(g) ||
    /\b(grouped by|per (template|tier|status|resolver|activity|variant)|by (template|tier|status|resolver|activity|variant))\b/.test(g);
  const reportSignals = /\b(report|failure|failed|failing|cost|costs|execution|executions|success rate)\b/.test(g);
  return aggSignals && reportSignals;
}

/** Heuristic: does a resolver response carry substantive (non-empty, non-error) data? */
function hasSubstance(body: unknown): boolean {
  if (body == null) return false;
  const b = body as Record<string, unknown>;
  if (b["success"] === false || b["error"] || b["shape"] === "structuredError") return false;
  let v: unknown = b["body"] ?? b["content"] ?? b;
  if (typeof v === "string") { const t = v.trim(); if (t.startsWith("{") || t.startsWith("[")) { try { v = JSON.parse(t); } catch { return t.length > 0; } } else return t.length > 0; }
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * EXECUTE-VALIDATE a planned DATA task by invoking its resolver against the
 * vessel that owns it (via discovery), with a short timeout. Returns ok=false +
 * the error/empty reason when the resolver errors, hangs, or returns nothing — so
 * the planner refines onto a WORKING resolver instead of authoring a structurally
 * valid but un-runnable chain (the lesson from the broken /execution-traces
 * endpoint). llm_completion_dispatch tasks are skipped (always runnable; their
 * input is bound at execution time). (2026-06-27)
 */
async function validateDataTask(task: PlannedTask): Promise<{ ok: boolean; reason: string }> {
    if (
    task.resolver === "llm_completion_dispatch" ||
    task.resolver === "source_code" ||
    task.resolver === "sourceCode" ||
    task.resolver === "fileContent" ||
    task.resolver === "fileWriteResult" ||
    task.resolver === "fs_edit" ||
    task.resolver === "fileEditResult" ||
    task.resolver === "codeTypecheckResult"
  ) {
    return { ok: true, reason: "" };
  }
  // Discover the owning vessel's resolve endpoint, fall back to known vessels.
  const endpoints: string[] = [];
  try {
    const dres = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: task.resolver } }),
      signal: AbortSignal.timeout(8000),
    });
    if (dres.ok) {
      const dj: any = await dres.json();
      const vessels = dj?.content?.vessels ?? dj?.vessels ?? [];
      for (const vv of vessels) {
        const base = String(vv?.endpoint ?? "").replace(/\/$/, "");
        const route = String(vv?.resolve_endpoint ?? "/v2/impulses/resolve");
        if (base) endpoints.push(route.startsWith("http") ? route : `${base}${route.startsWith("/") ? route : `/${route}`}`);
      }
    }
  } catch { /* discovery flaky → fall back */ }
  for (const fb of ["http://127.0.0.1:8090/v2/impulses/resolve", "http://127.0.0.1:8080/v2/impulses/resolve"]) {
    if (!endpoints.includes(fb)) endpoints.push(fb);
  }
  // Build a concrete test pointer from the planned config, dropping {{...}} fields
  // (no upstream at validation time) so the resolver runs on its own defaults.
  const testPointer: Record<string, unknown> = { type: task.resolver };
  for (const [k, val] of Object.entries(task.config)) {
    if (k === "type") continue;
    if (typeof val === "string" && val.includes("{{")) continue;
    testPointer[k] = val;
  }
  let lastReason = "no endpoint responded";
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
        body: JSON.stringify({ impulse: { type: task.resolver, pointer: testPointer } }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.status === 404) { lastReason = `${ep} 404 (does not serve ${task.resolver})`; continue; }
      const body = await r.json().catch(() => null);
      if (!r.ok) { lastReason = `${task.resolver} HTTP ${r.status}`; continue; }
      if (hasSubstance(body)) return { ok: true, reason: "" };
      lastReason = `${task.resolver} returned no substantive data (empty/error)`;
      // A 2xx with no substance is the resolver's verdict — don't keep probing other bases.
      return { ok: false, reason: lastReason };
    } catch (e) {
      lastReason = `${task.resolver} failed to execute: ${(e as Error).message}`;
    }
  }
  return { ok: false, reason: lastReason };
}

/** Validate + normalise the planned tasks. Returns null with a reason on rejection. */
function coercePlan(
  raw: unknown,
  catalogue: Set<string>,
  deliverable: string,
): { tasks: PlannedTask[]; outputShapes: string[] } | { error: string } {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["tasks"])
      ? ((raw as Record<string, unknown>)["tasks"] as unknown[])
      : null;
  if (!arr || arr.length === 0) return { error: "plan was empty or not an array of tasks" };
  const known = new Set([...catalogue, ...CURATED_RESOLVER_HINTS.map((h) => h.shape)]);
  const tasks: PlannedTask[] = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (!t || typeof t !== "object") return { error: `task[${i}] is not an object` };
    const o = t as Record<string, unknown>;
    const resolver = String(o["resolver"] ?? "");
    if (!resolver) return { error: `task[${i}] missing resolver` };
    if (!known.has(resolver)) {
      return { error: `task[${i}] references unknown resolver "${resolver}" (not in the live catalogue) — hallucinated id rejected` };
    }
    const config = (o["config"] && typeof o["config"] === "object" ? (o["config"] as Record<string, unknown>) : {}) as Record<string, unknown>;
    config["type"] = resolver; // guarantee the dispatched shape matches
    // Cap heavy trace fetches so the data step stays under the engine's task
    // timeout (executionTraceWithSignatures at limit>200 can take 30s+). (2026-06-27)
    if (resolver === "executionTraceWithSignatures") {
      const lim = typeof config["limit"] === "number" ? (config["limit"] as number) : 200;
      config["limit"] = Math.min(lim, 200);
    }
    const id = String(o["id"] ?? `task_${i}`);
    // Sanitize declared output shapes: keep identifier-like shape names only,
    // drop any free-text description the LLM copied from the hint's "produces"
    // line (e.g. "aggregated failure patterns grouped by ..."). Such prose
    // pollutes declared shapes and the reuse-before-mint match. Fall back to the
    // resolver's canonical produced_shape, else the resolver id.
    const canonicalOut = CURATED_RESOLVER_HINTS.find((h) => h.shape === resolver)?.produces_shape ?? resolver;
    const rawOut = Array.isArray(o["output_shapes"])
      ? (o["output_shapes"] as unknown[]).map(String)
      : Array.isArray(o["outputShapes"]) ? (o["outputShapes"] as unknown[]).map(String) : [];
    const cleanOut = rawOut.filter((s) => /^[A-Za-z_][A-Za-z0-9_:.]*$/.test(s) && !s.includes(" "));
    const outputShapes = cleanOut.length ? cleanOut : [canonicalOut];
    const outputImpulses = Array.isArray(o["outputImpulses"]) ? (o["outputImpulses"] as unknown[]).map(String) : [`${id}_out`];
    const dependencies = Array.isArray(o["dependencies"]) ? (o["dependencies"] as unknown[]).map(String) : undefined;
    const inputShapes = Array.isArray(o["input_shapes"])
      ? (o["input_shapes"] as unknown[]).map(String)
      : Array.isArray(o["inputShapes"]) ? (o["inputShapes"] as unknown[]).map(String) : [];
    tasks.push({
      id,
      description: typeof o["description"] === "string" ? (o["description"] as string) : `Run ${resolver}.`,
      resolver,
      config,
      input_shapes: inputShapes,
      output_shapes: outputShapes,
      outputImpulses,
      dependencies,
    });
  }
  // The composite's DECLARED output shapes = ONLY the FINAL task's output (the
  // deliverable), NOT the intermediate query shapes. Declaring intermediates
  // (e.g. trace_failure_pattern_report) would make reuse-before-mint match any
  // template that merely produces that intermediate, falsely collapsing distinct
  // composites. The reach-gate judges from actual produced content regardless, so
  // narrowing the DECLARED shapes to the deliverable is both correct and the right
  // reuse key. (2026-06-27)
  // Force the FINAL task's declared output to the goal-specific deliverable shape
  // (so the composite's reuse key is unique to this goal, not the generic LLM
  // shape). The format task still runs llm_completion_dispatch; only its DECLARED
  // output shape is renamed to the deliverable.
  const finalTask = tasks[tasks.length - 1];
  if (finalTask) {
    finalTask.output_shapes = [deliverable];
    // ENFORCE THE INTER-TASK BINDING. The whole point of decomposition is that the
    // format step CONSUMES the data step's output — but the LLM routinely writes
    // "analyze the data provided" WITHOUT the {{impulse:<slot>}} placeholder, so
    // the engine injects nothing and the formatter sees no data (→ hollow). Make
    // it deterministic: if the final llm task's prompt doesn't already reference an
    // upstream slot, APPEND the upstream data task's output slot binding so the
    // data genuinely flows into the prompt. (2026-06-27)
    if (finalTask.resolver === "llm_completion_dispatch" && tasks.length >= 2) {
      const upstream = tasks[tasks.length - 2];
      const slot = upstream?.outputImpulses?.[0] ?? `${upstream?.id ?? "data"}_out`;
      const cfg = finalTask.config;
      const promptStr = typeof cfg["prompt"] === "string" ? (cfg["prompt"] as string) : "";
      if (!/\{\{impulse:/.test(promptStr)) {
        cfg["prompt"] = `${promptStr}\n\nDATA (from the upstream step):\n{{impulse:${slot}}}`;
      }
      // Make the dependency + input wiring explicit so the engine schedules + binds.
      if (upstream) {
        finalTask.dependencies = [...new Set([...(finalTask.dependencies ?? []), upstream.id])];
        finalTask.input_shapes = [...new Set([...(finalTask.input_shapes ?? []), ...(upstream.output_shapes ?? [])])];
        finalTask.inputImpulses = [...new Set([...(finalTask.inputImpulses ?? []), slot])];
      }
    }
  }
  const outputShapes = [deliverable];
  return { tasks, outputShapes };
}

export async function resolveAuthorComposedCapability(
  pointer: AuthorComposedCapabilityPointer,
): Promise<ResolverResult> {
  const goal = pointer.goal;
  if (!goal || typeof goal !== "string") {
    return structuredError("author_composed_capability requires pointer.goal");
  }
  const maxAttempts = Math.max(1, pointer.max_attempts ?? 2);
  // Fetch the id catalogue (for hallucination rejection) AND the merged
  // shape→description catalogue (the generality lever). The planner now sees
  // EVERY described resolver, not just the 6 curated ones. Discovery failure on
  // descriptions → empty map → buildResolverCatalogue degrades to curated-only.
  const [catalogue, descriptions] = await Promise.all([fetchCatalogue(), fetchShapeDescriptions()]);
  const catalogueEntries = buildResolverCatalogue(descriptions);
  const deliverable = deliverableShape(goal, pointer.target_shapes);

  let plan: { tasks: PlannedTask[]; outputShapes: string[] } | null = null;
  let lastError = "no attempt produced a valid plan";
  let attempts = 0;
  let priorError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const prompt =
      buildPlanPrompt(pointer, deliverable, catalogueEntries) +
      (priorError ? `\n\nPREVIOUS PLAN WAS REJECTED: ${priorError}\nFix it — use only real resolver ids and keep the chain short.` : "");
    const llm = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt, max_tokens: 1800 });
    if (llm.shape !== "llm_completion_result") {
      const b = llm.body as { detail?: string } | undefined;
      lastError = `LLM planning failed: ${b?.detail ?? "no completion"}`;
      priorError = lastError;
      continue;
    }
    const text = String((llm.body as { text?: unknown })?.text ?? "");
    const parsed = extractJson(text);
    if (parsed == null) {
      lastError = "LLM did not return parseable JSON plan";
      priorError = lastError;
      continue;
    }
    const coerced = coercePlan(parsed, catalogue, deliverable);
    if ("error" in coerced) {
      lastError = coerced.error;
      priorError = lastError;
      continue;
    }
    // AGGREGATE-GOAL GUARDRAIL (2026-06-27): if the goal asks for counts /
    // rankings / totals / sums (an aggregate report) but the planned data step is
    // the KNOWN-SLOW raw-trace scan (executionTraceWithSignatures), reject the
    // plan so the planner refines onto the fast server-side aggregate
    // (traceAggregateReport). This is the binding fix for the hollow report class:
    // the raw scan times out over the large trace table, so a plan that uses it
    // for an aggregate goal is un-runnable in practice even though it's
    // structurally valid. traceAggregateReport answers these directly in ~1s.
    if (isAggregateGoal(goal) && coerced.tasks.some((t) => t.resolver === "executionTraceWithSignatures")) {
      lastError =
        "this is an AGGREGATE/report goal (counts/ranking/totals over a window) but the data step uses the slow raw-trace scan executionTraceWithSignatures, which times out. Use \"traceAggregateReport\" as the data task instead (group_by + metric: failure_count/success_count/count/cost_sum + window_hours + limit) — it computes the aggregate in the database.";
      priorError = lastError;
      continue;
    }
    // EXECUTE-VALIDATE the DATA tasks: invoke each non-llm resolver to confirm it
    // actually returns substantive data right now. A structurally valid plan whose
    // data resolver is broken (hangs / errors / empty) would author an un-runnable
    // composite and only fail at reach-gate. Catch it here so the planner refines
    // onto a WORKING resolver. (2026-06-27)
    let dataValid = true;
    let dataReason = "";
    for (const t of coerced.tasks) {
      const v = await validateDataTask(t);
      if (!v.ok) { dataValid = false; dataReason = v.reason; break; }
    }
    if (!dataValid) {
      lastError = `planned data task could not produce data: ${dataReason}. Choose a DIFFERENT data resolver that returns real data now.`;
      priorError = lastError;
      continue;
    }
    plan = coerced;
    break;
  }

  if (!plan) {
    return structuredError(`author_composed_capability: could not plan a valid chain of existing resolvers`, {
      last_error: lastError,
      attempts,
    });
  }

  // AUTHOR the composite template. resolver = the shape id (the ias-executor
  // engine dispatches a task by its `resolver` field — for a data/format resolver
  // shape it routes through discovery to the owning vessel; for llm_completion_dispatch
  // through llm-resolver-vessel). Bindings between tasks use {{impulse:<slot>}}.
  const slug = goal.replace(/[^a-zA-Z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").toLowerCase().slice(0, 40) || "goal";
  const template = {
    // Deterministic id (no timestamp) so re-authoring the SAME goal UPSERTs one
    // template rather than spawning duplicates — matches the ribosome's
    // learned-<slug> idempotency lesson.
    id: `composed-cap-${slug}`,
    name: `composed-capability:${slug}`,
    description:
      `Auto-authored COMPOSED capability for goal: "${goal.slice(0, 160)}". ` +
      `Chains existing resolvers [${plan.tasks.map((t) => t.resolver).join(" → ")}] to produce a deliverable no single resolver produces. ` +
      `Authored by author_composed_capability (decomposition-based authoring).`,
    input_shapes: [...new Set(plan.tasks.flatMap((t) => t.input_shapes ?? []))],
    inputShapes: [...new Set(plan.tasks.flatMap((t) => t.input_shapes ?? []))],
    output_shapes: plan.outputShapes,
    outputShapes: plan.outputShapes,
    tags: ["composed_capability", "improvise", "horizon:walk"],
    variables: [],
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      resolver: t.resolver,
      config: t.config,
      ...(t.dependencies ? { dependencies: t.dependencies } : {}),
      input_shapes: t.input_shapes ?? [],
      inputShapes: t.input_shapes ?? [],
      output_shapes: t.output_shapes ?? [],
      outputShapes: t.output_shapes ?? [],
      outputImpulses: t.outputImpulses ?? [],
      ...(t.inputImpulses && t.inputImpulses.length ? { inputImpulses: t.inputImpulses } : {}),
    })),
    proposed: false,
    org_id: "organizations:substrate",
  };

  const mintResult = await resolveActivityCreateVariant({ type: "activity_create_variant", template });
  if (mintResult.shape !== "activityRegistryChange") {
    const b = mintResult.body as {
      detail?: string;
      failure_mode?: string;
      existing_producer_id?: string;
    } | undefined;
    // REUSE-BEFORE-MINT (enforce) refused because an existing composite already
    // produces this goal's shapes. That is a REUSE SUCCESS, not a failure: return
    // the existing producer so the caller targets it (route flow onto the existing
    // hyperedge instead of minting a duplicate). Faithful to the "Reuse Before
    // Minting" principle — the substrate already HAS this composed capability.
    if (b?.failure_mode === "reuse_existing_producer" && b.existing_producer_id) {
      return {
        shape: "author_composed_capability",
        body: {
          minted_activity_id: b.existing_producer_id,
          output_shapes: plan.outputShapes,
          tasks: plan.tasks.map((t) => ({ id: t.id, resolver: t.resolver, output_shapes: t.output_shapes })),
          task_count: plan.tasks.length,
          attempts,
          validated: true,
          reused_existing: true,
        },
      };
    }
    return structuredError(`mint failed: ${b?.detail ?? "activity_create_variant rejected the composite"}`, {
      mint_failure_mode: b?.failure_mode,
      planned_tasks: plan.tasks.map((t) => t.resolver),
    });
  }
  const variantId = String((mintResult.body as { variantId?: unknown })?.variantId ?? template.id);

  return {
    shape: "author_composed_capability",
    body: {
      minted_activity_id: variantId,
      output_shapes: plan.outputShapes,
      tasks: plan.tasks.map((t) => ({ id: t.id, resolver: t.resolver, output_shapes: t.output_shapes })),
      task_count: plan.tasks.length,
      attempts,
      validated: true,
    },
  };
}

// METABOB_ENDPOINT is imported for parity with author_producer's module surface
// (future variants may fetch template metadata for richer planning); referenced
// here to keep the import meaningful without a side effect.
void METABOB_ENDPOINT;
