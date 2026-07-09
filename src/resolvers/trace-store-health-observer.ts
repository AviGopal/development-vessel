import type { ResolverResult } from "./types.js";

/**
 * trace_store_health_observer — closes the substrate's DB self-management
 * blind spot (openspec 2026-07-08-substrate-self-managed-db-reconciliation).
 *
 * Modeled directly on db-contention-observer.ts: reads a small, pre-aggregated
 * counter surface (activity-api's `GET /metrics/db`, `traceStore` block) —
 * NEVER a global `SELECT count() ... GROUP ALL` over `activity_execution_traces`
 * (that scan measured 86.5s on the 218,953-row baseline; see design.md). When
 * `row_count > cap`, emits a `substrateGap` so the trace-store-reconcile
 * activity gets dispatched through the normal gap_to_feature -> goal-host loop
 * instead of requiring an operator to notice growth.
 *
 * Pure read + best-effort emit; never throws into the caller.
 */
export interface TraceStoreHealthObserverPointer {
  type: "trace_store_health_observer";
  /** activity-api base url (in-container). Default http://127.0.0.1:8080. */
  activity_api_url?: string;
  /** dev-vessel impulses url for substrateGap_write. Default :8090/v2/impulses/resolve. */
  dev_vessel_impulses_url?: string;
  /** if true, report only — do not emit a substrateGap. Default false. */
  dry_run?: boolean;
}

const DEFAULT_API = "http://127.0.0.1:8080";
const DEFAULT_EMIT = "http://127.0.0.1:8090/v2/impulses/resolve";

export async function resolveTraceStoreHealthObserver(
  pointer: TraceStoreHealthObserverPointer,
): Promise<ResolverResult> {
  const apiBase = pointer.activity_api_url ?? process.env["ACTIVITY_API_URL"] ?? DEFAULT_API;
  const emitUrl = pointer.dev_vessel_impulses_url ?? DEFAULT_EMIT;
  const dryRun = pointer.dry_run ?? false;

  // 1. Read the pre-aggregated counters surface. Never queries AET directly.
  let stats: Record<string, unknown> | null = null;
  let fetchError: string | null = null;
  try {
    const r = await fetch(`${apiBase}/metrics/db`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) stats = (await r.json()) as Record<string, unknown>;
    else fetchError = `HTTP ${r.status}`;
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }

  if (!stats) {
    return {
      shape: "traceStoreHealthReport",
      body: { available: false, counters_available: false, fetch_error: fetchError, generated_at: new Date().toISOString() },
    };
  }

  const traceStore = stats["traceStore"] as
    | { row_count?: unknown; cap?: unknown; last_reconciled_at?: unknown }
    | undefined;

  if (!traceStore || typeof traceStore !== "object") {
    return {
      shape: "traceStoreHealthReport",
      body: {
        available: true,
        counters_available: false,
        reason: "traceStore block absent from /metrics/db",
        generated_at: new Date().toISOString(),
      },
    };
  }

  const rowCount = Number(traceStore.row_count ?? 0);
  const cap = Number(traceStore.cap ?? 0);
  const overCap = cap > 0 && rowCount > cap;
  const lastReconciledAt = (traceStore.last_reconciled_at as string | undefined) ?? null;

  // 2. On over-cap, emit a substrateGap (dedup id bucketed by the hour so a
  // sustained overage produces one open gap, not one per tick).
  let emitted = false;
  let emit_status: number | string | null = null;
  if (overCap && !dryRun) {
    const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const apiKey = process.env["METABOB_API_KEY"];
    const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
    const body = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: `trace-store-reconcile-${hourBucket}`,
            category: "trace_store_reconciliation",
            source: "substrate_detected",
              route: "dispatchable",
              remedy: { vessel: "goal-host-vessel", target_template_id: "development-vessel:trace-store-reconcile" },
            summary:
              `Trace store row_count=${rowCount} exceeds cap=${cap} ` +
              `(last_reconciled_at=${lastReconciledAt ?? "never"}). ` +
              `Dispatch development-vessel:trace-store-reconcile to swap the hot table back under cap.`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              row_count: rowCount,
              cap,
              last_reconciled_at: lastReconciledAt,
            },
          },
        },
      },
    };
    try {
      const resp = await fetch(emitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      emit_status = resp.status;
      emitted = resp.ok;
    } catch (e) {
      emit_status = e instanceof Error ? e.message : "error";
    }
  }

  return {
    shape: "traceStoreHealthReport",
    body: {
      available: true,
      counters_available: true,
      row_count: rowCount,
      cap,
      over_cap: overCap,
      last_reconciled_at: lastReconciledAt,
      gap_emitted: emitted,
      gap_emit_status: emit_status,
      generated_at: new Date().toISOString(),
    },
  };
}
