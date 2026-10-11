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
 * bucketLoad  = the worse of PSI cpu/io "some avg60" against shaped rhythmPacing thresholds
 *               (per-core loadavg only when PSI cannot be read; an explicit pointer bucket_load wins)
 *
 * This is a data-plane conductor: it never restarts anything, it only shifts
 * what the autonomous loop picks up next. Rate-limited by top-K selection and
 * by a per-family dedup against pending queue entries.
 */

import type { ResolverResult } from "./types.js";
import { resolveBoredomEnqueue, DEFAULT_QUEUE_PATH } from "./boredom-enqueue.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { lookupShape, describeLookup } from "../config.js";
import { selfAuthHeaders } from "../lib/self-auth.js";

const DEV_SELF_ENDPOINT = process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";
// This vessel's own resolve route: the only URL its node key is sent to (lib/self-auth.ts).
const SELF_RESOLVE_URL = `${DEV_SELF_ENDPOINT}/v2/impulses/resolve`;
const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";

/**
 * Drain pending boredom-queue tasks into actual dispatches.
 *
 * THE ORPHANED QUEUE (measured 2026-08-24): the conductor enqueues due family goals
 * to boredom-queue.json (status:pending), but NOTHING drained it — only boredom-enqueue
 * wrote it and this resolver read it for dedup. So every enqueued maintenance goal
 * (gap-organizing disposition, self-maintenance, …) sat pending forever and no periodic
 * maintenance ever ran, which is how the gap store reached 834 open (78% stale). This
 * closes the loop: read pending tasks, dispatch each to goal-host /run-goal (async), and
 * mark them dispatched so they are not re-run. Best-effort + bounded; never throws.
 */
async function drainBoredomQueue(queuePath: string, maxDispatch: number): Promise<number> {
  try {
    if (!existsSync(queuePath)) return 0;
    const q = JSON.parse(readFileSync(queuePath, "utf-8")) as {
      tasks?: Array<{ id?: string; goal?: string; templateId?: string; variables?: Record<string, unknown>; status?: string }>;
      lastUpdated?: number;
    };
    const tasks = Array.isArray(q.tasks) ? q.tasks : [];
    const pending = tasks.filter((t) => t.status === "pending" && (t.goal || t.templateId));
    if (pending.length === 0) return 0;
    let dispatched = 0;
    for (const t of pending) {
      if (dispatched >= maxDispatch) break;
      try {
        const res = await fetchJson(
          `${GOAL_HOST_ENDPOINT}/run-goal`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
            body: JSON.stringify({
              ...(t.goal ? { goal: t.goal } : { targetTemplateId: t.templateId }),
              variables: t.variables ?? {},
              operator: "rhythm-conductor-drain",
              async: true,
            }),
          },
          8000,
        );
        // Mark dispatched on any non-null response (goal-host accepted it). A failed
        // dispatch leaves status:pending so the next tick retries.
        if (res) { 
          const r = res as { dispatchId?: string; executionId?: string };
          (t as { status?: string; dispatchId?: string }).status = "dispatched";
          if (r.dispatchId || r.executionId) {
            (t as { dispatchId?: string }).dispatchId = r.dispatchId ?? r.executionId;
          }
          dispatched += 1;
        }
      } catch { /* leave pending; retry next tick */ }
    }
    if (dispatched > 0) {
      writeFileSync(queuePath, JSON.stringify({ tasks, lastUpdated: Date.now() }, null, 2));
    }
    return dispatched;
  } catch {
    return 0;
  }
}

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
  /** Test override for the load bucket (0-3); default reads /proc/loadavg. Makes the
   *  affordability gate deterministic under test rather than load-sensitive. */
  bucket_load?: number;
}

export interface RhythmBody {
  axis?: string;
  axis_code?: number;
  family?: string;
  budget?: number;
  alpha?: number;
  beta?: number;
  staleness?: number;
  paces?: string;
  /** Exploration (shaped, law 1): the least credit_mean the due formula uses, so a family whose posterior sank under
   *  penalties still comes due in bounded time. Default EXPLORE_CREDIT_FLOOR. */
  explore_credit_floor?: number;
  /** Any of these marks the family PAUSED (rhythmPausedBy): never explored, never due, until lifted explicitly. */
  hold?: unknown;
  operator_pause?: unknown;
  quarantine?: unknown;
}
interface RhythmImpulse {
  id?: string;
  shape?: string;
  body?: RhythmBody;
  updated_at?: string;
}

const FAMILY_GOALS: Record<string, string> = {
  "self-maintenance": "run the detect-vessel-code-drift scan across /workspace/repos, then for each vessel whose clone is strict and has changes, run the vessel-code-commit-and-push goal",
  "vessel-sync-and-health":
    "for each vessel whose clone is strictly behind origin/dev and whose live /vessels tree matches its clone, fast-forward the clone with git pull --ff-only, mirror the updated src into /vessels/<vessel>/src, restart the vessel unit, and verify its /health endpoint answers healthy; for any vessel whose live tree and clone have diverged in both directions, do NOT sync it and instead file a substrateGap describing the two-way divergence",
  "docs_decision_deliver": "check obsidian presence, deliver any pending assist, run docs_decision_deliver to place pending docs decisions in the vaults, and run docs_decision_answer_scan to apply any human decisions from Substrate/Decisions",
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

/**
 * Families whose work IS a dev-vessel resolver, dispatched DIRECTLY rather than as a
 * natural-language goal.
 *
 * MEASURED 2026-08-24: the gap-organizing family goal ("…run gap_lifecycle_scan…") was
 * enqueued and drained to goal-host, which WALKED it and went HOLLOW (reach=false, "no
 * evidence of gap_lifecycle_scan, only a directory listing") — because gap_lifecycle_scan
 * is a resolver, not a walkable activity, so the walk cannot invoke it. The disposition
 * scan therefore never ran autonomously and the gap store bloated to 834 open (78% stale).
 * For a resolver-backed maintenance family, resolve it directly against this vessel — the
 * scan is self-correcting (live detectors re-open a wrongly-closed gap) and idempotent.
 */
export const FAMILY_RESOLVERS: Record<string, Record<string, unknown>> = {
  "gap-organizing": { type: "gap_lifecycle_scan", autoClose: true, dry_run: false, maxClose: 25 },
  // Writes a failing test for each open gap that has no check of its own, then arms the gap from it once the
  // test reads red at HEAD (gap-check-supply.ts). settled_by "report": the resolver settles its own family from
  // its report when it completes, so the conductor never credits it for an exit (directFamilySettlement).
  "gap-check-supply": { type: "gap_check_supply_tick", settled_by: "report" },
  // Proposes autonomyScope changes by the adopted earn-in criterion (scope-earn-in.ts); runs must-fails and mutations
  // for minutes, so it too settles its own family from its report.
  "scope-earn-in": { type: "scope_earn_in_tick", settled_by: "report" },
};

/**
 * How the conductor settles a resolver-backed family after its direct call. A family whose resolver settles by
 * its own REPORT is left PENDING here (no alpha, no beta): the call may outlive this wait (an arm step runs a test
 * suite for minutes) and returning is not success (REALIGNMENT §2.2, exit-graded credit). Every other direct
 * family keeps its historical alpha on a synchronous return.
 */
export function directFamilySettlement(spec: Record<string, unknown> | undefined, _response: unknown): "alpha" | "pending" {
  return spec?.["settled_by"] === "report" ? "pending" : "alpha";
}

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

// ─── affordability: price by CONTENTION, not by load average ────────────────────────────────
// The bucket was computed from /proc/loadavg. A load average counts runnable AND uninterruptible
// tasks, so on a workstation it can read high with nothing contended: on 2026-10-06 node1 read load
// 23-25 on 16 cores (bucket 2, ceiling 0.333) and enqueued nothing for ~8 h while PSI said the host
// was idle (cpu some avg60 ~3%, io 0). PSI "some avg60" is the share of the last minute in which at
// least one task was stalled waiting for the resource: a contention measure. The bucket is the worse
// of cpu and io against thresholds read at use time from the shaped rhythmPacing record (law 1).

/** Bucket thresholds on PSI "some avg60" (%): below t[0] ⇒ 0, below t[1] ⇒ 1, below t[2] ⇒ 2, else 3. */
export const DEFAULT_PSI_BUCKET_THRESHOLDS: { cpu: number[]; io: number[] } = { cpu: [15, 30, 50], io: [10, 20, 40] };

/** The "some" line's avg60 as a percentage, or null when the text is not PSI. */
export function parsePsiSomeAvg60(text: string): number | null {
  const m = /^some\s+.*\bavg60=([0-9]+(?:\.[0-9]+)?)/m.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  return Number.isFinite(v) ? v : null;
}

const bucketOn = (v: number, t: number[]): number => (v < t[0]! ? 0 : v < t[1]! ? 1 : v < t[2]! ? 2 : 3);

/** The per-core loadavg bucket (the fallback when PSI cannot be read). */
const loadavgBucket = (load: number, cores: number): number => {
  const per = load / Math.max(1, cores);
  return per < 0.25 ? 0 : per < 0.75 ? 1 : per < 2 ? 2 : 3;
};

export function affordabilityBucket(input: {
  psiCpu: number | null;
  psiIo: number | null;
  load: number;
  cores: number;
  thresholds: { cpu: number[]; io: number[] };
}): { bucket: number; source: "psi" | "loadavg" } {
  if (input.psiCpu === null && input.psiIo === null) return { bucket: loadavgBucket(input.load, input.cores), source: "loadavg" };
  const cpuB = input.psiCpu === null ? 0 : bucketOn(input.psiCpu, input.thresholds.cpu);
  const ioB = input.psiIo === null ? 0 : bucketOn(input.psiIo, input.thresholds.io);
  return { bucket: Math.max(cpuB, ioB), source: "psi" };
}

type LoadReaders = { psiCpu: () => string; psiIo: () => string; loadavg: () => string; cores: () => number };
const DEFAULT_LOAD_READERS: LoadReaders = {
  psiCpu: () => readFileSync("/proc/pressure/cpu", "utf-8"),
  psiIo: () => readFileSync("/proc/pressure/io", "utf-8"),
  loadavg: () => readFileSync("/proc/loadavg", "utf-8"),
  cores: () => cpus().length,
};
let loadReaders: LoadReaders = DEFAULT_LOAD_READERS;
/** Tests only: replace the /proc readers. null restores the defaults. */
export function __setLoadReadersForTests(r: LoadReaders | null): void { loadReaders = r ?? DEFAULT_LOAD_READERS; }

let psiFallbacks = 0;
/** How many ticks in this process fell back to loadavg because PSI could not be read. */
export function psiFallbackCount(): number { return psiFallbacks; }

const validThresholds = (t: unknown): t is number[] =>
  Array.isArray(t) && t.length === 3 && t.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) && t[0] <= t[1] && t[1] <= t[2];

/** The shaped thresholds from the rhythmPacing pool record, else the defaults. */
async function readPsiThresholds(endpoint: string, headers: Record<string, string>): Promise<{ cpu: number[]; io: number[] }> {
  const resp = (await fetchJson(
    endpoint,
    { method: "POST", headers, body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "rhythmPacing", limit: 1 } }) },
    800,
  )) as { body?: { impulses?: Array<{ body?: { psi_bucket_thresholds?: { cpu?: unknown; io?: unknown } } }> } } | null;
  const t = resp?.body?.impulses?.[0]?.body?.psi_bucket_thresholds;
  return {
    cpu: validThresholds(t?.cpu) ? t!.cpu : DEFAULT_PSI_BUCKET_THRESHOLDS.cpu,
    io: validThresholds(t?.io) ? t!.io : DEFAULT_PSI_BUCKET_THRESHOLDS.io,
  };
}

async function measureAffordability(endpoint: string, headers: Record<string, string>): Promise<{
  bucket: number; source: "psi" | "loadavg"; psi_cpu: number | null; psi_io: number | null; load: number; cores: number; psi_fallback: number;
}> {
  const readPsi = (f: () => string): number | null => { try { return parsePsiSomeAvg60(f()); } catch { return null; } };
  const psiCpu = readPsi(loadReaders.psiCpu);
  const psiIo = readPsi(loadReaders.psiIo);
  let load = 0;
  try { load = parseFloat(loadReaders.loadavg().split(/\s+/)[0] ?? "0") || 0; } catch { load = 0; }
  let cores = 1;
  try { cores = Math.max(1, loadReaders.cores()); } catch { cores = 1; }
  const thresholds = await readPsiThresholds(endpoint, headers);
  const r = affordabilityBucket({ psiCpu, psiIo, load, cores, thresholds });
  if (r.source === "loadavg") {
    psiFallbacks += 1;
    console.warn(`[rhythm-conductor] PSI unreadable (/proc/pressure/cpu and /proc/pressure/io): affordability falls back to the per-core load average (load=${load.toFixed(2)} cores=${cores} -> bucket ${r.bucket}); psi_fallback=${psiFallbacks}`);
  }
  return { bucket: r.bucket, source: r.source, psi_cpu: psiCpu, psi_io: psiIo, load, cores, psi_fallback: psiFallbacks };
}

/**
 * The per-settlement overlay written back onto a rhythm impulse. Extracted from the
 * conductor so the direction of the posterior can be pinned by a test rather than inferred
 * from a write buried in a loop — which is how it went unnoticed that only one direction
 * was ever taken.
 *
 * `beta` was read when computing credit_mean and preserved on write-back, and NO code path
 * incremented it. credit_mean = alpha/(alpha+beta) could therefore only climb: a family
 * that had never once been dispatchable kept gaining due-ness alongside one that worked
 * every tick. A success signal recorded at initiation with no matching failure leg is an
 * attempt log wearing an outcome label.
 *
 * Staleness decays ONLY on the alpha leg, and that asymmetry is deliberate. Decay means
 * "this family's demand has been answered". A family that could not be dispatched has not
 * had its demand answered, so its staleness must keep accruing and bring it back around —
 * the difference between "we handled it" and "we tried and could not". Decaying on failure
 * would silence exactly the families that need attention most.
 */
export function rhythmSettlementOverlay(
  leg: "alpha" | "beta" | "fired" | "reached",
  alpha: number,
  beta: number,
  staleness: number,
): { alpha: number; staleness: number } | { beta: number; staleness: number } | { staleness: number } {
  // OUTCOME LEGS (2026-09-26). "fired" answers the family's staleness but earns no credit;
  // credit is earned only when the dispatched goal's recorded outcome is reached ("reached"),
  // and an unreached outcome settles "beta". Crediting alpha on fire let a family that never
  // once reached keep ~0.95 credit (measured: capability-census 0/10 reached at 94%).
  if (leg === "fired") return { staleness: Math.max(0, staleness * 0.3) };
  if (leg === "reached") return { alpha: alpha + 0.5, staleness: Math.max(0, staleness) };
  return leg === "alpha"
    ? { alpha: alpha + 0.5, staleness: Math.max(0, staleness * 0.3) }
    // THE BETA LEG MUST PERSIST THE ACCRUED STALENESS, NOT LEAVE IT IMPLICIT.
    //
    // Due-ness is scored from a STORED staleness plus the age of the impulse's last write,
    // and ANY write resets that age. So a beta settlement that touched only `beta` would
    // silently discard however much staleness had accrued since the last write — making a
    // family that could not be dispatched look freshly handled, which is precisely backwards
    // and the exact opposite of this leg's stated intent.
    //
    // Passing the already-computed accrued value back keeps the ledger honest across the
    // write: the demand a failed dispatch did NOT answer survives into the next tick, so the
    // family keeps rising toward due instead of being quietly reset by its own penalty.
    : { beta: beta + 0.5, staleness: Math.max(0, staleness) };
}

/** The default exploration floor on credit_mean (rhythm body explore_credit_floor overrides it at use time). */
export const EXPLORE_CREDIT_FLOOR = 0.1;

/**
 * PAUSED (binding; REALIGNMENT §7 step 9: a hold is never lifted by outgrowing it). A family is paused when its budget
 * exceeds 1 (the conductor's historical pause: never affordable) or its body carries hold, operator_pause or
 * quarantine. A paused family gets no exploration and is never due, however stale, until the pause is lifted
 * explicitly. Returns what paused it, or null.
 */
export function rhythmPausedBy(b: RhythmBody): string | null {
  for (const k of ["hold", "operator_pause", "quarantine"] as const) {
    const v = b[k];
    if (v !== undefined && v !== null && v !== false) return k;
  }
  if (typeof b.budget === "number" && b.budget > 1) return "budget>1";
  return null;
}

/**
 * A rhythm's due-ness, the one formula:
 *   due_score = max(credit_mean, explore_credit_floor) * staleness / max(budget, 0.05)
 * where staleness accrues by the age of the impulse's last write (one per day) and is NOT capped at 1. Before
 * 10-05 it saturated at 1, so any family with credit_mean / max(budget, 0.05) < 1 was permanently undue: node 1 had
 * 7 of 14 such families (5 sunk by penalties, 2 paused). EXPLORATION: an unpaused family therefore comes due within
 *   t_due <= 24 h * (threshold * max(budget, 0.05) / max(credit_mean, floor) - stored_staleness)
 * of its last write; e.g. credit 1/11 (floored to 0.1), budget 0.2, threshold 1: 24 h * 0.2 / 0.1 = 48 h; at the
 * default floor no unpaused family with budget <= 1 waits more than 24 h * 1 / 0.1 = 10 days. A family whose due score
 * crossed the threshold before staleness reached 1 crosses it at exactly the same moment as before (the formula is
 * unchanged below 1 whenever credit_mean >= the floor), so a healthy family's cadence is unchanged.
 * gap-closing keeps its stored staleness. A PAUSED family (rhythmPausedBy) scores 0.
 * Read by the conductor and by every resolver that gates itself on its own family's rhythm, so they cannot disagree.
 */
export function rhythmDueScore(
  b: RhythmBody,
  updatedAt: unknown,
  nowMs: number = Date.now(),
): { alpha: number; beta: number; staleness: number; budget: number; due_score: number; paused_by: string | null } {
  const alpha = typeof b.alpha === "number" ? b.alpha : 1;
  const beta = typeof b.beta === "number" ? b.beta : 1;
  const rawStaleness = typeof b.staleness === "number" ? b.staleness : 0;
  const ageHours = typeof updatedAt === "string" ? (nowMs - new Date(updatedAt).getTime()) / 3600000 : 0;
  const staleness = b.family === "gap-closing" ? rawStaleness : rawStaleness + Math.max(0, ageHours) / 24;
  const budget = typeof b.budget === "number" ? b.budget : 1;
  const denom = alpha + beta > 0 ? alpha + beta : 1;
  const paused_by = rhythmPausedBy(b);
  if (paused_by) return { alpha, beta, staleness, budget, due_score: 0, paused_by };
  const floor = typeof b.explore_credit_floor === "number" && b.explore_credit_floor >= 0 && b.explore_credit_floor <= 1 ? b.explore_credit_floor : EXPLORE_CREDIT_FLOOR;
  return { alpha, beta, staleness, budget, due_score: Math.max(alpha / denom, floor) * staleness / Math.max(budget, 0.05), paused_by: null };
}

/**
 * A rhythm family's timeShapedRhythm row, read now: every tick that gates itself on its own family (gap-check-supply,
 * scope-earn-in). Lives here, beside the pacing formula, in an excluded module: the evaluator's pacing must not
 * depend on a lane-editable file (no self-certification by import).
 */
export async function readFamilyRhythm(family: string): Promise<{ id: string; body: RhythmBody & Record<string, unknown>; updated_at?: string } | null> {
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      // No limit: the registry holds more rows than any fixed page, and this family's row may be past it.
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "timeShapedRhythm" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { body?: { impulses?: Array<{ id?: unknown; body?: Record<string, unknown>; updated_at?: unknown }> } };
    const hit = (j.body?.impulses ?? []).find((r) => r?.body?.["family"] === family);
    if (!hit || !hit.body) return null;
    return { id: String(hit.id ?? ""), body: hit.body as RhythmBody & Record<string, unknown>, ...(typeof hit.updated_at === "string" ? { updated_at: hit.updated_at } : {}) };
  } catch {
    return null;
  }
}

/**
 * Write a family's rhythm row with `overlay` merged into its body. With `ifUpdatedAt`, a compare-and-set: false when
 * another writer moved the row first (or the write failed), so two callers cannot both claim one due slot.
 */
export async function writeFamilyRhythm(rhythm: { id: string; body: RhythmBody & Record<string, unknown> }, overlay: Record<string, unknown>, source: string, ifUpdatedAt?: string): Promise<boolean> {
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse_write", id: rhythm.id, shape: "timeShapedRhythm", source, body: { ...rhythm.body, ...overlay }, ...(ifUpdatedAt ? { if_updated_at: ifUpdatedAt } : {}) } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => ({}))) as { body?: { ok?: unknown } };
    return j.body?.ok === true;
  } catch {
    return false;
  }
}

export async function resolveRhythmConductorTick(
  pointer: RhythmConductorTickPointer,
): Promise<ResolverResult> {
  const endpoint = pointer.registry_endpoint ?? SELF_RESOLVE_URL;
  // Every call below goes to `endpoint`. When that is this vessel's own route, the node key rides along:
  // the route refuses unauthenticated writes (settlements, gap filing). A caller-supplied endpoint gets none.
  const selfHeaders: Record<string, string> = { "Content-Type": "application/json", ...selfAuthHeaders(endpoint, SELF_RESOLVE_URL) };
  const maxEnqueue = pointer.max_enqueue ?? 2;
  const dueThreshold = pointer.due_threshold ?? 1.0;
  // PRESENCE through the shared discovery client. An 800 ms private lookup read every slow
  // peer-forwarded answer as "no human surface". Presence still fails closed (unknown presence
  // leaves presence-axis rhythms unaffordable), but the report and log now say which it was.
  const presenceLookup = await lookupShape("obsidian:note");
  const present = presenceLookup.ok && presenceLookup.producers.length > 0;
  if (!presenceLookup.ok) console.log(`[rhythm-conductor] presence unknown, presence-axis rhythms not affordable this tick: ${describeLookup(presenceLookup)}`);
  const pinned = typeof pointer.bucket_load === "number";
  const afford = pinned ? null : await measureAffordability(endpoint, selfHeaders);
  const bucketLoad = pinned ? (pointer.bucket_load as number) : afford!.bucket;
  if (afford) console.log(`[rhythm-conductor] affordability bucket ${afford.bucket} from ${afford.source} (psi_cpu=${afford.psi_cpu ?? "?"} psi_io=${afford.psi_io ?? "?"} load=${afford.load.toFixed(2)} cores=${afford.cores} psi_fallback=${afford.psi_fallback})`);

  // 1. Read the rhythm registry.
  const regResp = (await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: selfHeaders,
      // NO LIMIT: the registry outgrew the old limit of 50, and the pool returns newest-updated first, so a family
      // past the 50th row (a newly seeded one that has never been written back) was never scored or fired.
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "timeShapedRhythm" } }),
    },
    800,
  )) as { body?: { impulses?: RhythmImpulse[]; count?: number } } | null;
  const rhythms = Array.isArray(regResp?.body?.impulses) ? regResp!.body!.impulses! : [];
  // COMPLETION CHECK: the rows read must be every row the registry holds. A producer that still truncates is
  // said out loud and reported, never read as "these are all the families".
  const registeredCount = typeof regResp?.body?.count === "number" ? regResp.body.count : null;
  const registryComplete = registeredCount === null ? null : rhythms.length === registeredCount;
  if (registryComplete === false) console.log(`[rhythm-conductor] registry read INCOMPLETE: read ${rhythms.length} of ${registeredCount} timeShapedRhythm rows; families past the read are not scored this tick`);

  // 2. Score + affordability.
  const scored = rhythms.map((r) => {
    const b = r.body ?? {};
    const { alpha, beta, staleness, budget, due_score, paused_by } = rhythmDueScore(b, r.updated_at);
    // A paused family is never selected (rhythmPausedBy), whatever its score.
    const affordable =
      !paused_by && budget <= 1 - bucketLoad / 3 && (b.axis === "presence" ? present : true);
    return {
      id: typeof r.id === "string" ? r.id : "",
      family: typeof b.family === "string" ? b.family : "",
      axis: typeof b.axis === "string" ? b.axis : "",
      due_score,
      affordable,
      body: b,
      alpha,
      // `beta` was read just above to compute credit_mean and then dropped on the floor —
      // it never reached the row, so no later code COULD have incremented it even if it
      // had wanted to. Carrying it forward is what makes a penalty leg expressible at all.
      beta,
      staleness,
    };
  });

  // SPEND ENVELOPE (value-per-cost-selection 4.3). The conductor dispatches spending work
  // (family goals to goal-host, gap_lifecycle_scan, the boredom-queue drain), so it obeys the
  // same fleet-wide envelope as auto-pick: read at use time across every node's pool, paused
  // or exhausted or unreadable means no family is selected and the queue is not drained. This
  // replaces "budget > 1" as the way to pause rhythms. The settlement pass above still runs.
  let envelope: { allow: boolean; reason: string } = { allow: true, reason: "dry run" };
  if (pointer.dry_run !== true) {
    try {
      envelope = await (await import("../judge/gap-policy.js")).spendEnvelopeAllows();
    } catch (err) {
      envelope = { allow: false, reason: "envelope check failed: " + String(err) };
    }
    if (!envelope.allow) console.log(`[rhythm-conductor] no family selected and the queue not drained: spend envelope ${envelope.reason}`);
  }

  // 3. Select top affordable-due families.
  const candidates = scored
    .filter((r) => envelope.allow && r.affordable && r.due_score >= dueThreshold)
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

  const enqueued: Array<{ family: string; goal: string; due_score: number; settlement?: string }> = [];
  const skipped: Array<{ family: string; reason: string }> = [];
  let picked = 0;


  /**
   * REVISED 2026-09-26: this posterior now grades OUTCOME, superseding the scheduling reading
   * below. Crediting alpha on fire meant a family whose dispatched goals never reached kept
   * rising in credit (capability-census 0/10 reached at 94%, federation-verification 7/46 at
   * 96%, project-intake 1/8 at 97%, the last driving a self-recursion storm). A fire now only
   * answers staleness ("fired"); the settle pass below reads each dispatched task's outcome
   * from goal-host and settles "reached" or "beta". Direct-resolver families keep alpha on
   * fire because their resolve call returns the outcome synchronously.
   *
   * WHAT THIS POSTERIOR MEANT (historical), stated because it was previously impossible to infer.
   *
   * A rhythm family's alpha/beta grade THE CONDUCTOR'S ABILITY TO GET THIS FAMILY'S WORK
   * SCHEDULED — not whether that work then succeeds. The dispatched goal has its own
   * posterior; conflating the two would penalise a correctly-scheduled family for a
   * downstream failure it has no control over, and would make cadence hostage to
   * execution quality.
   *
   * Under that reading the previous code was half-written rather than wrong: firing WAS
   * the success, so crediting alpha on fire is right. What was missing is that the two
   * failures the conductor can observe directly moved nothing. `beta` was read when
   * computing due-ness and carefully preserved on write-back, and no code path anywhere
   * incremented it — so credit_mean = alpha/(alpha+beta) could only climb, and a family
   * that had never once been dispatchable kept rising in due-ness alongside one that
   * worked every tick.
   *
   * Both legs are settled here so the write-back stays in exactly one place. PRESERVING
   * THE IDENTITY FIELDS IS LOAD-BEARING: a bare {due_score, alpha, staleness} write once
   * STRIPPED `family`, which made the rhythm unmappable after firing exactly once — a
   * self-erasing registry. Spread the existing body first, then overlay.
   *
   * Staleness decays only on a fire. A family that failed to dispatch has NOT had its
   * demand answered, so its staleness must keep accruing and bring it back around; that
   * is the difference between "we handled it" and "we tried and could not".
   */
  const settleRhythm = async (
    r: { id: string; body: RhythmBody; alpha: number; beta: number; staleness: number; due_score: number },
    leg: "alpha" | "beta" | "fired" | "reached",
  ): Promise<void> => {
    const overlay = rhythmSettlementOverlay(leg, r.alpha, r.beta, r.staleness);
    try {
      await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: selfHeaders,
          body: JSON.stringify({
            impulse: {
              type: "poolImpulse_write",
              id: r.id,
              shape: "timeShapedRhythm",
              source: "rhythm-conductor-tick",
              body: { ...r.body, due_score: r.due_score, ...overlay },
            },
          }),
        },
        800,
      );
    } catch {
      /* A settlement that cannot be written must not take the tick down with it; the
         next tick re-derives due-ness from whatever the registry currently holds. */
    }
  };

  // Apply a settlement AND carry it into the in-memory row, so a second settlement of the same
  // family in this tick builds on the first instead of overwriting it from a stale snapshot.
  const settleAndCarry = async (r: (typeof scored)[number], leg: "reached" | "beta" | "fired"): Promise<void> => {
    const o = rhythmSettlementOverlay(leg, r.alpha, r.beta, r.staleness) as { alpha?: number; beta?: number; staleness: number };
    await settleRhythm(r, leg);
    if (typeof o.alpha === "number") r.alpha = o.alpha;
    if (typeof o.beta === "number") r.beta = o.beta;
    r.staleness = o.staleness;
    r.body = { ...r.body, ...o };
  };

  // OUTCOME SETTLEMENT PASS (2026-09-26). The drain records each dispatched task's goal-host
  // dispatchId next to variables.rhythm_id; read the outcome and settle the family on it.
  // Bounded: at most 15 outcome reads per tick, tasks older than 7 days are marked expired
  // without a read, and a record goal-host no longer has (after a day) is marked unknown, so
  // the pass never rescans the whole queue history.
  if (!pointer.dry_run) {
    try {
      const qPath = pointer.queue_path ?? DEFAULT_QUEUE_PATH;
      if (existsSync(qPath)) {
        const q = JSON.parse(readFileSync(qPath, "utf-8")) as {
          tasks?: Array<{ status?: string; dispatchId?: string; createdAt?: number; settled?: string; variables?: Record<string, unknown> }>;
          lastUpdated?: number;
        };
        const tasks = Array.isArray(q.tasks) ? q.tasks : [];
        const byId = new Map(scored.map((s) => [s.id, s]));
        let reads = 0;
        let changed = false;
        for (const t of tasks) {
          if (reads >= 15) break;
          const rid = typeof t.variables?.["rhythm_id"] === "string" ? String(t.variables["rhythm_id"]) : "";
          if (t.status !== "dispatched" || !t.dispatchId || !rid || t.settled) continue;
          const ageMs = typeof t.createdAt === "number" ? Date.now() - t.createdAt : 0;
          if (ageMs > 7 * 86_400_000) { t.settled = "expired"; changed = true; continue; }
          const row = byId.get(rid);
          if (!row) continue;
          reads += 1;
          const ex = (await fetchJson(
            `${GOAL_HOST_ENDPOINT}/executions/${t.dispatchId}`,
            { method: "GET", headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {} },
            3000,
          )) as { status?: string; reached?: unknown } | null;
          if (!ex || typeof ex.status !== "string") {
            if (ageMs > 86_400_000) { t.settled = "unknown"; changed = true; }
            continue;
          }
          if (ex.status !== "completed" && ex.status !== "failed") continue;
          const leg = ex.reached === true ? "reached" : "beta";
          await settleAndCarry(row, leg);
          t.settled = leg === "reached" ? "alpha" : "beta";
          changed = true;
        }
        if (changed) writeFileSync(qPath, JSON.stringify({ ...q, tasks, lastUpdated: Date.now() }, null, 2));
      }
    } catch {
      /* Best-effort: an unreadable queue or outcome leaves tasks unsettled for the next tick. */
    }
  }

  // Law 1: the family→goal mapping is behavioral — read rhythmFamilyGoal pool
  // impulses at use time and merge them over the bootstrap FAMILY_GOALS const
  // (pool wins), so new rhythm families mount by impulse-write, not code edit.
  const poolGoalResp = (await fetchJson(
    endpoint,
    {
      method: "POST",
      headers: selfHeaders,
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
    // A resolver-backed family needs no goal text: it is dispatched directly below.
    if (members.length === 0 && !FAMILY_RESOLVERS[r.family]) {
      skipped.push({ family: r.family, reason: "no_goal_mapping" });
      // It once settled beta here ("a family that cannot be dispatched must lose credit") so that an unmappable
      // family would decay out of contention.
      // CORRECTED 10-05 (REALIGNMENT §2.2): an unmapped family is a CONFIGURATION fact about this node (no
      // rhythmFamilyGoal, no goal text, no resolver at this code version), not an observed outcome of the family's
      // work. Settling beta here sank five families' credit until they could never come due again (credit 1/11 at
      // budget 0.2). The skip is reported (skipped, structural_break) and settles NEITHER leg.
      continue;
    }

    let firedThisFamily = false;
    let directLeg: "alpha" | "pending" = "alpha";
    let failedToEnqueue = false;
    const directResolver = FAMILY_RESOLVERS[r.family];
    if (directResolver) {
      // Resolver-backed family: dispatch the resolver directly against this vessel
      // instead of enqueuing an NL goal that goal-host cannot walk into an invocation.
      if (!pointer.dry_run && picked < maxEnqueue) {
        try {
          const directResponse = await fetchJson(
            endpoint,
            {
              method: "POST",
              headers: selfHeaders,
              body: JSON.stringify({ impulse: { pointer: directResolver } }),
            },
            60_000,
          );
          firedThisFamily = true;
          directLeg = directFamilySettlement(directResolver, directResponse);
          enqueued.push({ family: r.family, goal: `direct:${String(directResolver.type)}`, due_score: Math.round(r.due_score * 100) / 100, ...(directLeg === "pending" ? { settlement: "pending" } : {}) });
          picked += 1;
        } catch {
          skipped.push({ family: r.family, reason: "direct_dispatch_failed" });
        }
      }
    } else {
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
          // The second observable negative: the family was due, mappable, and the dispatch
          // itself refused. Same reasoning as the unmappable branch above — a failure the
          // conductor can see directly must move the posterior, or the only thing the
          // posterior records is how often we tried.
          failedToEnqueue = true;
          continue;
        }
      }

      firedThisFamily = true;
      enqueued.push({ family: label, goal: m.goal, due_score: Math.round(r.due_score * 100) / 100 });
      picked += 1;
    }
    }

    // 5. Decay the fired rhythm ONCE per family per tick, not once per member.
    // Decay models the family's staleness having been answered; decaying per
    // member would make a family whose work is split across five goals decay
    // five times as fast as an identical family expressed as one goal, which
    // penalises the decomposition rather than the behaviour.
    if (firedThisFamily && !pointer.dry_run) {
      // A direct-resolver family's resolve returned its outcome synchronously; an enqueued
      // goal's outcome is settled later by the outcome pass, so a fire only answers staleness.
      // A report-settled family is PENDING: its resolver settles it from its report (directFamilySettlement).
      if (!(directResolver && directLeg === "pending")) await settleRhythm(r, directResolver ? "alpha" : "fired");
    } else if (failedToEnqueue && !pointer.dry_run) {
      await settleRhythm(r, "beta");
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
    // A resolver-backed family (FAMILY_RESOLVERS) is mapped too: it is dispatched directly, not by goal text.
    return !!fam && ((poolGoals[fam]?.length ?? 0) > 0 || !!FAMILY_GOALS[fam] || !!FAMILY_RESOLVERS[fam]);
  }).length;
  // One expression. An earlier edit split this into a ternary over regResp alone followed by a bare
  // ternary statement whose value was discarded, so the gap fired only on a failed registry read and
  // never for zero rhythms or zero mappable. A failed read leaves `rhythms` empty and still reads empty.
  const structuralBreak =
    rhythms.length === 0
      ? "registry_empty"
      : mappable === 0
        ? "registry_unmappable"
        : null;
  if (structuralBreak && pointer.dry_run !== true) {
    const summary = structuralBreak === "registry_empty"
      ? "Rhythm registry is EMPTY: rhythm_conductor_tick read zero timeShapedRhythm impulses, so nothing periodic in this substrate has a cadence. Re-seed the registry with TWO pool impulses per family: (1) timeShapedRhythm carrying axis/family/budget/alpha/beta/staleness, and (2) rhythmFamilyGoal carrying {family, goal} for the contract-phrased goal text."
      : `Rhythm registry is UNMAPPABLE: all ${rhythms.length} rhythm(s) were skipped with no_goal_mapping, so the conductor scores due-ness and has nothing to enqueue. Mount rhythmFamilyGoal pool impulses ({family, goal, member?}) for the affected families.`;

    try {
      await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: selfHeaders,
          body: JSON.stringify({
            impulse: {
              type: "substrateGap_write",
              gap: {
                id: `rhythm-cadence-${structuralBreak}`,
                category: structuralBreak,
                source: "substrate_detected",
                summary,
                detected_at: new Date().toISOString(),
                status: "open",
                structural_break: structuralBreak,
                route: structuralBreak === "registry_unmappable" || structuralBreak === "registry_empty" ? "registry_unmappable" : structuralBreak === "someCond" ? "someValue" : "dispatchable",
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

  // Close the loop: dispatch any pending queue tasks (this tick's enqueues plus any
  // left pending by prior ticks). Without this the queue is write-only and no rhythm
  // goal ever runs. Bounded per tick to avoid a dispatch flood; the rest drain next tick.
  const drained = pointer.dry_run === true || !envelope.allow
    ? 0
    : await drainBoredomQueue(pointer.queue_path ?? DEFAULT_QUEUE_PATH, pointer.max_enqueue ?? 2);

  return {
    shape: "rhythmConductorReport",
    body: {
      enqueued,
      skipped,
      drained,
      spend_envelope: envelope.reason,
      bucket_load: bucketLoad,
      load_source: pinned ? "pointer" : afford!.source,
      psi_cpu: afford?.psi_cpu ?? null,
      psi_io: afford?.psi_io ?? null,
      load: afford?.load ?? null,
      cores: afford?.cores ?? null,
      psi_fallback: afford?.psi_fallback ?? psiFallbacks,
      presence: present,
      presence_lookup: describeLookup(presenceLookup),
      considered: rhythms.length,
      registry_registered: registeredCount,
      registry_complete: registryComplete,
      // Names the break in the report too, so an operator reading a single tick sees
      // "registry_unmappable" rather than inferring it from an empty enqueued list.
      structural_break: structuralBreak,
      dry_run: pointer.dry_run === true,
      gap_id: structuralBreak === 'registry_unmappable' || structuralBreak === 'registry_empty' 
        ? `rhythm-cadence-${structuralBreak}` 
        : undefined,
    },
  };
}
