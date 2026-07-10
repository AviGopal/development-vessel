import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

interface TemplateSuccessEntry {
  templateId: string;
  successCount: number;
}

export async function resolveTemplateSuccessRanking24h(
  _pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (METABOB_API_KEY) {
    headers["Authorization"] = `ApiKey ${METABOB_API_KEY}`;
  }

  // Fetch recent execution traces — last 24 hours worth, up to 500 records.
  // We query the traces endpoint and filter by created_at >= now - 86400s.
  const nowMs = new globalThis.Number(new globalThis.Date().getTime()) as number;
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  const cutoffSec = Math.floor(cutoffMs / 1000);

  let traces: any = [];
  try {
    const res = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=500`,
      {
        headers,
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.ok) {
      const body = (await res.json()) as any;
      const raw: any[] = Array.isArray(body?.executions)
        ? (body.executions as any[])
        : Array.isArray(body?.traces)
        ? (body.traces as any[])
        : Array.isArray(body)
        ? (body as any[])
        : [];
      // Filter to last 24h
      traces = raw.filter((t: any) => {
        const ts: unknown = t?.created_at ?? t?.started_at ?? t?.timestamp;
        if (typeof ts === "number") return ts >= cutoffSec || ts >= cutoffMs;
        if (typeof ts === "string") {
          const parsed = new globalThis.Date(ts).getTime();
          return !isNaN(parsed) && parsed >= cutoffMs;
        }
        return true; // include if we can't parse timestamp
      });
      traces = traces.filter((t: any) => t?.status === "success");
    }
  } catch {
    // If traces endpoint unavailable, fall through with empty
  }

  // Also try the executions endpoint as fallback
  if (traces.length === 0) {
    try {
      const res2 = await fetch(
        `${METABOB_ENDPOINT}/v2/executions?limit=500&status=success`,
        {
          headers,
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (res2.ok) {
        const body2 = (await res2.json()) as any;
        const raw2: any[] = Array.isArray(body2?.executions)
          ? (body2.executions as any[])
          : Array.isArray(body2)
          ? (body2 as any[])
          : [];
        traces = raw2.filter((t: any) => {
          const ts: unknown = t?.created_at ?? t?.started_at ?? t?.timestamp;
          if (typeof ts === "number") return ts >= cutoffSec || ts >= cutoffMs;
          if (typeof ts === "string") {
            const parsed = new globalThis.Date(ts).getTime();
            return !isNaN(parsed) && parsed >= cutoffMs;
          }
          return true;
        });
      }
    } catch {
      // ignore
    }
  }

  // Aggregate success counts per template id
  const countMap = new Map<string, number>();

  for (const trace of traces as any[]) {
    const templateId: unknown =
      trace?.template_id ??
      trace?.activity_template_id ??
      trace?.templateId ??
      trace?.activity_id;
    if (typeof templateId === "string" && templateId.length > 0) {
      const prev = countMap.get(templateId) ?? 0;
      countMap.set(templateId, prev + 1);
    }
  }

  // Also fetch templates list to include templates with zero successes
  try {
    const res3 = await fetch(
      `${METABOB_ENDPOINT}/v2/activities/templates?limit=200`,
      {
        headers,
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (res3.ok) {
      const body3 = (await res3.json()) as any;
      const tpls: any[] = Array.isArray(body3?.templates)
        ? (body3.templates as any[])
        : Array.isArray(body3)
        ? (body3 as any[])
        : [];
      for (const tpl of tpls) {
        const tid: unknown = tpl?.id ?? tpl?.template_id;
        if (typeof tid === "string" && tid.length > 0) {
          if (!countMap.has(tid)) {
            countMap.set(tid, 0);
          }
        }
      }
    }
  } catch {
    // ignore — work with what we have from traces
  }

  // Sort ascending by success count, take bottom 7
  const entries: TemplateSuccessEntry[] = [];
  for (const [templateId, successCount] of countMap.entries()) {
    entries.push({ templateId, successCount });
  }
  entries.sort((a, b) => a.successCount - b.successCount);
  const bottom7 = entries.slice(0, 7);

  return {
    shape: "template_success_ranking_24h",
    body: {
      window_hours: 24,
      ranked: bottom7,
      total_templates_observed: countMap.size,
      total_successes_observed: traces.length,
      generated_at: new globalThis.Date().toISOString(),
    },
  };
}
