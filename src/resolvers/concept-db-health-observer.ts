import type { ResolverResult } from "./types.js";

/**
 * concept_db_health_observer (round 2, 2026-06-05) — promotes concept-db
 * reachability + data-plane responsiveness into impulse form. concept-db is the
 * substrate's memory layer; when it wedges, draft prompts lose their context
 * and authoring degrades silently. Without an impulse, downstream traces show
 * "concept fetch failed" but not whether the control plane or the data plane
 * is at fault.
 *
 * Probes /health for control-plane reachability and /concepts/search?q=&limit=1
 * for data-plane liveness; emits conceptDbHealth with roundtrip + counts.
 */

const DEFAULT_ENDPOINT = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";

export interface ConceptDbHealthObserverPointer {
  type: "concept_db_health_observer";
  endpoint?: string;
  timeoutMs?: number;
}

interface ProbeResult {
  reachable: boolean;
  http_status: number | null;
  roundtrip_ms: number | null;
  error: string | null;
  body_snippet: string | null;
}

async function probe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const roundtrip = Date.now() - start;
    let snippet: string | null = null;
    try {
      const text = await resp.text();
      snippet = text.slice(0, 200);
    } catch {
      // ignore
    }
    return {
      reachable: resp.ok,
      http_status: resp.status,
      roundtrip_ms: roundtrip,
      error: resp.ok ? null : `http_${resp.status}`,
      body_snippet: snippet,
    };
  } catch (err) {
    return {
      reachable: false,
      http_status: null,
      roundtrip_ms: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      body_snippet: null,
    };
  }
}

export async function resolveConceptDbHealthObserver(
  pointer: ConceptDbHealthObserverPointer,
): Promise<ResolverResult> {
  const endpoint = (pointer.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const timeoutMs = pointer.timeoutMs ?? 5_000;

  const [health, search] = await Promise.all([
    probe(`${endpoint}/health`, timeoutMs),
    probe(`${endpoint}/concepts/search?q=&limit=1`, timeoutMs),
  ]);

  return {
    shape: "conceptDbHealth",
    body: {
      endpoint,
      control_plane: {
        path: "/health",
        reachable: health.reachable,
        http_status: health.http_status,
        roundtrip_ms: health.roundtrip_ms,
        error: health.error,
      },
      data_plane: {
        path: "/concepts/search?q=&limit=1",
        reachable: search.reachable,
        http_status: search.http_status,
        roundtrip_ms: search.roundtrip_ms,
        error: search.error,
        body_snippet: search.body_snippet,
      },
      overall_reachable: health.reachable && search.reachable,
      generated_at: new Date().toISOString(),
    },
  };
}
