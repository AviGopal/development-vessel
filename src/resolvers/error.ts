import type { ResolverResult } from "./types.js";

export async function resolveError(
  pointer: Readonly<{ type: "error"; [key: string]: unknown }>,
): Promise<ResolverResult> {
  const endpoint = process.env.SUBSTRATE_ENDPOINT ?? "http://localhost:3173";
  const apiKey = process.env.SUBSTRATE_API_KEY;
  const traceSince = Date.now() - 24 * 60 * 60 * 1000; // last 24h

  const tracesUrl = `${endpoint}/v1/traces?since=${traceSince}&limit=10000`;
  const tracesRes = await fetch(tracesUrl, {
    headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!tracesRes.ok) {
    throw new Error(`failed to fetch traces: ${tracesRes.status}`);
  }
  const traces = (await tracesRes.json())?.traces as Array<{
    execution_id?: string;
    failure_mode?: { type?: string };
  }> ?? [];

  const counts = new Map<string, number>();
  const examples = new Map<string, string>();

  for (const t of traces) {
    const fm = t?.failure_mode?.type;
    if (typeof fm !== "string") continue;
    counts.set(fm, (counts.get(fm) ?? 0) + 1);
    if (!examples.has(fm)) examples.set(fm, t?.execution_id ?? "unknown");
  }

  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({
      failure_mode: { type },
      count,
      example_execution_id: examples.get(type),
    }));

  return {
    shape: "error",
    body: { rows },
  };
}
