import type { ResolverResult } from "./types.js";

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
  try {
    while (templates.length < templateFetchCap) {
      const url = `${templatesUrlBase}?limit=${pageSize}&offset=${offset}`;
      const resp = await fetch(url, {
        headers: { ...auth },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) break;
      const json = (await resp.json()) as { templates?: unknown };
      const rows = Array.isArray(json.templates) ? (json.templates as TemplateRow[]) : [];
      templates.push(...rows);
      if (rows.length < pageSize) break;
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
  try {
    const resp = await fetch(`${tracesUrlBase}?limit=${traceFetchCap}`, {
      headers: { ...auth },
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
    },
  };
}
