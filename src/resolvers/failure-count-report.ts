import type { ResolverResult } from "./types.js";

interface FailureCountEntry {
  templateId: string;
  failureCount: number;
}

interface FailureCountReportBody {
  generatedAt: string;
  windowHours: number;
  topTemplates: FailureCountEntry[];
}

export async function resolveFailureCountReport(
  _pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  const endpoint =
    process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  const windowHours = 24;
  const topN = 8;

  // Fetch recent execution traces — we query a large page and aggregate client-side.
  // The activity-api traces endpoint returns { traces: [...] }.
  const url = `${endpoint}/v2/traces?limit=500&status=failure`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `ApiKey ${apiKey}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  const cutoffMs = (Math.floor(Date.now() / 1000) - windowHours * 3600) * 1000;

  // Parse response; type as any so noUncheckedIndexedAccess is satisfied by guards.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let traces: any[] = [];
  if (response.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await response.json()) as any;
    const raw: unknown = body?.traces ?? body?.data ?? body?.results ?? body;
    if (Array.isArray(raw)) {
      traces = raw;
    }
  }

  // Aggregate failure counts per template id within the time window.
  const counts = new Map<string, number>();

  for (const trace of traces) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = trace as any;
    // Accept both epoch-ms and ISO string timestamps.
    const rawTs: unknown = t?.created_at ?? t?.createdAt ?? t?.started_at ?? t?.timestamp;
    let tsMs = 0;
    if (typeof rawTs === "number") {
      tsMs = rawTs > 1e12 ? rawTs : rawTs * 1000;
    } else if (typeof rawTs === "string") {
      const parsed = new Date(rawTs).getTime();
      tsMs = Number.isFinite(parsed) ? parsed : 0;
    }
    if (tsMs > 0 && tsMs < cutoffMs) {
      continue;
    }
    const templateId: unknown =
      t?.activity_template_id ??
      t?.template_id ??
      t?.templateId ??
      t?.activity_id;
    if (typeof templateId !== "string" || templateId.length === 0) {
      continue;
    }
    counts.set(templateId, (counts.get(templateId) ?? 0) + 1);
  }

  // If the traces endpoint returned nothing useful, fall back to the
  // activities/templates metrics endpoint which may expose failure counts directly.
  if (counts.size === 0) {
    const metricsUrl = `${endpoint}/v2/activities/templates?limit=200`;
    const metricsResp = await fetch(metricsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (metricsResp.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metricsBody = (await metricsResp.json()) as any;
      const templates: unknown =
        metricsBody?.templates ?? metricsBody?.data ?? metricsBody?.results ?? metricsBody;
      if (Array.isArray(templates)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const tmpl of templates as any[]) {
          const tid: unknown = tmpl?.id ?? tmpl?.template_id;
          if (typeof tid !== "string" || tid.length === 0) continue;
          const fc: unknown =
            tmpl?.failure_count ??
            tmpl?.failures ??
            tmpl?.stats?.failure_count ??
            tmpl?.metrics?.failure_count;
          if (typeof fc === "number" && fc > 0) {
            counts.set(tid, (counts.get(tid) ?? 0) + fc);
          }
        }
      }
    }
  }

  // Sort descending by count and take top N.
  const sorted: FailureCountEntry[] = Array.from(counts.entries())
    .map(([templateId, failureCount]) => ({ templateId, failureCount }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, topN);

  const body: FailureCountReportBody = {
    generatedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
    windowHours,
    topTemplates: sorted,
  };

  return {
    shape: "failure_count_report",
    body,
  };
}
