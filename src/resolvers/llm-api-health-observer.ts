import type { ResolverResult } from "./types.js";

/**
 * llm_api_health_observer — promotes LLM-resolver reachability into impulse
 * form. When the upstream provider rate-limits or the llm-resolver-vessel
 * unit wedges, downstream traces show generic LLM errors but the root
 * cause is invisible. This observer probes the vessel and emits a
 * shape-typed impulse the orthogonality detector can read.
 *
 * Best-effort: connection failures, 4xx, 5xx all degrade gracefully — the
 * impulse always emits with reachable=false when the probe fails.
 */

const DEFAULT_ENDPOINT = process.env["LLM_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8220";

export interface LlmApiHealthObserverPointer {
  type: "llm_api_health_observer";
  endpoint?: string;
  timeoutMs?: number;
  probePath?: string;
}

export async function resolveLlmApiHealthObserver(
  pointer: LlmApiHealthObserverPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = pointer.timeoutMs ?? 5_000;
  const probePath = pointer.probePath ?? "/health";

  const url = `${endpoint.replace(/\/+$/, "")}${probePath}`;
  const start = Date.now();
  let reachable = false;
  let status: number | null = null;
  let error: string | null = null;
  let roundtripMs: number | null = null;

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    roundtripMs = Date.now() - start;
    status = resp.status;
    reachable = resp.ok;
    if (!resp.ok) error = `http_${resp.status}`;
  } catch (err) {
    roundtripMs = Date.now() - start;
    error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }

  return {
    shape: "llmApiHealth",
    body: {
      endpoint,
      probe_path: probePath,
      reachable,
      http_status: status,
      roundtrip_ms: roundtripMs,
      error,
      generated_at: new Date().toISOString(),
    },
  };
}
