import { env } from "../config.js";
import type { ResolverResult } from "../resolvers/types.js";

export async function resolveFailureCountReport(pointer: { type: string } & Record<string, unknown>): Promise<ResolverResult> {
  const endpoint = env("METABOB_ENDPOINT", "http://127.0.0.1:8080");
  const apiKey = process.env.METABOB_API_KEY ?? "";
  
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  
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
  
  const traces = Array.isArray(data?.traces) ? data.traces : (Array.isArray(data) ? data : []);
  
  const failureCounts = new Map<string, number>();
  
  for (const trace of traces) {
    const templateId = trace?.templateId ?? trace?.activity_template_id ?? trace?.activityTemplateId;
    const outcome = trace?.outcome ?? trace?.status ?? trace?.result;
    
    if (!templateId) continue;
    if (outcome !== "failure" && outcome !== "failed" && outcome !== "error") continue;
    
    const current = failureCounts.get(templateId) ?? 0;
    failureCounts.set(templateId, current + 1);
  }
  
  const templates = Array.from(failureCounts.entries())
    .map(([templateId, failureCount]) => ({ templateId, failureCount }))
    .sort((a, b) => a.failureCount - b.failureCount)
    .slice(0, 5);
  
  return {
    shape: "failureCountReport",
    body: { templates },
  };
}
