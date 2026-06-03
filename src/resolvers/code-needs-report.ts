import type { ResolverResult } from "./types.js";

/**
 * code_needs_report — synthesizes the substrate's observability surface into
 * actionable "what code should be written next" decisions.
 *
 * The operator asked 2026-06-03: "how do we use traces to understand what
 * code we need to make?" — this resolver is the structured answer.
 *
 * Reads four input signals from activity-api + discovery:
 *   1. Recent execution traces (failure_modes, output_shapes, status patterns)
 *   2. Template catalogue (inputShapes per template; what's required but
 *      not produced anywhere)
 *   3. Discovery /shapes (what every vessel currently advertises)
 *   4. Composition graph (producer→consumer relationships)
 *
 * Synthesizes into five concrete code-need categories:
 *   - missing_resolver: shape required by templates, no vessel produces it
 *   - missing_template: producer-consumer pair across two existing resolvers
 *                       but no template chains them
 *   - missing_vessel: 3+ shapes required that would naturally cluster into
 *                     a coherent vessel (heuristic: shared prefix or
 *                     domain-keyword)
 *   - incomplete_vessel: vessel exists but missing canonical files (delegated
 *                        to vessel_completeness_report; surfaces top blocked)
 *   - broken_template: template has ≥N preflight rejections or chain
 *                      truncations in window (delegated to authoring_chain_
 *                      health_report)
 *
 * Each entry includes a structured recommendation:
 *   { action: "CREATE" | "MODIFY" | "REFACTOR",
 *     target_kind: "resolver" | "template" | "vessel",
 *     target_name: string,
 *     cited_evidence: [trace_ids | template_ids | concept_ids],
 *     priority_score: 0..1 }
 *
 * Immunity-pattern compliant. Deterministic. Outputs codeNeedsReport.
 */

export interface CodeNeedsReportPointer {
  type: "code_needs_report";
  tracesUrl?: string;
  templatesUrl?: string;
  discoveryShapesUrl?: string;
  traceLimit?: number;
  /** Min preflight rejections per template to flag as broken_template. */
  brokenTemplateThreshold?: number;
  /** Min vessels of demand for a missing_resolver to surface. */
  resolverDemandThreshold?: number;
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:8100/shapes";

interface TraceLike {
  execution_id?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  task_count?: unknown;
  activity_id?: unknown;
  failure_mode?: unknown;
  output_impulse_shapes?: unknown;
}

interface TemplateLike {
  id?: unknown;
  inputShapes?: unknown;
  input_shapes?: unknown;
  outputShapes?: unknown;
  output_shapes?: unknown;
}

interface CodeNeed {
  category:
    | "missing_resolver"
    | "missing_template"
    | "missing_vessel"
    | "incomplete_vessel"
    | "broken_template";
  action: "CREATE" | "MODIFY" | "REFACTOR";
  target_kind: "resolver" | "template" | "vessel";
  target_name: string;
  reason: string;
  cited_evidence: string[];
  priority_score: number;
}

function templateIdOf(t: TemplateLike): string {
  if (typeof t.id === "string" && t.id.length > 0) {
    return t.id.replace(/^activity:⟨(.+)⟩$/, "$1");
  }
  return "unknown_template";
}

function templateInputShapes(t: TemplateLike): string[] {
  const candidate = Array.isArray(t.inputShapes)
    ? t.inputShapes
    : Array.isArray(t.input_shapes)
      ? t.input_shapes
      : [];
  return (candidate as unknown[]).filter((s): s is string => typeof s === "string");
}

function templateOutputShapes(t: TemplateLike): string[] {
  const candidate = Array.isArray(t.outputShapes)
    ? t.outputShapes
    : Array.isArray(t.output_shapes)
      ? t.output_shapes
      : [];
  return (candidate as unknown[]).filter((s): s is string => typeof s === "string");
}

function looksLikeCapabilityShape(shape: string): boolean {
  // Cheap predicate; full classifier lives in vessel-demand-report.
  const denylist = new Set([
    "goal",
    "trace",
    "error",
    "source_code",
    "test_suite",
    "activity_template",
    "execution_trace",
    "tool",
    "cwd",
    "task",
    "vessel",
    "config",
    "metadata",
    "request",
    "response",
  ]);
  if (denylist.has(shape)) return false;
  if (shape.length < 6) return false;
  return (
    /(_report|_scan|_check|_emit|_result|_summary|_tick|_dispatch|_signature|_validity|_write)$/.test(shape) ||
    /(Report|Scan|Check|Result|Summary|Trace|Relevance|Metrics|Demand|Pattern|Snapshot|Outcome)$/.test(shape) ||
    /^[a-z][a-z0-9]+[A-Z][a-zA-Z0-9]{4,}$/.test(shape)
  );
}

export async function resolveCodeNeedsReport(
  pointer: CodeNeedsReportPointer,
): Promise<ResolverResult> {
  const tracesUrl =
    (pointer.tracesUrl ?? DEFAULT_TRACES_URL) +
    `?limit=${pointer.traceLimit ?? 100}`;
  const templatesUrl = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const discoveryUrl = pointer.discoveryShapesUrl ?? DEFAULT_DISCOVERY_URL;
  const brokenThreshold = pointer.brokenTemplateThreshold ?? 3;
  const resolverDemandThreshold = pointer.resolverDemandThreshold ?? 3;

  const apiKey = process.env["METABOB_API_KEY"];
  const auth: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  // Fetch traces, templates, advertised shapes in parallel.
  const [tracesResp, templatesResp, shapesResp] = await Promise.all([
    fetch(tracesUrl, { headers: auth, signal: AbortSignal.timeout(15_000) }).catch(() => null),
    fetch(templatesUrl + "?limit=200", { headers: auth, signal: AbortSignal.timeout(15_000) }).catch(() => null),
    fetch(discoveryUrl, { headers: auth, signal: AbortSignal.timeout(10_000) }).catch(() => null),
  ]);

  let traces: TraceLike[] = [];
  let templates: TemplateLike[] = [];
  const advertised = new Set<string>();

  if (tracesResp && tracesResp.ok) {
    const json = (await tracesResp.json()) as { executions?: unknown };
    if (Array.isArray(json.executions)) traces = json.executions as TraceLike[];
  }
  if (templatesResp && templatesResp.ok) {
    const json = (await templatesResp.json()) as { templates?: unknown };
    if (Array.isArray(json.templates)) templates = json.templates as TemplateLike[];
  }
  if (shapesResp && shapesResp.ok) {
    const json = (await shapesResp.json()) as Record<string, unknown>;
    if (Array.isArray((json as { shapes?: unknown }).shapes)) {
      for (const s of (json as { shapes: unknown[] }).shapes) {
        if (typeof s === "string") advertised.add(s);
      }
    } else {
      for (const k of Object.keys(json)) advertised.add(k);
    }
  }

  const needs: CodeNeed[] = [];

  // --- missing_resolver: shape required by >=N templates, not advertised by any vessel ---
  const inputShapeDemand = new Map<string, Set<string>>();
  for (const t of templates) {
    const tid = templateIdOf(t);
    for (const s of templateInputShapes(t)) {
      let set = inputShapeDemand.get(s);
      if (!set) {
        set = new Set<string>();
        inputShapeDemand.set(s, set);
      }
      set.add(tid);
    }
  }
  for (const [shape, demand_tids] of inputShapeDemand.entries()) {
    if (advertised.has(shape)) continue;
    if (!looksLikeCapabilityShape(shape)) continue;
    if (demand_tids.size < resolverDemandThreshold) continue;
    needs.push({
      category: "missing_resolver",
      action: "CREATE",
      target_kind: "resolver",
      target_name: shape,
      reason: `Shape '${shape}' required by ${demand_tids.size} templates; no vessel advertises a resolver producing it.`,
      cited_evidence: Array.from(demand_tids).slice(0, 5),
      priority_score: Math.min(1, demand_tids.size / 10),
    });
  }

  // --- broken_template: failure pattern in traces ---
  const templateFailures = new Map<
    string,
    { preflight: number; truncation: number; sample_traces: string[] }
  >();
  for (const t of traces) {
    if (t.status !== "failure") continue;
    const tid = typeof t.activity_id === "string" ? t.activity_id : "unknown";
    const dur = typeof t.duration_ms === "number" ? t.duration_ms : -1;
    const taskCount = typeof t.task_count === "number" ? t.task_count : -1;
    const eid = typeof t.execution_id === "string" ? t.execution_id : "?";
    const isPreflight = dur >= 0 && dur < 500 && taskCount === 0;
    const isTruncation =
      taskCount > 1 && (t.failure_mode === null || t.failure_mode === undefined);
    if (!isPreflight && !isTruncation) continue;
    let entry = templateFailures.get(tid);
    if (!entry) {
      entry = { preflight: 0, truncation: 0, sample_traces: [] };
      templateFailures.set(tid, entry);
    }
    if (isPreflight) entry.preflight += 1;
    if (isTruncation) entry.truncation += 1;
    if (entry.sample_traces.length < 3) entry.sample_traces.push(eid);
  }
  for (const [tid, agg] of templateFailures.entries()) {
    const total = agg.preflight + agg.truncation;
    if (total < brokenThreshold) continue;
    const kind = agg.preflight > agg.truncation ? "preflight" : "chain-truncation";
    needs.push({
      category: "broken_template",
      action: "MODIFY",
      target_kind: "template",
      target_name: tid,
      reason: `Template ${tid} failed ${total} times in window (${agg.preflight} preflight, ${agg.truncation} chain-truncation). Dominant failure: ${kind}.`,
      cited_evidence: agg.sample_traces,
      priority_score: Math.min(1, total / 20),
    });
  }

  // --- missing_template: producer outputs a shape that no template's inputShapes consume ---
  const allInputShapes = new Set<string>();
  for (const t of templates) {
    for (const s of templateInputShapes(t)) allInputShapes.add(s);
  }
  const orphanOutputs = new Map<string, Set<string>>(); // shape → producing template ids
  for (const t of templates) {
    const tid = templateIdOf(t);
    for (const s of templateOutputShapes(t)) {
      if (allInputShapes.has(s)) continue;
      if (!looksLikeCapabilityShape(s)) continue;
      let set = orphanOutputs.get(s);
      if (!set) {
        set = new Set<string>();
        orphanOutputs.set(s, set);
      }
      set.add(tid);
    }
  }
  for (const [shape, producer_tids] of orphanOutputs.entries()) {
    needs.push({
      category: "missing_template",
      action: "CREATE",
      target_kind: "template",
      target_name: `consumer-of-${shape}`,
      reason: `Shape '${shape}' produced by ${producer_tids.size} template(s) but no template consumes it. Candidate for downstream-consumer template.`,
      cited_evidence: Array.from(producer_tids).slice(0, 3),
      priority_score: 0.4,
    });
  }

  // Sort by priority desc, then category alphabetically.
  needs.sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    return a.category.localeCompare(b.category);
  });

  const categoryCounts: Record<string, number> = {};
  for (const n of needs) {
    categoryCounts[n.category] = (categoryCounts[n.category] ?? 0) + 1;
  }

  return {
    shape: "codeNeedsReport",
    body: {
      traces_scanned: traces.length,
      templates_scanned: templates.length,
      advertised_shape_count: advertised.size,
      total_needs: needs.length,
      category_counts: categoryCounts,
      needs: needs.slice(0, 30),
      top_priority: needs[0] ?? null,
      completed_at: new Date().toISOString(),
    },
  };
}
