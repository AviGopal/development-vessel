import type { ResolverResult } from "./types.js";
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";

export async function executionTrace(pointer: unknown): Promise<ResolverResult> {
  const p = (pointer ?? {}) as { execution_id?: string; executionId?: string; limit?: number };
const traceId = p.execution_id ?? p.executionId;
const url = traceId
    ? `${METABOB_ENDPOINT}/v2/activities/execution-traces/${traceId}`
    : `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=${p.limit ?? 10}`;
const fetched = await fetch(url, {
    method: "GET",
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!fetched.ok) {
    throw new Error(`execution-trace fetch failed: ${fetched.status}`);
  }
  const body = await fetched.json() as any;
  return {
    shape: "execution_trace",
    body,
  };
}
