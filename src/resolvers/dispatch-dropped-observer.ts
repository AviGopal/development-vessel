import { readFile } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

/**
 * dispatch_dropped_observer — promotes BoundedBusSink's drop-log into
 * impulse form. Drops indicate goal-host-vessel is shedding load (queue
 * overflow / byte overflow / backpressure timeout); without an impulse,
 * the orthogonality detector can't see this state.
 *
 * Reads the JSONL the goal-host-vessel BoundedBusSink writes
 * (default /workspace/dispatch-dropped.jsonl) and emits one
 * dispatchDroppedHistory impulse with recent-window stats.
 */

export interface DispatchDroppedObserverPointer {
  type: "dispatch_dropped_observer";
  logPath?: string;
  recentWindowMs?: number;
  recentSampleLimit?: number;
}

interface DropRow {
  reason?: string;
  at?: string;
  ts?: number;
  [k: string]: unknown;
}

export async function resolveDispatchDroppedObserver(
  pointer: DispatchDroppedObserverPointer,
): Promise<ResolverResult> {
  const path =
    pointer.logPath ??
    process.env["IAS_BUS_DROP_LOG_PATH"] ??
    "/workspace/dispatch-dropped.jsonl";
  const windowMs = pointer.recentWindowMs ?? 60 * 60 * 1000; // 1 hour default
  const sampleLimit = pointer.recentSampleLimit ?? 10;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      shape: "dispatchDroppedHistory",
      body: {
        log_present: false,
        total_drops: 0,
        recent_window_ms: windowMs,
        recent_drops: 0,
        recent_dominant_reason: null,
        recent_reason_counts: {},
        oldest_recent_iso: null,
        recent_samples: [],
        generated_at: new Date().toISOString(),
      },
    };
  }

  const rows: DropRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as DropRow);
    } catch {
      // skip
    }
  }

  const cutoff = Date.now() - windowMs;
  const recent = rows.filter((r) => {
    const ts = typeof r.ts === "number" ? r.ts : r.at ? Date.parse(r.at) : NaN;
    return Number.isFinite(ts) ? ts >= cutoff : false;
  });

  const reasonCounts: Record<string, number> = {};
  for (const r of recent) {
    const reason = r.reason ?? "unknown";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }

  let dominant: string | null = null;
  let dominantN = 0;
  for (const [k, v] of Object.entries(reasonCounts)) {
    if (v > dominantN) {
      dominant = k;
      dominantN = v;
    }
  }

  let oldestRecentIso: string | null = null;
  for (const r of recent) {
    const ts = typeof r.ts === "number" ? r.ts : r.at ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(ts)) continue;
    const iso = new Date(ts).toISOString();
    if (oldestRecentIso === null || iso < oldestRecentIso) oldestRecentIso = iso;
  }

  const samples = recent.slice(-sampleLimit).map((r) => ({
    reason: r.reason ?? "unknown",
    at: typeof r.ts === "number" ? new Date(r.ts).toISOString() : r.at ?? null,
  }));

  return {
    shape: "dispatchDroppedHistory",
    body: {
      log_present: true,
      total_drops: rows.length,
      recent_window_ms: windowMs,
      recent_drops: recent.length,
      recent_dominant_reason: dominant,
      recent_reason_counts: reasonCounts,
      oldest_recent_iso: oldestRecentIso,
      recent_samples: samples,
      generated_at: new Date().toISOString(),
    },
  };
}
