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
 *
 * PAUSABLE-CITIZEN GUARD (2026-07-08, openspec
 * 2026-07-08-substrate-self-managed-db-reconciliation): a `db_admin
 * reconcile_trace_store` swap holds a `maintenanceLease` (see
 * maintenance-lease.ts) while it REMOVEs/redefines `activity_execution_traces`.
 * Observers/tick loops that read the trace store during that window would hit
 * a table mid-swap. Before every fetch, if the URL is a trace-store READ AND
 * an unexpired lease exists, skip the fetch (return null — callers already
 * treat null as "skip this cycle", same as an exhausted retry). The lease file
 * is stat/read at most once every LEASE_CHECK_TTL_MS so this adds no latency
 * to the (overwhelmingly common) no-lease happy path beyond one cached check.
 * FAIL-OPEN: any error reading/parsing the lease file proceeds with the fetch
 * as if no lease were held — a maintenance window must never be able to wedge
 * unrelated self-measurement fetches open by corrupting its own lease file.
 */
const TRACE_STORE_READ_PATTERNS = [/\/v2\/activities\/execution-traces\b/, /executionTrace/];

function isTraceStoreRead(url: string): boolean {
  return TRACE_STORE_READ_PATTERNS.some((p) => p.test(url));
}

const LEASE_CHECK_TTL_MS = 5_000;
const LEASE_LOG_INTERVAL_MS = 60_000;
let leaseCheckCache: { checkedAt: number; active: boolean } | null = null;
let lastLeaseLogAt = 0;

/** Test-only escape hatch: clear the cached lease check between test cases. */
export function __resetMaintenanceLeaseCacheForTests(): void {
  leaseCheckCache = null;
  lastLeaseLogAt = 0;
}

async function isMaintenanceLeaseActive(): Promise<boolean> {
  const now = Date.now();
  if (leaseCheckCache && now - leaseCheckCache.checkedAt < LEASE_CHECK_TTL_MS) {
    return leaseCheckCache.active;
  }
  let active = false;
  try {
    const { leasePath } = await import("./maintenance-lease.js");
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(leasePath(), "utf-8");
    const lease = JSON.parse(raw) as { expires_at?: string };
    const exp = lease.expires_at ? new Date(lease.expires_at).getTime() : NaN;
    active = Number.isFinite(exp) && exp > now;
  } catch {
    // Fail open: no file, unreadable, or malformed JSON -> treat as no lease.
    active = false;
  }
  leaseCheckCache = { checkedAt: now, active };
  return active;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response | null> {
  if (isTraceStoreRead(url)) {
    try {
      if (await isMaintenanceLeaseActive()) {
        const now = Date.now();
        if (now - lastLeaseLogAt > LEASE_LOG_INTERVAL_MS) {
          console.log(`[http-retry] maintenance lease active — skipping trace-store read: ${url}`);
          lastLeaseLogAt = now;
        }
        return null;
      }
    } catch {
      // Fail open: any error in the guard itself proceeds with the fetch.
    }
  }
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
