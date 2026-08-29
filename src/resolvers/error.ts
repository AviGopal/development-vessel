import type { ResolverResult } from "./types.js";
import { env } from "../config.js";

export async function resolveError(
  pointer: Readonly<{ type: "error"; [key: string]: unknown }>,
): Promise<ResolverResult> {
  // REPOINTED at the real trace store. This previously fetched
  // `${SUBSTRATE_ENDPOINT ?? "http://localhost:3173"}/v1/traces` — an endpoint that exists
  // nowhere: SUBSTRATE_ENDPOINT and port 3173 appear in no other file, 3173 is not a fleet port,
  // and activity-api mounts no /v1/traces route. So this resolver could never succeed, while
  // being advertised in discovery.shapes. activity-api serves /v2/activities/execution-traces,
  // which is what every other trace consumer in this vessel reads.
  const endpoint = env("METABOB_ENDPOINT", "http://127.0.0.1:8080");
  const apiKey = process.env["METABOB_API_KEY"] ?? "";
  const tracesUrl = `${endpoint}/v2/activities/execution-traces?limit=1000`;

  // DEGRADE, do not throw. An unreachable or unhappy trace store is an expected operating
  // condition; throwing escaped the resolver and left callers unable to distinguish "no
  // failures recorded" from "this resolver exploded". Report the degradation in the body.
  let tracesRes: Response;
  try {
    tracesRes = await fetch(tracesUrl, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { shape: "error", body: { rows: [], degraded: true, reason: `trace store unreachable: ${msg}` } };
  }
  if (!tracesRes.ok) {
    return { shape: "error", body: { rows: [], degraded: true, reason: `trace store HTTP ${tracesRes.status}` } };
  }
  const json = (await tracesRes.json().catch(() => null)) as {
    executions?: Array<{ execution_id?: string; failure_mode?: { type?: string } }>;
    traces?: Array<{ execution_id?: string; failure_mode?: { type?: string } }>;
  } | null;
  // `executions` is the key activity-api returns; `traces` kept as a tolerated alias.
  const traces = json?.executions ?? json?.traces ?? [];

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
