/**
 * fetchWithRetry (2026-06-14) — resilience for the substrate's SELF-MEASUREMENT
 * fetches.
 *
 * The topology chain (coverage_tick + substrate_health_tick +
 * learned_topology_snapshot) paginates through ~500 templates and thousands of
 * traces, and the registry-change-observer fires the whole chain concurrently
 * on every activityRegistryChange. Under a burst of registrations the
 * concurrent pagination resets connections to activity-api
 * (ECONNRESET / "socket connection was closed unexpectedly"). With a single
 * un-retried fetch, ONE transient reset aborts the entire measurement — so the
 * substrate goes blind to its own topology/refinement EXACTLY when it is most
 * active. Autonomy requires self-measurement that survives its own load.
 *
 * Retries idempotent GETs on transient transport errors and 5xx, with bounded
 * exponential backoff. Returns null after exhausting attempts (callers already
 * treat a null/!ok response as "stop paginating" — graceful partial result
 * beats a thrown chain).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response | null> {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 150;
  const timeoutMs = init.timeoutMs ?? 15_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Retry server-side transients; return everything else (incl. 4xx) as-is.
      if (res.status >= 500 && res.status < 600 && attempt < attempts - 1) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      const transient = isTransient(err);
      if (!transient || attempt === attempts - 1) return null;
      await sleep(baseDelay * 2 ** attempt);
    }
  }
  return null;
}

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return true;
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("socket connection was closed") ||
    msg.includes("econnreset") ||
    msg.includes("connection closed") ||
    msg.includes("the socket connection")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
