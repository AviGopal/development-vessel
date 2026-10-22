/**
 * Per-activity execution counts over a trace window, for the two 30-day readers (reachable-unlearned-report and
 * substrate-health-tick).
 *
 * WHY. Both readers counted 30 days by paging /v2/activities/execution-traces 200 at a time, up to 5000 rows. The list
 * route clamps limit to 100, so `rows.length < 200` stopped every loop after its first page: each call was one request
 * that had the database sort the whole 30-day window (47-71 s on a loaded node) to return its newest 100 rows, and those
 * rows were reported as 30 days.
 *
 * THE READ. activity-api's traceAggregateReport, looked up BY SHAPE through discovery (this substrate's own producers)
 * and posted to the producer's resolve URL: a GROUP BY activity_id in the database over the indexed executed_at window,
 * one row per activity. The producer is called directly, not through discovery's /resolve, because discovery cuts a
 * producer at 10 s and a 720 h aggregate takes longer than that on a loaded node. A report counts only when it says
 * measured:true and truncated:false; anything else is "aggregate unavailable".
 *
 * THE FALLBACK, only when the aggregate is unavailable: the trace list, paged by offset at the route's own 100, bounded by
 * a page cap AND a wall-time cap (each a tuning row read at use time, with the recorded default below). It is COMPLETE
 * only when a short page proves the window was exhausted inside both caps. A capped read is INSUFFICIENT DATA: no counts
 * at all, never the partial slice and never a synthetic row.
 *
 * Population note: the aggregate leaves out observe-tagged executions (goal-host's measurement probes), which the list
 * returned. That is the aggregate's documented population (reach-classify isObserveTrace), not a gap in the count.
 */
import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { discoverOwnResolveUrls, readTuningNumber } from "../judge/gap-policy.js";
import { fetchWithRetry } from "../resolvers/http-retry.js";

export const TRACE_AGGREGATE_SHAPE = "traceAggregateReport";
/** The trace list route's own limit clamp (activity-api execution-traces.ts): a page holds at most this many rows. */
export const TRACE_LIST_PAGE = 100;

/** Tuning rows (law 1: read at use time). Absent or unreadable = the recorded default. */
export const TRACE_COUNTS_AGGREGATE_TIMEOUT_ROW = "trace_counts.aggregate_timeout_ms";
export const TRACE_COUNTS_FALLBACK_MAX_PAGES_ROW = "trace_counts.fallback_max_pages";
export const TRACE_COUNTS_FALLBACK_WALL_ROW = "trace_counts.fallback_wall_ms";
export const TRACE_COUNTS_DEFAULTS = { aggregate_timeout_ms: 60_000, fallback_max_pages: 3, fallback_wall_ms: 30_000 } as const;

export interface ActivityWindowCount { count: number; success: number }

export type TraceWindowCounts =
  | {
      measured: true;
      source: "aggregate" | "list";
      window_hours: number;
      /** Keyed by the activity_id exactly as the trace store holds it. */
      counts: Map<string, ActivityWindowCount>;
      /** Only from the list (its rows carry output_shapes); the aggregate has no such dimension. */
      produced_shapes: Set<string> | null;
      pages: number;
      elapsed_ms: number;
      aggregate_reason: string | null;
    }
  | {
      measured: false;
      source: "insufficient_data";
      window_hours: number;
      reason: string;
      aggregate_reason: string | null;
      pages: number;
      elapsed_ms: number;
    };

const positive = (v: number | null, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);

/** One traceAggregateReport over the window: rows, or the reason it is not usable. */
async function readAggregate(url: string, metric: "count" | "success_count", windowHours: number, timeoutMs: number): Promise<{ rows: Array<{ key: string; value: number }> } | { why: string }> {
  // attempts 1: the cost of this read is the database GROUP BY, so a timeout retried is a second burst, not a recovery.
  const r = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
    body: JSON.stringify({ impulse: { pointer: { type: TRACE_AGGREGATE_SHAPE, group_by: "activity_id", metric, window_hours: windowHours, limit: 20000 } } }),
    timeoutMs,
  }, { attempts: 1 });
  if (!r) return { why: `${metric}: request_failed_or_timed_out` };
  if (!r.ok) return { why: `${metric}: http_${r.status}` };
  try {
    const wire = await r.json() as { success?: boolean; content?: unknown; error?: string };
    if (wire?.success !== true || typeof wire.content !== "string") return { why: `${metric}: resolve_failed: ${wire?.error ?? "no content"}` };
    const report = JSON.parse(wire.content) as { measured?: boolean; truncated?: boolean; reason?: string; rows?: Array<{ key?: unknown; value?: unknown }> };
    if (report.measured !== true) return { why: `${metric}: ${report.reason ?? "unmeasured"}` };
    if (report.truncated !== false) return { why: `${metric}: aggregate_truncated` };
    const rows = (report.rows ?? []).filter((row): row is { key: string; value: number } =>
      typeof row.key === "string" && typeof row.value === "number" && Number.isFinite(row.value) && row.value >= 0);
    return { rows };
  } catch (e) {
    return { why: `${metric}: unparseable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The aggregate path: discovery lookup by shape, then count + success_count. Null counts with a reason when unusable. */
async function readByAggregate(windowHours: number, timeoutMs: number, wantSuccess: boolean): Promise<{ counts: Map<string, ActivityWindowCount> } | { why: string }> {
  const found = await discoverOwnResolveUrls(TRACE_AGGREGATE_SHAPE);
  if (!found.ok) return { why: `discovery: ${found.why}` };
  const producer = found.producers.find((p) => p.origin === "local") ?? found.producers[0];
  if (!producer) return { why: `discovery: no own ${TRACE_AGGREGATE_SHAPE} producer` };
  const total = await readAggregate(producer.url, "count", windowHours, timeoutMs);
  if ("why" in total) return total;
  let successById = new Map<string, number>();
  if (wantSuccess) {
    const succ = await readAggregate(producer.url, "success_count", windowHours, timeoutMs);
    if ("why" in succ) return succ;
    successById = new Map(succ.rows.map((row) => [row.key, row.value]));
  }
  const counts = new Map<string, ActivityWindowCount>();
  for (const row of total.rows) {
    if (row.key === "(none)") continue;
    counts.set(row.key, { count: row.value, success: Math.min(row.value, successById.get(row.key) ?? 0) });
  }
  return { counts };
}

type ListRow = { activity_id?: string; variant_id?: string; success?: boolean; status?: string; output_shapes?: string[] };

/**
 * Per-activity counts over the last `windowHours`. `wantSuccess` also reads the success split (a second aggregate).
 * Never throws; never returns a partial count as measured.
 */
export async function readTraceWindowCounts(opts: { windowHours: number; wantSuccess: boolean; caller: string }): Promise<TraceWindowCounts> {
  const startedAt = Date.now();
  const { windowHours, wantSuccess, caller } = opts;
  const [aggTimeoutRow, maxPagesRow, wallRow] = await Promise.all([
    readTuningNumber(TRACE_COUNTS_AGGREGATE_TIMEOUT_ROW),
    readTuningNumber(TRACE_COUNTS_FALLBACK_MAX_PAGES_ROW),
    readTuningNumber(TRACE_COUNTS_FALLBACK_WALL_ROW),
  ]);
  const aggTimeoutMs = positive(aggTimeoutRow, TRACE_COUNTS_DEFAULTS.aggregate_timeout_ms);
  const maxPages = Math.floor(positive(maxPagesRow, TRACE_COUNTS_DEFAULTS.fallback_max_pages));
  const wallMs = positive(wallRow, TRACE_COUNTS_DEFAULTS.fallback_wall_ms);

  let aggregateReason: string | null = null;
  try {
    const agg = await readByAggregate(windowHours, aggTimeoutMs, wantSuccess);
    if ("counts" in agg) {
      const elapsed = Date.now() - startedAt;
      console.log(`[${caller}] ${windowHours}h execution counts from ${TRACE_AGGREGATE_SHAPE}: ${agg.counts.size} activities in ${elapsed} ms`);
      return { measured: true, source: "aggregate", window_hours: windowHours, counts: agg.counts, produced_shapes: null, pages: 0, elapsed_ms: elapsed, aggregate_reason: null };
    }
    aggregateReason = agg.why;
  } catch (e) {
    aggregateReason = `read_failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.error(`[${caller}] ${TRACE_AGGREGATE_SHAPE} unavailable (${aggregateReason}); bounded list fallback: ${maxPages} page(s), ${wallMs} ms`);

  // Bounded fallback. The window is exhausted only by a short page; hitting either cap first is insufficient data.
  const fallbackStart = Date.now();
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const counts = new Map<string, ActivityWindowCount>();
  const produced = new Set<string>();
  let offset = 0;
  let pages = 0;
  let reason: string | null = null;
  for (;;) {
    if (pages >= maxPages) { reason = `fallback_page_cap (${maxPages} page(s)) before the window was exhausted`; break; }
    const remaining = wallMs - (Date.now() - fallbackStart);
    if (remaining <= 0) { reason = `fallback_wall_cap (${wallMs} ms) before the window was exhausted`; break; }
    const r = await fetchWithRetry(
      `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&offset=${offset}&since_iso=${encodeURIComponent(since)}`,
      { headers: { Authorization: `ApiKey ${METABOB_API_KEY}` }, timeoutMs: remaining },
      { attempts: 1 },
    );
    pages++;
    if (!r) { reason = Date.now() - fallbackStart >= wallMs ? `fallback_wall_cap (${wallMs} ms) before the window was exhausted` : "fallback_page_failed"; break; }
    if (!r.ok) { reason = `fallback_http_${r.status}`; break; }
    let rows: ListRow[];
    try {
      const page = await r.json() as { executions?: ListRow[]; traces?: ListRow[] };
      rows = page.executions ?? page.traces ?? [];
    } catch { reason = "fallback_page_unparseable"; break; }
    for (const t of rows) {
      for (const s of t.output_shapes ?? []) produced.add(s);
      const id = t.activity_id ?? t.variant_id;
      if (!id) continue;
      const e = counts.get(id) ?? { count: 0, success: 0 };
      e.count++;
      if (t.success === true || t.status === "success" || t.status === "completed") e.success++;
      counts.set(id, e);
    }
    offset += rows.length;
    if (rows.length < TRACE_LIST_PAGE) break; // exhausted: the window fit inside both caps
  }
  const elapsed = Date.now() - startedAt;
  if (reason !== null) {
    console.error(`[${caller}] ${windowHours}h execution counts INSUFFICIENT DATA (${reason}; aggregate: ${aggregateReason}): counts are unknown this run, not zero`);
    return { measured: false, source: "insufficient_data", window_hours: windowHours, reason, aggregate_reason: aggregateReason, pages, elapsed_ms: elapsed };
  }
  return { measured: true, source: "list", window_hours: windowHours, counts, produced_shapes: produced, pages, elapsed_ms: elapsed, aggregate_reason: aggregateReason };
}
