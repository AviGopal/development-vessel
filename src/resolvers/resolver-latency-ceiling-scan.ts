import { METABOB_ENDPOINT, METABOB_API_KEY } from '../config.js';

interface TraceRow {
  impulse_resolutions?: Array<{ resolver_id?: string; latency_ms?: unknown }>;
  tasks?: Array<{ resolver_id?: string; duration_ms?: unknown }>;
}

interface LatencySample {
  resolver_id: string;
  value: number;
}

export async function resolveResolverLatencyCeilingScan(pointer: {
  type: string;
  limit?: number;
  ceiling_ms?: number;
  warn_fraction?: number;
}): Promise<{ shape: string; body: unknown }> {
  const limit = pointer.limit ?? 200;
  const ceiling_ms = pointer.ceiling_ms ?? 10000;
  const warn_fraction = pointer.warn_fraction ?? 0.8;

  const url = `${METABOB_ENDPOINT}/v2/activities/execution-traces?limit=${limit}`;
  const res = await fetch(url, {
    headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {},
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      shape: 'structuredError',
      body: { error: `execution-traces fetch failed ${res.status}`, detail: text },
    };
  }

  const data = (await res.json()) as { traces?: TraceRow[] } | TraceRow[];
  const rows: TraceRow[] = Array.isArray(data)
    ? data
    : (Array.isArray((data as { traces?: TraceRow[] }).traces)
        ? (data as { traces: TraceRow[] }).traces
        : []);

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
