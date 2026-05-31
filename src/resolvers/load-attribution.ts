import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * Per-execution load-attribution record. Boredom writes one record per goal
 * dispatch with before/after system_load_report samples and computed deltas.
 *
 * Storage: JSONL at /workspace/load-attribution/records.jsonl (append-only).
 * One record per line; load_attribution_report aggregates by template.
 */
export interface LoadAttributionRecord {
  /** goal-host dispatch id. */
  dispatch_id: string;
  /** activity-api execution id (when known post-completion). */
  execution_id?: string;
  /** boredom goal index that dispatched. */
  goal_idx: number;
  /** target template id (when boredom dispatched with targetTemplateId). */
  template_id?: string;
  /** Wall-clock duration of the goal from dispatch to terminal status, ms. */
  duration_ms: number;
  /**
   * Cumulative cpu.stat usage_usec at sample time. Nullable because sampleLoad
   * may fail under stress (dev-vessel timeout); null markers preserve the
   * substrate's ability to filter unreliable records rather than corrupting
   * the signal with fabricated zero-deltas.
   */
  cpu_usec_before: number | null;
  cpu_usec_after: number | null;
  cpu_usec_delta: number | null;
  /** Cumulative memory.current bytes at sample time. */
  mem_bytes_before: number | null;
  mem_bytes_after: number | null;
  mem_bytes_delta: number | null;
  /** /proc/loadavg 1-minute average at sample time. */
  load_1m_before: number | null;
  load_1m_after: number | null;
  load_1m_delta: number | null;
  /**
   * Sample quality marker. Aggregation should filter on this — only
   * "both_present" records can compute valid deltas; others are kept for
   * forensics but excluded from spike attribution.
   */
  sample_quality?: "both_present" | "before_missing" | "after_missing" | "both_missing";
  /** Goal-host returned status (completed | failed | etc). */
  goal_status?: string;
  /** ISO timestamp of the dispatch start. */
  dispatched_at: string;
  /** ISO timestamp of the completion sample. */
  completed_at: string;
}

export interface LoadAttributionPointer {
  type: "loadAttribution";
  /** Maximum records to return. Default 100. */
  limit?: number;
  /** Filter by template_id. */
  template_id?: string;
  /** Filter to records since this ISO timestamp. */
  since?: string;
}

export interface LoadAttributionWritePointer {
  type: "loadAttribution_write";
  record: LoadAttributionRecord;
}

const ATTR_PATH = "load-attribution/records.jsonl";

function attrFilePath(): string {
  return resolve(WORKSPACE_ROOT, ATTR_PATH);
}

async function readAllRecords(): Promise<LoadAttributionRecord[]> {
  try {
    const buf = await readFile(attrFilePath(), "utf-8");
    const out: LoadAttributionRecord[] = [];
    for (const line of buf.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as LoadAttributionRecord;
        out.push(parsed);
      } catch {
        // skip malformed line — append-only journal allows partial writes
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function resolveLoadAttribution(
  pointer: LoadAttributionPointer,
): Promise<ResolverResult> {
  const limit = pointer.limit ?? 100;
  const all = await readAllRecords();
  let filtered = all;
  if (pointer.template_id) {
    filtered = filtered.filter((r) => r.template_id === pointer.template_id);
  }
  if (pointer.since) {
    filtered = filtered.filter((r) => r.dispatched_at >= pointer.since!);
  }
  // Most recent first
  filtered.sort((a, b) => b.dispatched_at.localeCompare(a.dispatched_at));
  const slice = filtered.slice(0, limit);
  return {
    shape: "loadAttribution",
    body: {
      total_records: all.length,
      filtered_count: filtered.length,
      records: slice,
    },
  };
}

export async function resolveLoadAttributionWrite(
  pointer: LoadAttributionWritePointer,
): Promise<ResolverResult> {
  const path = attrFilePath();
  await mkdir(dirname(path), { recursive: true });
  // Append-only JSONL. We read the whole file then rewrite to ensure atomic
  // single-write semantics — for the cadence (one record per ~5min boredom
  // cycle), this is fine; for higher throughput, swap for an O_APPEND open.
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    // file may not exist yet
  }
  const line = JSON.stringify(pointer.record) + "\n";
  await writeFile(path, existing + line);
  return {
    shape: "loadAttributionWriteResult",
    body: {
      dispatch_id: pointer.record.dispatch_id,
      written_at: new Date().toISOString(),
    },
  };
}
