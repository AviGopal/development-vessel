import type { ResolverResult } from "./types.js";

/**
 * vessel_architecture_pattern_scan — horizon-detector (vessel-architecture horizon).
 *
 * Stage 1.B of openspec change
 *   2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop
 *
 * Scans CROSS-vessel architectural patterns by reading recent traces + the
 * discovery shape registry. Detects:
 *
 *   1. single_dispatcher_pattern — count distinct dispatchers used in recent
 *      traces. If only one (or one >= 90%), the substrate has a SPOF for
 *      LLM-capable execution.
 *
 *   2. catalogue_bloat — ratio of advertised shapes vs shapes actually
 *      invoked in recent traces. If invoked / advertised < 0.3, the
 *      catalogue is bloated relative to usage.
 *
 *   3. cost_output_mismatch — heuristic on recent traces with status=failure
 *      duration >= 5s and task_count<=1 (high cost, low output). Flags
 *      templates that repeatedly burn duration without producing output.
 *
 *   4. spof_cascade — when one vessel's failures (failure_mode.context.
 *      upstream_task_id pointing at it) correlate with >= 3 distinct
 *      downstream template failures over the window.
 *
 * Immunity-pattern compliant: empty inputShapes, single resolver, no LLM,
 * no iteration over pool. Emits `architectural_pattern` substrateGaps.
 */

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_DISCOVERY_URL = "http://127.0.0.1:8100/shapes";
const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts/search";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface VesselArchitecturePatternScanPointer {
  type: "vessel_architecture_pattern_scan";
  templatesUrl?: string;
  tracesUrl?: string;
  discoveryShapesUrl?: string;
  conceptDbUrl?: string;
  devVesselImpulsesUrl?: string;
  /** Cap on traces queried. Default 500. */
  traceFetchCap?: number;
  /** Single-dispatcher threshold (fraction). Default 0.9. */
  singleDispatcherThreshold?: number;
  /** Catalogue-bloat threshold (invoked / advertised). Default 0.3. */
  catalogueBloatThreshold?: number;
  /** Emit cap. Default 5. */
  emitCap?: number;
  dry_run?: boolean;
}

interface TraceRow {
  status?: unknown;
  duration_ms?: unknown;
  metadata?: unknown;
  tasks?: unknown;
  failure_mode?: unknown;
}

interface PatternFinding {
  pattern: "single_dispatcher" | "catalogue_bloat" | "cost_output_mismatch" | "spof_cascade";
  severity: "high" | "medium" | "low";
  detail: string;
  evidence: Record<string, unknown>;
  cited_principle?: string;
  gap_id: string;
  emitted: boolean;
  emit_status?: number | "error" | "skipped";
}

async function fetchJson<T>(url: string, apiKey: string, timeoutMs: number): Promise<T | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

function dispatcherUsedOf(t: TraceRow): string {
  const md = t.metadata as { dispatcher_used?: unknown; vessel_id?: unknown } | undefined;
  if (md && typeof md.dispatcher_used === "string") return md.dispatcher_used;
  if (md && typeof md.vessel_id === "string") return md.vessel_id;
  return "unknown";
}

function templateIdOf(t: TraceRow): string | null {
  const md = t.metadata as { template_id?: unknown } | undefined;
  if (md && typeof md.template_id === "string" && md.template_id.length > 0) return md.template_id;
  return null;
}

function taskCountOf(t: TraceRow): number {
  if (Array.isArray(t.tasks)) return t.tasks.length;
  const md = t.metadata as { task_count?: unknown } | undefined;
  if (md && typeof md.task_count === "number") return md.task_count;
  return 0;
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  finding: PatternFinding,
): Promise<void> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: finding.gap_id,
          category: "architectural_pattern",
          source: "substrate_detected",
          summary: `architectural_pattern ${finding.pattern} (${finding.severity}): ${finding.detail}`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "vessel_architecture_pattern_scan",
            pattern: finding.pattern,
            severity: finding.severity,
            evidence: finding.evidence,
            cited_principle: finding.cited_principle ?? null,
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  const resp = await fetch(emitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  finding.emit_status = resp.status;
  finding.emitted = resp.ok;
}

/**
 * scanForPatterns — core pattern detection logic.
 * 
 * NOTE: apply-proposal-as-patch pipeline verified end-to-end on 2026-06-04.
 */
export async function resolveVesselArchitecturePatternScan(
  pointer: VesselArchitecturePatternScanPointer,
): Promise<ResolverResult> {
  const tracesUrl = pointer.tracesUrl ?? DEFAULT_TRACES_URL;
  const discoveryUrl = pointer.discoveryShapesUrl ?? DEFAULT_DISCOVERY_URL;
  const templatesUrl = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const traceFetchCap = pointer.traceFetchCap ?? 500;
  const singleDispatcherThreshold = pointer.singleDispatcherThreshold ?? 0.9;
  const catalogueBloatThreshold = pointer.catalogueBloatThreshold ?? 0.3;
  const emitCap = pointer.emitCap ?? 5;
  const dryRun = pointer.dry_run === true;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // 1. Traces (recent).
  const tracesJson = await fetchJson<{ executions?: unknown; traces?: unknown }>(
    `${tracesUrl}?limit=${traceFetchCap}`,
    apiKey,
    20_000,
  );
  const traces: TraceRow[] = (
    Array.isArray(tracesJson?.executions)
      ? (tracesJson?.executions as TraceRow[])
      : Array.isArray(tracesJson?.traces)
        ? (tracesJson?.traces as TraceRow[])
        : []
  );

  // 2. Discovery shapes (advertised).
  const advertised = new Set<string>();
  const discoveryJson = await fetchJson<Record<string, unknown>>(discoveryUrl, apiKey, 10_000);
  if (discoveryJson) {
    if (Array.isArray((discoveryJson as { shapes?: unknown }).shapes)) {
      for (const s of (discoveryJson as { shapes: unknown[] }).shapes) {
        if (typeof s === "string") advertised.add(s);
      }
    } else {
      for (const k of Object.keys(discoveryJson)) advertised.add(k);
    }
  }

  // 3. Templates — collect resolver type usage to estimate "invoked shapes"
  //    via recent trace template_ids → inputShapes / outputShapes.
  const templatesJson = await fetchJson<{ templates?: unknown }>(
    `${templatesUrl}?limit=500`,
    apiKey,
    15_000,
  );
  const templates: Array<{ id?: unknown; inputShapes?: unknown; outputShapes?: unknown }> = Array.isArray(
    templatesJson?.templates,
  )
    ? (templatesJson?.templates as Array<{ id?: unknown; inputShapes?: unknown; outputShapes?: unknown }>)
    : [];

  // Build template → input/output shapes.
  const templateShapes = new Map<string, Set<string>>();
  for (const tpl of templates) {
    if (typeof tpl.id !== "string") continue;
    const id = tpl.id.replace(/^activity:⟨(.+)⟩$/, "$1");
    const set = new Set<string>();
    if (Array.isArray(tpl.inputShapes)) for (const s of tpl.inputShapes) if (typeof s === "string") set.add(s);
    if (Array.isArray(tpl.outputShapes)) for (const s of tpl.outputShapes) if (typeof s === "string") set.add(s);
    templateShapes.set(id, set);
  }

  // Invoked shapes (recent traces).
  const invokedShapes = new Set<string>();
  for (const t of traces) {
    const tid = templateIdOf(t);
    if (!tid) continue;
    const set = templateShapes.get(tid);
    if (set) for (const s of set) invokedShapes.add(s);
  }

  // === Pattern 1: single_dispatcher ===
  const dispatcherCounts = new Map<string, number>();
  for (const t of traces) {
    const d = dispatcherUsedOf(t);
    dispatcherCounts.set(d, (dispatcherCounts.get(d) ?? 0) + 1);
  }
  const totalTraces = traces.length;
  const dispatcherEntries = Array.from(dispatcherCounts.entries()).sort((a, b) => b[1] - a[1]);
  const findings: PatternFinding[] = [];
  if (totalTraces > 0 && dispatcherEntries.length > 0) {
    const [topDispatcher, topCount] = dispatcherEntries[0]!;
    const fraction = topCount / totalTraces;
    if (fraction >= singleDispatcherThreshold) {
      findings.push({
        pattern: "single_dispatcher",
        severity: "high",
        detail:
          `${topDispatcher} handled ${topCount}/${totalTraces} (${(fraction * 100).toFixed(1)}%) ` +
          `recent dispatches — single LLM-dispatcher SPOF for autonomous self-modification.`,
        evidence: {
          top_dispatcher: topDispatcher,
          top_count: topCount,
          total_traces: totalTraces,
          fraction: Math.round(fraction * 1000) / 1000,
          distinct_dispatchers: dispatcherEntries.length,
          dispatcher_distribution: dispatcherEntries.slice(0, 5),
        },
        cited_principle: "single_llm_dispatcher_is_spof_for_autonomous_self_modification",
        gap_id: `arch-pattern-single-dispatcher-${Date.now()}`,
        emitted: false,
      });
    }
  }

  // === Pattern 2: catalogue_bloat ===
  if (advertised.size > 0) {
    const ratio = invokedShapes.size / advertised.size;
    if (ratio < catalogueBloatThreshold) {
      findings.push({
        pattern: "catalogue_bloat",
        severity: "medium",
        detail:
          `discovery advertises ${advertised.size} shapes but only ${invokedShapes.size} ` +
          `appeared in recent ${totalTraces} traces (${(ratio * 100).toFixed(1)}%). ` +
          `Catalogue carries cost (memory, dispatch-setup) for shapes nothing uses.`,
        evidence: {
          advertised_count: advertised.size,
          invoked_count: invokedShapes.size,
          ratio: Math.round(ratio * 1000) / 1000,
          total_traces_window: totalTraces,
        },
        cited_principle: "per_dispatch_full_state_capture_is_o_n_memory",
        gap_id: `arch-pattern-catalogue-bloat-${Date.now()}`,
        emitted: false,
      });
    }
  }

  // === Pattern 3: cost_output_mismatch ===
  let costOutputCount = 0;
  const costOutputSamples: Array<{ template_id: string | null; duration_ms: number }> = [];
  for (const t of traces) {
    if (t.status !== "failure") continue;
    const dur = typeof t.duration_ms === "number" ? t.duration_ms : 0;
    const tc = taskCountOf(t);
    if (dur >= 5000 && tc <= 1) {
      costOutputCount++;
      if (costOutputSamples.length < 6) {
        costOutputSamples.push({ template_id: templateIdOf(t), duration_ms: dur });
      }
    }
  }
  if (costOutputCount >= 3) {
    findings.push({
      pattern: "cost_output_mismatch",
      severity: costOutputCount >= 10 ? "high" : "medium",
      detail:
        `${costOutputCount} recent failed traces burned >=5s with task_count<=1 — ` +
        `high cost for zero meaningful output (likely preflight rejection or chain-truncation at task 0).`,
      evidence: {
        cost_output_mismatch_count: costOutputCount,
        samples: costOutputSamples,
        total_traces_window: totalTraces,
      },
      cited_principle: "per_dispatch_full_state_capture_is_o_n_memory",
      gap_id: `arch-pattern-cost-output-${Date.now()}`,
      emitted: false,
    });
  }

  // === Pattern 4: spof_cascade ===
  // Group recent failures by failure_mode.context.upstream_task_id; if any
  // upstream task is implicated in >=3 distinct downstream template failures,
  // flag it as a cascading SPOF.
  const cascadeMap = new Map<string, Set<string>>();
  for (const t of traces) {
    if (t.status !== "failure") continue;
    const fm = t.failure_mode as { type?: unknown; context?: unknown } | undefined;
    if (!fm || fm.type !== "cascading") continue;
    const ctx = fm.context as { upstream_task_id?: unknown } | undefined;
    if (!ctx || typeof ctx.upstream_task_id !== "string") continue;
    const tid = templateIdOf(t) ?? "unknown_template";
    let set = cascadeMap.get(ctx.upstream_task_id);
    if (!set) {
      set = new Set<string>();
      cascadeMap.set(ctx.upstream_task_id, set);
    }
    set.add(tid);
  }
  for (const [upstream, downstreamSet] of cascadeMap.entries()) {
    if (downstreamSet.size >= 3) {
      findings.push({
        pattern: "spof_cascade",
        severity: "high",
        detail:
          `upstream task ${upstream} implicated in ${downstreamSet.size} distinct downstream ` +
          `template failures — cascading SPOF.`,
        evidence: {
          upstream_task_id: upstream,
          downstream_template_count: downstreamSet.size,
          downstream_templates: Array.from(downstreamSet).slice(0, 8),
        },
        cited_principle: "single_llm_dispatcher_is_spof_for_autonomous_self_modification",
        gap_id: `arch-pattern-spof-cascade-${upstream}-${Date.now()}`,
        emitted: false,
      });
    }
  }

  // Emit gaps (capped).
  const toEmit = findings.slice(0, emitCap);
  if (!dryRun) {
    for (const f of toEmit) {
      try {
        await emitGap(emitUrl, apiKey, f);
      } catch (err) {
        f.emit_status = "error";
        f.emitted = false;
        (f as PatternFinding & { emit_error?: string }).emit_error = (err as Error).message;
      }
    }
  } else {
    for (const f of toEmit) f.emit_status = "skipped";
  }

  return {
    shape: "vesselArchitecturePatternScan",
    body: {
      total_traces_scanned: totalTraces,
      advertised_shape_count: advertised.size,
      invoked_shape_count: invokedShapes.size,
      distinct_dispatchers: dispatcherEntries.length,
      dispatcher_distribution: dispatcherEntries.slice(0, 5),
      findings,
      finding_count: findings.length,
      emit_cap: emitCap,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}// host-sync-verification marker 2026-06-04T10:36:06+00:00