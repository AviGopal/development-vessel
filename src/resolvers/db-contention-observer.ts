import type { ResolverResult } from "./types.js";

/**
 * db_contention_observer (2026-06-21) — closes the substrate's DB-contention
 * blind spot. On 2026-06-20 a write-storm pinned SurrealDB (~690% CPU), slowing
 * reads to 8s and timing out trace POSTs 100% — and NOTHING self-detected it:
 * the only load detector (system_load_report) uses a 2x-cores threshold and was
 * sub-threshold (1.3x), and nothing watched DB query latency / in-flight depth /
 * error rate at all.
 *
 * This observer reads activity-api's GET /metrics/db (the single-chokepoint
 * query instrumentation added the same day) and, when contention thresholds are
 * exceeded, emits a `substrateGap` so the loop treats DB contention as a
 * first-class, actionable signal instead of a silent throttle.
 *
 * Pure read + best-effort emit; never throws into the caller.
 */
export interface DbContentionObserverPointer {
  type: "db_contention_observer";
  /** activity-api base url (in-container). Default http://127.0.0.1:8080. */
  activity_api_url?: string;
  /** dev-vessel impulses url for substrateGap_write. Default :8090/v2/impulses/resolve. */
  dev_vessel_impulses_url?: string;
  /** p95 query latency (ms) above which contention is flagged. Default 2000. */
  p95_threshold_ms?: number;
  /** concurrent in-flight queries above which contention is flagged. Default 8. */
  in_flight_threshold?: number;
  /** query error-rate above which contention is flagged. Default 0.05. */
  error_rate_threshold?: number;
  /** if true, report only — do not emit a substrateGap. Default false. */
  dry_run?: boolean;
}

const DEFAULT_API = "http://127.0.0.1:8080";
const DEFAULT_EMIT = "http://127.0.0.1:8090/v2/impulses/resolve";

export async function resolveDbContentionObserver(
  pointer: DbContentionObserverPointer,
): Promise<ResolverResult> {
  const apiBase = pointer.activity_api_url ?? process.env["ACTIVITY_API_URL"] ?? DEFAULT_API;
  const emitUrl = pointer.dev_vessel_impulses_url ?? DEFAULT_EMIT;
  const p95Thresh = pointer.p95_threshold_ms ?? 2000;
  const inFlightThresh = pointer.in_flight_threshold ?? 8;
  const errThresh = pointer.error_rate_threshold ?? 0.05;
  const dryRun = pointer.dry_run ?? false;

  // 1. Read DB throughput stats from the chokepoint instrumentation.
  let stats: any = null;
  let fetchError: string | null = null;
  try {
    const r = await fetch(`${apiBase}/metrics/db`, { signal: AbortSignal.timeout(8_000) });
    if (r.ok) stats = await r.json();
    else fetchError = `HTTP ${r.status}`;
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }

  if (!stats) {
    return {
      shape: "dbContentionReport",
      body: { available: false, fetch_error: fetchError, generated_at: new Date().toISOString() },
    };
  }

  // 2. Evaluate contention thresholds.
  const p95 = Number(stats?.latency_ms?.p95 ?? 0);
  const p50 = Number(stats?.latency_ms?.p50 ?? 0);
  const inFlight = Number(stats?.in_flight ?? 0);
  const errorRate = Number(stats?.error_rate ?? 0);
  const slow = Number(stats?.slow_queries ?? 0);

  const p95_anomaly = p95 > p95Thresh;
  const in_flight_anomaly = inFlight > inFlightThresh;
  const error_anomaly = errorRate > errThresh;
  const anomalies = [
    p95_anomaly ? `p95_latency_ms=${p95}>${p95Thresh}` : null,
    in_flight_anomaly ? `in_flight=${inFlight}>${inFlightThresh}` : null,
    error_anomaly ? `error_rate=${errorRate}>${errThresh}` : null,
  ].filter(Boolean) as string[];
  const contention = anomalies.length > 0;

  // 3. On contention, emit a substrateGap (dedup id bucketed by the hour so a
  // sustained problem produces one open gap, not one per tick).
  let emitted = false;
  let emit_status: number | string | null = null;
  if (contention && !dryRun) {
    const hourBucket = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const apiKey = process.env["METABOB_API_KEY"];
    const authHeader: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
    const body = {
      impulse: {
        pointer: {
          type: "substrateGap_write",
          gap: {
            id: `db-contention-${hourBucket}`,
            category: "db_contention",
            source: "substrate_detected",
              route: "composable",
            summary:
              `SurrealDB write/read contention: ${anomalies.join(", ")} ` +
              `(p50=${p50}ms, slow_queries=${slow}, qps=${stats?.qps ?? "?"}). ` +
              `Likely a write-storm or hot-row UPDATE pattern saturating the single-writer engine. ` +
              `Inspect by_op in /metrics/db; mitigations: batch hot-table writes, detach posterior/penalty writes from request hot paths, reduce failure-trace volume.`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: {
              p95_latency_ms: p95,
              p50_latency_ms: p50,
              in_flight: inFlight,
              error_rate: errorRate,
              slow_queries: slow,
              by_op: stats?.by_op ?? null,
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
    shape: "dbContentionReport",
    body: {
      available: true,
      contention,
      anomalies,
      p95_latency_ms: p95,
      p50_latency_ms: p50,
      in_flight: inFlight,
      error_rate: errorRate,
      slow_queries: slow,
      qps: stats?.qps ?? null,
      by_op: stats?.by_op ?? null,
      thresholds: { p95_ms: p95Thresh, in_flight: inFlightThresh, error_rate: errThresh },
      p95_anomaly,
      in_flight_anomaly,
      error_anomaly,
      gap_emitted: emitted,
      gap_emit_status: emit_status,
      generated_at: new Date().toISOString(),
    },
  };
}
