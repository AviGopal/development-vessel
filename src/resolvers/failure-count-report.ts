import { env } from "../config.js";
import type { ResolverResult } from "../resolvers/types.js";

/** Reporting window, echoed in the body so a consumer never has to assume what it covers. */
const WINDOW_HOURS = 24;
/** Cap on reported templates. */
const TOP_N = 8;

export async function resolveFailureCountReport(pointer: { type: string } & Record<string, unknown>): Promise<ResolverResult> {
  const endpoint = env("METABOB_ENDPOINT", "http://127.0.0.1:8080");
  const apiKey = process.env.METABOB_API_KEY ?? "";

  const now = Date.now();
  const twentyFourHoursAgo = now - WINDOW_HOURS * 60 * 60 * 1000;
  
  const url = new URL("/v2/activities/execution-traces", endpoint);
  url.searchParams.set("since", String(twentyFourHoursAgo));
  url.searchParams.set("limit", "1000");
  
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `ApiKey ${apiKey}`;
  
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  
  if (!response.ok) {
    return {
      shape: "structuredError",
      body: { error: `Failed to fetch traces: ${response.status} ${response.statusText}` },
    };
  }
  
  let data: any;
  try {
    data = await response.json();
  } catch {
    return {
      shape: "structuredError",
      body: { error: "Failed to parse traces response as JSON" },
    };
  }
  
  // `executions` is the key activity-api actually returns (ListExecutionTracesResponse:
  // {executions,total,limit,offset}). Reading only `traces` yielded undefined -> [], so this
  // resolver reported ZERO failures against the real API no matter what had failed — a silent
  // empty that looks identical to good news. vessel-health-report and resolver-tier-cost-summary
  // both already carry this same fix and say so; this file was missed.
  const traces = Array.isArray(data?.executions)
    ? data.executions
    : Array.isArray(data?.traces)
      ? data.traces
      : Array.isArray(data)
        ? data
        : [];

  const failureCounts = new Map<string, number>();

  for (const trace of traces) {
    const templateId = trace?.templateId ?? trace?.activity_template_id ?? trace?.activityTemplateId;
    const outcome = trace?.outcome ?? trace?.status ?? trace?.result;

    if (!templateId) continue;
    if (outcome !== "failure" && outcome !== "failed" && outcome !== "error") continue;

    const current = failureCounts.get(templateId) ?? 0;
    failureCounts.set(templateId, current + 1);
  }

  // MOST-FAILING FIRST. This sorted ASCENDING, so a report whose entire purpose is to surface
  // failing templates surfaced the LEAST-failing ones and truncated the actual offenders away
  // at the slice. (Contrast template-success-ranking-24h, where ascending IS correct because
  // that report is deliberately a weakest-first `bottom7`.)
  let templates = Array.from(failureCounts.entries())
    .map(([templateId, failureCount]) => ({ templateId, failureCount }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, TOP_N);

  // FALLBACK: traces carry no failures (a fresh store, a trimmed window, or a trace stream that
  // never recorded outcomes) but activity-api still tracks a per-template failure_count. Prefer
  // traces when they have anything to say; consult the templates metrics endpoint only when they
  // do not, so the report degrades to "I have another source" instead of to "nothing failed".
  if (templates.length === 0) {
    templates = await failureCountsFromTemplates(endpoint, headers);
  }

  return {
    shape: "failureCountReport",
    body: {
      templates,
      windowHours: WINDOW_HOURS,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** Per-template failure_count from the templates metrics endpoint. Best-effort: [] on any problem. */
async function failureCountsFromTemplates(
  endpoint: string,
  headers: Record<string, string>,
): Promise<Array<{ templateId: string; failureCount: number }>> {
  try {
    const url = new URL("/v2/activities/templates", endpoint);
    url.searchParams.set("limit", "200");
    const res = await fetch(url.toString(), { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { templates?: unknown };
    const rows = Array.isArray(body?.templates) ? body.templates : [];
    return rows
      .map((t: any) => ({
        templateId: String(t?.id ?? t?.template_id ?? ""),
        failureCount: Number(t?.failure_count ?? t?.failureCount ?? 0),
      }))
      .filter((t) => t.templateId !== "" && Number.isFinite(t.failureCount) && t.failureCount > 0)
      .sort((a, b) => b.failureCount - a.failureCount)
      .slice(0, TOP_N);
  } catch {
    return [];
  }
}
