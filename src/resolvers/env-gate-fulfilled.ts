import type { ResolverResult } from "./types.js";

export async function resolveEnvGateFulfilled(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const response = await fetch(`${process.env["METABOB_ENDPOINT"]}/v2/substrate/gap/env-gate-fulfilled`, {
    headers: process.env["METABOB_API_KEY"] ? { Authorization: `ApiKey ${process.env["METABOB_API_KEY"]}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    return {
      shape: "structuredError",
      body: {
        message: `Failed to fetch env-gate-fulfilled from substrate: HTTP ${response.status}`,
        details: await response.text().catch(() => ""),
      },
    };
  }
  const data = await response.json() as any;
  return {
    shape: "env_gate_fulfilled",
    body: data,
  };
}
