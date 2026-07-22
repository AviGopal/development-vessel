const SURREALDB_URL = process.env['SURREALDB_URL'] ?? 'http://127.0.0.1:8000';
const SURREALDB_USERNAME = process.env['SURREALDB_USERNAME'] ?? 'root';
const SURREALDB_PASSWORD = process.env['SURREALDB_PASSWORD'] ?? process.env['SURREAL_PASS'] ?? 'root';
const SURREALDB_NAMESPACE = process.env['SURREALDB_NAMESPACE'] ?? 'activity-system';
const SURREALDB_DATABASE = process.env['SURREALDB_DATABASE'] ?? 'learning_loop';

interface TraceRow {
  impulse_resolutions?: Array<{ resolver_id?: string; latency_ms?: unknown }>;
  tasks?: Array<{ resolver_id?: string; duration_ms?: unknown }>;
}

interface LatencySample {
  resolver_id: string;
  value: number;
}

interface SurrealResult<T> {
  result?: T[];
  status?: string;
}

async function fetchTraces(limit: number): Promise<Array<{ impulse_resolutions?: Array<{ resolver_id?: string; latency_ms?: number }>; tasks?: Array<{ resolver_id?: string; duration_ms?: number }> }>> {
  const clampedLimit = Math.min(limit, 500);
  const sql = `SELECT activity_id, duration_ms, impulse_resolutions, trace.tasks AS tasks, created_at FROM execution ORDER BY created_at DESC LIMIT ${clampedLimit}`;
  const credentials = Buffer.from(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`).toString('base64');
  const resp = await fetch(`${SURREALDB_URL}/sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'surreal-ns': SURREALDB_NAMESPACE,
      'surreal-db': SURREALDB_DATABASE,
      'Accept': 'application/json',
      'Content-Type': 'text/plain',
    },
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SurrealDB /sql ${resp.status}: ${text}`);
  }
  const json = await resp.json() as SurrealResult<{ impulse_resolutions?: Array<{ resolver_id?: string; latency_ms?: number }>; tasks?: Array<{ resolver_id?: string; duration_ms?: number }> }>[];
  const first = json[0];
  if (!first || first.status !== 'OK') {
    throw new Error(`SurrealDB query failed: ${JSON.stringify(first)}`);
  }
  return first.result ?? [];
}

export async function resolveResolverLatencyCeilingScan(pointer: {
  type: string;
  limit?: number;
  ceiling_ms?: number;
  warn_fraction?: number;
}): Promise<{ shape: string; body: unknown }> {
  const limit = typeof pointer.limit === 'number' ? Math.min(pointer.limit, 500) : 200;
  const ceiling_ms = pointer.ceiling_ms ?? 10000;
  const warn_fraction = pointer.warn_fraction ?? 0.8;

  let traces: Array<{
    impulse_resolutions?: Array<{ resolver_id?: string; latency_ms?: number }>;
    tasks?: Array<{ resolver_id?: string; duration_ms?: number }>;
  }> = [];
  try {
    traces = await fetchTraces(limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { shape: 'resolverLatencyCeilingReport', body: { ok: false, error: msg, resolver_stats: [], breaches: [] } };
  }

  const rows: TraceRow[] = traces;

  // Collect latency samples per resolver_id
  const sampleMap = new Map<string, number[]>();

  for (const row of rows) {
    // Primary: impulse_resolutions[].{ resolver_id, latency_ms }
    if (Array.isArray(row.impulse_resolutions)) {
      for (const entry of row.impulse_resolutions) {
        const rid = entry.resolver_id;
        const lat = entry.latency_ms;
        if (typeof rid === 'string' && rid && typeof lat === 'number' && Number.isFinite(lat)) {
          let arr = sampleMap.get(rid);
          if (!arr) { arr = []; sampleMap.set(rid, arr); }
          arr.push(lat);
        }
      }
    }
    // Fallback: tasks[].{ resolver_id, duration_ms }
    if (Array.isArray(row.tasks)) {
      for (const task of row.tasks) {
        const rid = task.resolver_id;
        const dur = task.duration_ms;
        if (typeof rid === 'string' && rid && typeof dur === 'number' && Number.isFinite(dur)) {
          let arr = sampleMap.get(rid);
          if (!arr) { arr = []; sampleMap.set(rid, arr); }
          arr.push(dur);
        }
      }
    }
  }

  // Compute stats for resolvers with >= 5 samples
  const resolvers: Array<{ resolver_id: string; samples: number; p95_ms: number; max_ms: number }> = [];
  const alerts: Array<{ resolver_id: string; p95_ms: number; headroom_ms: number }> = [];

  for (const [resolver_id, samples] of sampleMap.entries()) {
    if (samples.length < 5) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const len = sorted.length;
    const p95idx = Math.min(len - 1, Math.ceil(0.95 * len) - 1);
    const p95_ms = sorted[p95idx] ?? sorted[len - 1] ?? 0;
    const max_ms = sorted[len - 1] ?? 0;
    resolvers.push({ resolver_id, samples: len, p95_ms, max_ms });
    if (p95_ms >= warn_fraction * ceiling_ms) {
      alerts.push({ resolver_id, p95_ms, headroom_ms: ceiling_ms - p95_ms });
    }
  }

  return {
    shape: 'resolverLatencyCeilingReport',
    body: {
      ceiling_ms,
      warn_fraction,
      resolvers,
      alerts,
      alert_count: alerts.length,
      checked_at: new Date().toISOString(),
    },
  };
}
