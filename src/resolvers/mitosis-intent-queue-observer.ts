import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * mitosis_intent_queue_observer — promotes the host-sync intent queue into
 * impulse form so the substrate can see push success/rejection counts and
 * the age of the oldest pending intent without scraping JSONL files.
 *
 * Reads:
 *   - WORKSPACE_ROOT/mitosis-applied-host-sync.jsonl   (intent emissions)
 *   - WORKSPACE_ROOT/mitosis-applied-host-sync-results.jsonl (host worker outcomes)
 *
 * Emits one mitosisIntentQueueState impulse with aggregated counts.
 */

export interface MitosisIntentQueueObserverPointer {
  type: "mitosis_intent_queue_observer";
  workspaceRoot?: string;
  recentLimit?: number;
}

interface IntentRow {
  intent_id?: string;
  vessel_name?: string;
  emitted_at?: string;
  proposal_id?: string;
  staged_files?: string[];
}

interface ResultRow {
  intent_id?: string;
  git_sha?: string;
  push_status?: string;
  detail?: string;
  completed_at?: string;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const buf = await readFile(path, "utf8");
    const out: T[] = [];
    for (const line of buf.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        // skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function resolveMitosisIntentQueueObserver(
  pointer: MitosisIntentQueueObserverPointer,
): Promise<ResolverResult> {
  const root = pointer.workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const recentLimit = pointer.recentLimit ?? 10;

  const intents = await readJsonl<IntentRow>(join(root, "mitosis-applied-host-sync.jsonl"));
  const results = await readJsonl<ResultRow>(
    join(root, "mitosis-applied-host-sync-results.jsonl"),
  );

  const resultsById = new Map<string, ResultRow>();
  for (const r of results) {
    if (r.intent_id) resultsById.set(r.intent_id, r);
  }

  const rejectedByReason: Record<string, number> = {};
  let pushed = 0;
  let pending = 0;
  let oldestPendingIso: string | null = null;

  for (const i of intents) {
    const id = i.intent_id ?? "";
    const r = id ? resultsById.get(id) : undefined;
    if (!r) {
      pending += 1;
      if (i.emitted_at) {
        if (oldestPendingIso === null || i.emitted_at < oldestPendingIso) {
          oldestPendingIso = i.emitted_at;
        }
      }
      continue;
    }
    const status = r.push_status ?? "unknown";
    if (status === "pushed") pushed += 1;
    else {
      rejectedByReason[status] = (rejectedByReason[status] ?? 0) + 1;
    }
  }

  const recent = intents.slice(-recentLimit).map((i) => ({
    intent_id: i.intent_id ?? null,
    vessel_name: i.vessel_name ?? null,
    proposal_id: i.proposal_id ?? null,
    emitted_at: i.emitted_at ?? null,
    push_status: i.intent_id ? resultsById.get(i.intent_id)?.push_status ?? "pending" : "unknown",
  }));

  const oldestAgeMs =
    oldestPendingIso !== null ? Math.max(0, Date.now() - Date.parse(oldestPendingIso)) : null;

  return {
    shape: "mitosisIntentQueueState",
    body: {
      total_intents: intents.length,
      total_results: results.length,
      pending_count: pending,
      pushed_count: pushed,
      rejected_count_by_reason: rejectedByReason,
      oldest_pending_iso: oldestPendingIso,
      oldest_pending_age_ms: oldestAgeMs,
      recent_intents: recent,
      generated_at: new Date().toISOString(),
    },
  };
}
