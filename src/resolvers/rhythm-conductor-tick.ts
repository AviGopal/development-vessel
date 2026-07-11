/**
 * rhythm_conductor_tick — makes the time-shaped rhythm registry DRIVE the
 * autonomous loop.
 *
 * compute_state_signature already folds the rhythm registry into the
 * state-space signature, so rhythm state CONDITIONS selection. This resolver
 * closes the loop the other way: it reads the same `timeShapedRhythm` registry,
 * scores each rhythm's due-ness, filters by affordability (load headroom +
 * operator presence), and for the top affordable-due rhythms it ENQUEUES that
 * family's canonical work goal into the boredom queue — so the substrate
 * actually spends its time on what its rhythms say is due. After a rhythm
 * fires it is DECAYED (credit accrual + staleness reset) so it does not
 * perpetually re-fire — the economic self-decay that bounds the rhythm set.
 *
 * due_score = credit_mean * staleness / max(budget, 0.05)
 * affordable = budget <= (1 - bucketLoad/3)  AND  (axis!=presence || present)
 *
 * This is a data-plane conductor: it never restarts anything, it only shifts
 * what the autonomous loop picks up next. Rate-limited by top-K selection and
 * by a per-family dedup against pending queue entries.
 */

import type { ResolverResult } from "./types.js";
import { resolveBoredomEnqueue } from "./boredom-enqueue.js";
import { readFileSync } from "node:fs";

const DEV_SELF_ENDPOINT = process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";

export interface RhythmConductorTickPointer {
  type: "rhythm_conductor_tick";
  /** Max families to enqueue this tick. Default 2. */
  max_enqueue?: number;
  /** Due-score threshold. Default 1.0. */
  due_threshold?: number;
  /** Test override for the registry/decay endpoint. */
  registry_endpoint?: string;
  /** Test override for the boredom queue path. */
  queue_path?: string;
  /** Do everything except actually enqueue/decay. */
  dry_run?: boolean;
}

interface RhythmBody {
  axis?: string;
  axis_code?: number;
  family?: string;
  budget?: number;
  alpha?: number;
  beta?: number;
  staleness?: number;
  paces?: string;
}
interface RhythmImpulse {
  id?: string;
  shape?: string;
  body?: RhythmBody;
}

const FAMILY_GOALS: Record<string, string> = {
  "reality-modeling":
    "refresh the substrate reality model: run learned-topology-snapshot and substrate_health_tick",
  "data-management":
    "run docs_align_scan over the repo docs corpus and file any drift as gaps",
  "gap-closing":
    "drain the highest-priority open substrate gap from the gap_lifecycle_scan consumption queue",
  "pattern-mining":
    "run trace_recurring_pattern_scan and promote any recurring cluster to a concept",
  "human-interacting":
    "check obsidian presence and deliver any pending assist",
  "concept-management":
    "run concept_naming_sync to reconcile concept-db concept naming and provenance with the current reality, and file any drift as gaps",
};

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    try { await resp.body?.cancel(); } catch { /* swallow */ }
    if (!resp.ok) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bucketLoadFromProc(): number {
  try {
    const load = parseFloat(readFileSync("/proc/loadavg", "utf-8").split(/\s+/)[0] ?? "0");
    return load < 1 ? 0 : load < 3 ? 1 : load < 8 ? 2 : 3;
  } catch {
    return 0;
  }
}

export async function resolveRhythmConductorTick(
  pointer: RhythmConductorTickPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.registry_endpoint ?? `${DEV_SELF_ENDPOINT}/v2/impulses/resolve`;
  const maxEnqueue = pointer.max_enqueue ?? 2;
  const dueThreshold = pointer.due_threshold ?? 1.0;
  const present = process.env["DEV_OPERATOR_PRESENT"] === "1";
  const bucketLoad = bucketLoadFromProc();

  // 1. Read the rhythm registry.
  const regResp = (await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "timeShapedRhythm", limit: 50 } }),
    },
    800,
  )) as { body?: { impulses?: RhythmImpulse[] } } | null;
  const rhythms = Array.isArray(regResp?.body?.impulses) ? regResp!.body!.impulses! : [];

  // 2. Score + affordability.
  const scored = rhythms.map((r) => {
    const b = r.body ?? {};
    const alpha = typeof b.alpha === "number" ? b.alpha : 1;
    const beta = typeof b.beta === "number" ? b.beta : 1;
    const staleness = typeof b.staleness === "number" ? b.staleness : 0;
    const budget = typeof b.budget === "number" ? b.budget : 1;
    const denom = alpha + beta > 0 ? alpha + beta : 1;
    const due_score = (alpha / denom) * staleness / Math.max(budget, 0.05);
    const affordable =
      budget <= 1 - bucketLoad / 3 && (b.axis === "presence" ? present : true);
    return {
      id: typeof r.id === "string" ? r.id : "",
      family: typeof b.family === "string" ? b.family : "",
      axis: typeof b.axis === "string" ? b.axis : "",
      due_score,
      affordable,
      body: b,
      alpha,
      staleness,
    };
  });

  // 3. Select top affordable-due families.
  const candidates = scored
    .filter((r) => r.affordable && r.due_score >= dueThreshold)
    .sort((a, b) => b.due_score - a.due_score);

  // 4. Dedup against pending queue entries by family.
  let pendingReasons: string[] = [];
  try {
    const queuePath = pointer.queue_path;
    if (queuePath) {
      const q = JSON.parse(readFileSync(queuePath, "utf-8")) as { tasks?: Array<{ reason?: string; status?: string }> };
      pendingReasons = (q.tasks ?? [])
        .filter((t) => t.status === "pending")
        .map((t) => t.reason ?? "");
    }
  } catch {
    pendingReasons = [];
  }

  const enqueued: Array<{ family: string; goal: string; due_score: number }> = [];
  const skipped: Array<{ family: string; reason: string }> = [];
  let picked = 0;

  for (const r of candidates) {
    if (picked >= maxEnqueue) {
      skipped.push({ family: r.family, reason: "over_max_enqueue" });
      continue;
    }
    const goal = FAMILY_GOALS[r.family];
    if (!goal) {
      skipped.push({ family: r.family, reason: "no_goal_mapping" });
      continue;
    }
    if (pendingReasons.some((reason) => reason.includes(r.family))) {
      skipped.push({ family: r.family, reason: "already_pending" });
      continue;
    }

    if (!pointer.dry_run) {
      const enq = await resolveBoredomEnqueue({
        type: "boredom_enqueue",
        goal,
        priority: "medium",
        reason: `rhythm ${r.family} due (score ${r.due_score.toFixed(2)})`,
        variables: { rhythm_id: r.id, due_score: r.due_score },
        ...(pointer.queue_path ? { queue_path: pointer.queue_path } : {}),
      });
      const ok = (enq.body as { enqueued?: boolean } | undefined)?.enqueued === true;
      if (!ok) {
        skipped.push({ family: r.family, reason: "enqueue_failed" });
        continue;
      }
      // 5. Decay the fired rhythm: accrue credit, reset staleness.
      await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            impulse: {
              type: "poolImpulse_write",
              id: r.id,
              shape: "timeShapedRhythm",
              source: "rhythm-conductor-tick",
              body: { ...r.body, alpha: r.alpha + 0.5, staleness: Math.max(0, r.staleness * 0.3) },
            },
          }),
        },
        800,
      );
    }

    enqueued.push({ family: r.family, goal, due_score: Math.round(r.due_score * 100) / 100 });
    picked += 1;
  }

  return {
    shape: "rhythmConductorReport",
    body: {
      enqueued,
      skipped,
      bucket_load: bucketLoad,
      presence: present,
      considered: rhythms.length,
      dry_run: pointer.dry_run === true,
    },
  };
}
