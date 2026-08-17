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
  updated_at?: string;
}

const FAMILY_GOALS: Record<string, string> = {
  "self-maintenance": "run the detect-vessel-code-drift scan across /workspace/repos, then for each vessel whose clone is strictly behind origin/dev and whose live /vessels tree matches its clone, fast-forward the clone with git pull --ff-only, mirror the updated src into /vessels/<vessel>/src, restart the vessel unit, and verify its /health endpoint answers healthy; for any vessel whose live tree and clone have diverged in both directions, do NOT sync it and instead file a substrateGap describing the two-way divergence",
  "reality-modeling":
    "refresh the substrate reality model: run learned-topology-snapshot and substrate_health_tick",
  "data-management":
    "run docs_align_tick to assemble the repo docs corpus, scan it against live truth, and file documentation drift gaps",
  "gap-closing":
    "drain the highest-priority open substrate gap from the gap_lifecycle_scan consumption queue",
  // ORGANIZING IS SEPARATE WORK FROM DOING, AND CHEAPER.
  //
  // gap-closing DRAINS the queue but nothing ORDERS it. The backlog reached 523 open
  // gaps with 62 tied at the identical top score, so which one runs is effectively a
  // coin flip and a cheap fast-failing arm out-competes real work. A human's UI
  // complaint sat unselected behind repeated reservations of the same route-edit arm.
  //
  // Deliberately given a SMALLER budget than gap-closing (0.15 vs 0.40). In this
  // scheduler budget is COST: due_score = credit * staleness / budget, and a family is
  // affordable only while budget <= 1 - load/3. So a cheap family comes due often and
  // stays affordable under load, while an expensive one waits for capacity. Organizing
  // therefore runs frequently in the gaps between real work rather than competing with
  // it — which is the point: triage that crowds out execution has just moved the
  // problem.
  "gap-organizing":
    "organize the open substrate gap backlog so the next drain picks well: run gap_lifecycle_scan to close gaps that no longer reproduce, merge near-identical gaps onto a single id, and for any gap whose summary contains more than one distinct ask, split it into separate single-ask gaps so each one is a single-region edit the drafter can actually land",
  "pattern-mining":
    "run trace_recurring_pattern_scan and promote any recurring cluster to a concept",
  "human-interacting":
    "check obsidian presence, deliver any pending assist, run docs_decision_deliver to place pending docs decisions in the vaults, and run docs_decision_answer_scan to apply any human decisions from Substrate/Decisions",
  "view-exercise": "exercise the obsidian goal-dispatch views so they stay legible and available to humans: capture a ui_screenshot of the goal-dispatch panel, run the ui legibility sensors over it, verify the newest goal note under Substrate/Dispatches carries a reached verdict callout and a Why block, and file any rendering defect, stale surface, or availability failure as a substrate gap",
  "project-intake": "produce a projectThreadScanReport for folder Substrate/Projects with execute true so open project To do items are dispatched as goals and dispatched items are marked in their notes",
};

const FAMILY_VARIABLES: Record<string, Record<string, unknown>> = { "project-intake": { execute: true, folder: "Substrate/Projects" } };

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
  let present = process.env["DEV_OPERATOR_PRESENT"] === "1";
  if (!present) {
    const disc = (await fetchJson(
      `${process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100"}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:note" } }),
      },
      800,
    )) as { content?: { vessels?: unknown[] } } | null;
    present = Array.isArray(disc?.content?.vessels) && (disc?.content?.vessels?.length ?? 0) > 0;
  }
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
    const rawStaleness = typeof b.staleness === "number" ? b.staleness : 0;
    const ageHours = typeof r.updated_at === "string" ? (Date.now() - new Date(r.updated_at).getTime()) / 3600000 : 0;
    const staleness = b.family === "gap-closing" ? rawStaleness : Math.min(1, rawStaleness + Math.max(0, ageHours) / 24);
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

  // Law 1: the family→goal mapping is behavioral — read rhythmFamilyGoal pool
  // impulses at use time and merge them over the bootstrap FAMILY_GOALS const
  // (pool wins), so new rhythm families mount by impulse-write, not code edit.
  const poolGoalResp = (await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "rhythmFamilyGoal", limit: 50 } }),
    },
    800,
  )) as { body?: { impulses?: Array<{ body?: { family?: string; goal?: string; member?: string } }> } } | null;
  // A family may carry SEVERAL conditioned goals. Distinct jobs feed one family
  // — gap-closing alone is fed by gap-compose, surgical-gap-scan,
  // efficiency-failure-tick, operator-goal-generator and funnel-drain — and a
  // one-goal-per-family map silently drops all but the last of them, which is
  // what blocks retiring their timers. Accumulate rather than overwrite;
  // `member` names a goal within its family so siblings dedup independently.
  const poolGoals: Record<string, Array<{ goal: string; member?: string }>> = {};
  for (const imp of poolGoalResp?.body?.impulses ?? []) {
    const fam = imp?.body?.family;
    const g = imp?.body?.goal;
    const mem = imp?.body?.member;
    if (typeof fam === "string" && fam && typeof g === "string" && g) {
      const list = poolGoals[fam] ?? [];
      list.push(typeof mem === "string" && mem ? { goal: g, member: mem } : { goal: g });
      poolGoals[fam] = list;
    }
  }

  for (const r of candidates) {
    if (picked >= maxEnqueue) {
      skipped.push({ family: r.family, reason: "over_max_enqueue" });
      continue;
    }
    const bootstrapGoal: string | undefined = FAMILY_GOALS[r.family];
    const members: Array<{ goal: string; member?: string }> =
      poolGoals[r.family] ?? (bootstrapGoal ? [{ goal: bootstrapGoal }] : []);
    if (members.length === 0) {
      skipped.push({ family: r.family, reason: "no_goal_mapping" });
      continue;
    }

    let firedThisFamily = false;
    for (const m of members) {
      if (picked >= maxEnqueue) {
        skipped.push({ family: r.family, reason: "over_max_enqueue" });
        break;
      }
      // A single-member family keeps the historical reason text verbatim, so
      // queue entries written before this change still dedup correctly.
      const label = m.member ? `${r.family}:${m.member}` : r.family;
      if (pendingReasons.some((reason) => reason.includes(`rhythm ${label} due`))) {
        skipped.push({ family: label, reason: "already_pending" });
        continue;
      }

      if (!pointer.dry_run) {
        const enq = await resolveBoredomEnqueue({
          type: "boredom_enqueue",
          goal: m.goal,
          priority: "medium",
          reason: `rhythm ${label} due (score ${r.due_score.toFixed(2)})`,
          variables: {
            rhythm_id: r.id,
            due_score: r.due_score,
            ...(m.member ? { rhythm_member: m.member } : {}),
            ...(FAMILY_VARIABLES[r.family] ?? {}),
          },
          ...(pointer.queue_path ? { queue_path: pointer.queue_path } : {}),
        });
        const ok = (enq.body as { enqueued?: boolean } | undefined)?.enqueued === true;
        if (!ok) {
          skipped.push({ family: label, reason: "enqueue_failed" });
          continue;
        }
      }

      firedThisFamily = true;
      enqueued.push({ family: label, goal: m.goal, due_score: Math.round(r.due_score * 100) / 100 });
      picked += 1;
    }

    // 5. Decay the fired rhythm ONCE per family per tick, not once per member.
    // Decay models the family's staleness having been answered; decaying per
    // member would make a family whose work is split across five goals decay
    // five times as fast as an identical family expressed as one goal, which
    // penalises the decomposition rather than the behaviour.
    if (firedThisFamily && !pointer.dry_run) {
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
              body: { due_score: r.due_score, alpha: r.alpha + 0.5, staleness: Math.max(0, r.staleness * 0.3) },
            },
          }),
        },
        800,
      );
    }
  }

  // AN EMPTY OR UNMAPPABLE REGISTRY IS A STRUCTURAL BREAK, NOT IDLENESS (2026-08-09).
  //
  // Both failures read identically to a healthy-but-quiet fleet — the tick returns,
  // enqueues nothing, and says nothing — so both ran undetected:
  //   * registry EMPTY: the spoke had zero timeShapedRhythm impulses (a pool merge
  //     destroyed them and nothing re-seeds), so considered:0 forever.
  //   * registry UNMAPPABLE: 50 rhythms present and EVERY ONE skipped
  //     "no_goal_mapping" — no rhythmFamilyGoal existed for any family, so the hub's
  //     48 rhythms had never fired either.
  // In both cases nothing periodic in the fleet had a cadence, and the only reason it
  // was found was an operator running this resolver by hand.
  //
  // The evidence was already computed here and simply terminated in a report nothing
  // reads. Emit a gap instead. Deliberately NOT emitted when the registry is populated
  // and mappable but nothing is due or affordable — that IS ordinary idleness, and
  // over-reporting it would train the operator to ignore the signal.
  // Judge mappability from the REGISTRY, not from this tick's skip list. A rhythm only
  // reaches the mapping loop if it is already due AND affordable, so on a quiet tick
  // `skipped` is empty and a no_goal_mapping count would read 0 on a totally unmapped
  // fleet — which is exactly what it did when I first wrote this check against
  // `skipped`. Measured: 4 rhythms, every mapping retired, skipped:[] and considered:4.
  // `poolGoals` and FAMILY_GOALS are both computed above independently of due-ness, so
  // asking "could this family EVER map?" is answerable on every tick.
  const mappable = rhythms.filter((r) => {
    const fam = typeof r.body?.family === "string" ? r.body.family : "";
    return !!fam && ((poolGoals[fam]?.length ?? 0) > 0 || !!FAMILY_GOALS[fam]);
  }).length;
  const structuralBreak =
    rhythms.length === 0
      ? "registry_empty"
      : mappable === 0
        ? "registry_unmappable"
        : null;
  if (structuralBreak && pointer.dry_run !== true) {
    const summary =
      structuralBreak === "registry_empty"
        ? "Rhythm registry is EMPTY: rhythm_conductor_tick read zero timeShapedRhythm impulses, so nothing periodic in this substrate has a cadence. Re-seed the registry (pool impulses of shape timeShapedRhythm carrying axis/family/budget/alpha/beta/staleness)."
        : `Rhythm registry is UNMAPPABLE: all ${rhythms.length} rhythm(s) were skipped with no_goal_mapping, so the conductor scores due-ness and has nothing to enqueue. Mount rhythmFamilyGoal pool impulses ({family, goal, member?}) for the affected families.`;
    try {
      await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            impulse: {
              type: "substrateGap_write",
              gap: {
                id: `rhythm-cadence-${structuralBreak}`,
                category: "other",
                source: "substrate_detected",
                summary,
                detected_at: new Date().toISOString(),
                status: "open",
                route: structuralBreak === "registry_unmappable" ? "gap" : "dispatchable",
                classification_metadata: {
                  kind: structuralBreak,
                  considered: rhythms.length,
                  mappable,
                  enqueued: enqueued.length,
                },
              },
            },
          }),
        },
        800,
      );
    } catch { /* best-effort: a gap-write failure must not break the tick */ }
  }

  return {
    shape: "rhythmConductorReport",
    body: {
      enqueued,
      skipped,
      bucket_load: bucketLoad,
      presence: present,
      considered: rhythms.length,
      // Names the break in the report too, so an operator reading a single tick sees
      // "registry_unmappable" rather than inferring it from an empty enqueued list.
      structural_break: structuralBreak ?? null,
      dry_run: pointer.dry_run === true,
    },
  };
}
