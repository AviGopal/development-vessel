import type { ResolverResult } from "./types.js";
import { METABOB_ENDPOINT } from "../config.js";

export async function executionTrace(pointer: unknown): Promise<ResolverResult> {
  const fetched = await fetch(`${METABOB_ENDPOINT}/execution-trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pointer),
    signal: AbortSignal.timeout(10_000),
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
