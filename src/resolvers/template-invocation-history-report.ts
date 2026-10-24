import type { ResolverResult } from "./types.js";
import { selfAuthHeaders } from "../lib/self-auth.js";

/**
 * template_invocation_history_report — substrate-self-detection of templates
 * registered with activity-api that have zero execution traces. Surfaces
 * "unfired capabilities" — templates the substrate has the means to dispatch
 * but never has.
 *
 * Had this existed pre-2026-06-02, it would have flagged
 * scaffold-new-vessel: 0 invocations despite being registered ~12 days, prompting
 * autonomous dispatch.
 *
 * Immunity-pattern compliant: single resolver, no LLM, no iteration.
 */

export interface TemplateInvocationHistoryReportPointer {
  type: "template_invocation_history_report";
  templatesUrl?: string;
  tracesUrl?: string;
  /** Templates pulled per page. Default 100. */
  pageSize?: number;
  /** Cap on total templates. Default 1000. */
  templateFetchCap?: number;
  /** Cap on traces queried. Default 2000. */
  traceFetchCap?: number;
  /** Cap on returned unfired list. Default 50. */
  reportLimit?: number;
  /**
   * A LEARNED-TRACK FRESHNESS CHECK (the ribosome-extraction joint). Only when given, the answer also carries top-level
   * `stale_count`: 1 when the newest learned template (see isLearnedTemplate) was created more than max_lag_sec before
   * the newest execution, or there is none, else 0, with `newest_learned_template_id` / `newest_learned_age_sec` (the
   * lag behind that execution) and `newest_execution_at`. Measured against the newest execution, not the clock, so an
   * idle node is never read stale; with no execution time read there is no stale_count (unmeasured). Absent, the
   * response is exactly what it was.
   */
  max_lag_sec?: number;
}

const DEFAULT_TEMPLATES_URL = "http://127.0.0.1:8080/v2/activities/templates";
const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";

interface TemplateRow {
  id?: unknown;
  registered_at?: unknown;
  created_at?: unknown;
  tags?: unknown;
}

interface TraceRow {
  executed_at?: unknown;
  created_at?: unknown;
  activity_id?: unknown;
  variant_id?: unknown;
  metadata?: unknown;
}

function normalizeId(raw: string): string {
  return raw.replace(/^activity:⟨(.+)⟩$/, "$1");
}

function templateIdOf(t: TemplateRow): string {
  if (typeof t.id === "string" && t.id.length > 0) return normalizeId(t.id);
  return "unknown_template";
}

function traceTemplateId(t: TraceRow): string | null {
  const meta = t.metadata as { template_id?: unknown } | undefined;
  if (meta && typeof meta.template_id === "string" && meta.template_id.length > 0) {
    return normalizeId(meta.template_id);
  }
  if (typeof t.variant_id === "string" && t.variant_id.length > 0) {
    return normalizeId(t.variant_id);
  }
  if (typeof t.activity_id === "string" && t.activity_id.length > 0) {
    return normalizeId(t.activity_id);
  }
  return null;
}

/**
 * Whether a template is on the learned track: a ribosome extraction, whose id is `learned-*` (activity-api routes
 * activities.ts isLearnedExtracted), in any id form the listing returns, or tagged `ribosome` / `ribosome.*`. Pure.
 */
export function isLearnedTemplate(t: { id?: unknown; tags?: unknown }): boolean {
  const id = typeof t.id === "string" ? t.id.replace(/^activity:/, "").replace(/^⟨(.+)⟩$/, "$1") : "";
  if (id.startsWith("learned-")) return true;
  return Array.isArray(t.tags) && t.tags.some((g) => typeof g === "string" && (g === "ribosome" || g.startsWith("ribosome.")));
}

/**
 * The learned-track freshness reading over `templates`, a newest-first listing (every activity-api listing path is
 * ORDER BY created_at DESC) pulled up to `capped` (true when the pull stopped at its cap, not at the list's end). The
 * first learned row is the newest. With none pulled, the answer is exact only when the pull reached a row older than
 * the horizon or the list's end; a capped pull whose rows are all newer than the horizon cannot tell, and returns
 * null (no stale_count: unmeasured, never "fresh"). Ages are measured back from `refMs`, the newest execution's time.
 * Pure.
 */
export function learnedFreshness(
  templates: ReadonlyArray<{ id?: unknown; tags?: unknown; created_at?: unknown }>,
  maxLagSec: number,
  capped: boolean,
  refMs: number,
): { stale_count: number; newest_learned_template_id: string | null; newest_learned_age_sec: number | null } | null {
  let newest: { id: string; ms: number } | null = null;
  let oldestMs = Infinity;
  for (const t of templates) {
    const ms = typeof t.created_at === "string" ? Date.parse(t.created_at) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms < oldestMs) oldestMs = ms;
    if (isLearnedTemplate(t) && (!newest || ms > newest.ms)) newest = { id: typeof t.id === "string" ? normalizeId(t.id) : "unknown_template", ms };
  }
  if (newest) {
    const age = Math.max(0, Math.round((refMs - newest.ms) / 1000));
    return { stale_count: age > maxLagSec ? 1 : 0, newest_learned_template_id: newest.id, newest_learned_age_sec: age };
  }
  if (capped && !((refMs - oldestMs) / 1000 > maxLagSec)) return null;
  return { stale_count: 1, newest_learned_template_id: null, newest_learned_age_sec: null };
}

function daysSince(iso: unknown): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((Date.now() - t) / (24 * 3600 * 1000));
}

function intendedTriggerOf(t: TemplateRow): string {
  const tags = Array.isArray(t.tags)
    ? (t.tags as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (tags.some((s) => s.startsWith("intent:"))) {
    return tags.find((s) => s.startsWith("intent:"))!;
  }
  if (tags.length > 0) return `tag:${tags.slice(0, 2).join(",")}`;
  return "unknown";
}

export async function resolveTemplateInvocationHistoryReport(
  pointer: TemplateInvocationHistoryReportPointer,
): Promise<ResolverResult> {
  const templatesUrlBase = pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL;
  const tracesUrlBase = pointer.tracesUrl ?? DEFAULT_TRACES_URL;
  const pageSize = pointer.pageSize ?? 100;
  const templateFetchCap = pointer.templateFetchCap ?? 1000;
  const traceFetchCap = pointer.traceFetchCap ?? 2000;
  const reportLimit = pointer.reportLimit ?? 50;

  const apiKey = process.env["METABOB_API_KEY"];
  const auth: Record<string, string> = apiKey
    ? { Authorization: `ApiKey ${apiKey}` }
    : {};

  // 1. Pull templates.
  const templates: TemplateRow[] = [];
  let offset = 0;
  let listEnded = false;
  try {
    while (templates.length < templateFetchCap) {
      const url = `${templatesUrlBase}?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, {
        headers: { ...selfAuthHeaders(pointer.templatesUrl ?? DEFAULT_TEMPLATES_URL, DEFAULT_TEMPLATES_URL) },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) break;
      const json = (await resp.json()) as { templates?: unknown };
      const rows = Array.isArray(json.templates) ? (json.templates as TemplateRow[]) : [];
      templates.push(...rows);
      if (rows.length < pageSize) { listEnded = true; break; }
      offset += rows.length;
    }
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        resolver: "template_invocation_history_report",
        detail: `templates fetch failed: ${(err as Error).message}`,
      },
    };
  }

  // 2. Pull traces (count by template_id).
  const traceCount = new Map<string, number>();
  let newestExecMs: number | null = null;
  try {
    const resp = await fetch(`${tracesUrlBase}?limit=${traceFetchCap}`, {
      headers: { ...selfAuthHeaders(pointer.tracesUrl ?? DEFAULT_TRACES_URL, DEFAULT_TRACES_URL) },
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as { executions?: unknown; traces?: unknown };
      const traces = Array.isArray(json.executions)
        ? (json.executions as TraceRow[])
        : Array.isArray(json.traces)
          ? (json.traces as TraceRow[])
          : [];
      for (const t of traces) {
        const at = typeof t.executed_at === "string" ? Date.parse(t.executed_at) : typeof t.created_at === "string" ? Date.parse(t.created_at) : NaN;
        if (Number.isFinite(at) && (newestExecMs === null || at > newestExecMs)) newestExecMs = at;
        const tid = traceTemplateId(t);
        if (!tid) continue;
        traceCount.set(tid, (traceCount.get(tid) ?? 0) + 1);
      }
    }
  } catch {
    // Graceful — continue with empty trace map (everything appears unfired).
  }

  // 3. Pair templates with invocation counts.
  let firedCount = 0;
  let unfiredCount = 0;
  interface UnfiredEntry {
    template_id: string;
    days_since_registered: number | null;
    intended_trigger: string;
  }
  const unfired: UnfiredEntry[] = [];

  for (const tpl of templates) {
    const tid = templateIdOf(tpl);
    const count = traceCount.get(tid) ?? 0;
    if (count > 0) {
      firedCount++;
    } else {
      unfiredCount++;
      unfired.push({
        template_id: tid,
        days_since_registered: daysSince(tpl.registered_at) ?? daysSince(tpl.created_at),
        intended_trigger: intendedTriggerOf(tpl),
      });
    }
  }

  unfired.sort((a, b) => {
    const ad = a.days_since_registered ?? -1;
    const bd = b.days_since_registered ?? -1;
    return bd - ad;
  });

  let healthVerdict: "HEALTHY" | "DEGRADED" | "BLOCKED";
  const ratio = templates.length > 0 ? unfiredCount / templates.length : 0;
  if (ratio < 0.2) healthVerdict = "HEALTHY";
  else if (ratio < 0.5) healthVerdict = "DEGRADED";
  else healthVerdict = "BLOCKED";

  const maxLagSec = typeof pointer.max_lag_sec === "number" && Number.isFinite(pointer.max_lag_sec) && pointer.max_lag_sec >= 0 ? pointer.max_lag_sec : null;
  const freshness = maxLagSec === null || newestExecMs === null ? null : learnedFreshness(templates, maxLagSec, !listEnded, newestExecMs);

  return {
    shape: "templateInvocationHistoryReport",
    body: {
      total_templates: templates.length,
      fired_count: firedCount,
      unfired_count: unfiredCount,
      unfired_ratio: Math.round(ratio * 1000) / 1000,
      unfired_capabilities: unfired.slice(0, reportLimit),
      health_verdict: healthVerdict,
      completed_at: new Date().toISOString(),
      ...(freshness && newestExecMs !== null ? { ...freshness, max_lag_sec: maxLagSec, newest_execution_at: new Date(newestExecMs).toISOString() } : {}),
    },
  };
}
