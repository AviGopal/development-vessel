/**
 * goal_reach_tick — the goal-reach SEAM (slice R: R1 observe, R4 wait, R5 re-dispatch, R6 stop, R7 learn).
 *
 * WHAT IT IS. Not a new organ: the missing seam around existing ones. A goal that did not reach is
 * parked on its prerequisite gaps (linked through `demand_goals` on gap metadata, lib/demand-goals.ts),
 * re-dispatched when every linked prerequisite has closed, stopped honestly when it cannot progress,
 * and credited as reached-by-the-system only when no operator hand touched the chain.
 *
 * STATE. One `goalReach` pool impulse per goal_hash (law 1: a shaped record, read at use time).
 *
 * SHAPE OF THE CODE. Pure functions (observe, linkGaps, nextAction, attributeReach, extractionStep,
 * summarize) plus a tick (runGoalReachTick) that drives them through an injected GoalReachIO, so the
 * logic is testable with no node. The default I/O (defaultGoalReachIO) is the only part that talks to
 * the fleet, always by shape through discovery (own-substrate producers), never a pinned port.
 *
 * WHAT R DOES NOT DO (yet). R2, the per-goal diagnoser that FILES a prerequisite and attaches the
 * goal to it, is not here: a failure with no linked gap is counted (`open_unlinked`) and left alone.
 * A blind retry with nothing fixed is not a cycle.
 *
 * THE WALK'S OWN FILINGS ARE LINKED (R2's half that needs no diagnosis). A walk that did not reach and
 * filed gaps on the way (goalWalkState learning.gapsFiled) has named its own prerequisites: each such gap,
 * if it is still OPEN, gets a `{source:"goal_reach", goal_hash, dispatch_id, origin}` demand entry
 * (substrateGap_write demand_goals_append under expect_status "open": idempotent, never a reopen). That
 * is the link the wait (R4) and the re-dispatch (R5) read. A filed gap that is closed, missing, or not a
 * gap id is NOT linked and is reported (linked_filed.skipped + a journal line), never dropped silently.
 * Linking is bookkeeping, not an action on a goal, so it runs in dry-run too (like the tick ledger);
 * goalReachPolicy.link_filed_gaps (default true) is its switch.
 *
 * R2, RECOGNITION BY CONTENT FAILURE (goal-deficiency.ts). A goal whose runs keep being judged not reached for one named
 * deficiency gets ONE open gap per (goal, reason class), linked to it, with a class-2 falsifier on goal_reach_verdict.
 * Its tally is bookkeeping (written in dry-run too); goalDeficiencyPolicy.file_gaps is its switch.
 *
 * R7 IS A MEASUREMENT, not a dispatch: on a reach without hands, R reads the template store for a
 * template whose provenance (`extracted_from` / `metadata.sourceExecutionId`) is the reaching execution,
 * records found/absent/unknown, and on absent appends evidence to the ribosome gap. goal-host's own
 * mintReachedTrace is the extraction path; R only checks that it produced something.
 *
 * THE OBSERVABLE MARK of an R re-dispatch on live traffic: goal-host stamps `trigger: "goal_reach"` on
 * the dispatch record (activeDispatches / goalWalkState / GET /executions/:id), derived from the
 * `dispatcher_reason:goal_reach` tag this tick sends, plus one journal line
 * `[goal-reach] REDISPATCHED goal_hash=<h> dispatch=<id> cycle=<n>/<max>`. Count re-dispatches from
 * goal-host's records, not from goalReach records.
 */
import { REALLY_FIXED_REASONS } from "./detector-yield-registry.js";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { ResolverResult } from "./types.js";
import { linkedGoalHashes, mergeDemandGoal, type GoalReachOrigin, type GoalReachDemandEntry } from "../lib/demand-goals.js";

export { mergeDemandGoal, type GoalReachDemandEntry };

// ── goal hash ─────────────────────────────────────────────────────────────────────────────────────

/**
 * MIRROR of goal-host-vessel src/goal-target-inference.ts `goalHashOf` (origin/dev acf4922, line 29).
 * Same normalisation (NFC, lowercase, whitespace runs collapsed, trimmed, trailing [.,!?;:] stripped)
 * and the same FNV-1a 32-bit digest as 8 hex chars. A copy, not an import: goal-host is another
 * vessel. The test pins known digests, so a drift on either side shows as a red test here.
 */
export function goalHashOf(goal: string): string {
  const normalized = goal.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,!?;:]+$/, "");
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** goal-host's activeDispatches serializer cuts `goal` at 200 chars (`r.goal.slice(0, 200)`). */
export const ACTIVE_DISPATCHES_GOAL_CUT = 200;

// ── write-effect shapes ───────────────────────────────────────────────────────────────────────────

/**
 * MIRROR of goal-host-vessel's two write classifications (origin/dev acf4922), unioned:
 *   src/walk-pool.ts:250 isWriteShape — `_write` suffix, `write_note`, fs_write/fs_edit/file*Result;
 *   src/fs-write-shapes.ts FS_WRITE_SHAPES — the filesystem/commit writes a walk must never self-produce.
 * A shared copy (goal-host is another vessel); keep in step with both.
 */
export const FS_WRITE_SHAPES: ReadonlySet<string> = new Set([
  "fs_edit", "fs_write", "fileEditResult", "fileWriteResult",
  "code_replace_lines", "code_insert_after_line", "code_add_import",
  "codeReplaceResult", "codeInsertResult", "codeAddImportResult",
  "gitCommitResult",
]);
export function isWriteEffectShape(shape: unknown): boolean {
  if (typeof shape !== "string" || !shape) return false;
  return /_write$/.test(shape) || /(^|:)write_note$/.test(shape) || /^(fs_write|fs_edit|fileWriteResult|fileEditResult)$/.test(shape)
    || FS_WRITE_SHAPES.has(shape);
}

// ── types ─────────────────────────────────────────────────────────────────────────────────────────

/** One goal-host dispatch as R observes it (activeDispatches row, enriched from goalWalkState). */
export interface DispatchObservation {
  dispatchId: string;
  goal: string | null;
  /** Set when the goal text is known to be complete (goalWalkState), not the 200-char activeDispatches cut. */
  goal_full?: boolean;
  goal_hash?: string | null;
  status: string;
  reached: boolean | null;
  operator: string | null;
  trigger: string | null;
  startedAt: number;
  endedAt?: number | null;
  node?: string | null;
  executionId?: string | null;
  selectedTemplateId?: string | null;
  goalReachReason?: string | null;
  poolShapes?: string[];
  completionShapes?: string[] | null;
  cost_usd?: number | null;
  edit_sites?: string[];
  /** Gap ids this walk filed (goalWalkState learning.gapsFiled): the prerequisites it named itself. */
  gaps_filed?: unknown[];
}

export interface ChainEntry {
  dispatchId: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  reached: boolean | null;
  trigger: string | null;
  operator: string | null;
  node: string | null;
  cost_usd: number | null;
  signature: string | null;
  write_shapes: string[];
  executionId: string | null;
  selectedTemplateId: string | null;
  edit_sites: string[];
}

export type ReachStatus = "open" | "waiting" | "redispatching" | "reached" | "stopped";
export type HandsVerdict = "true" | "possible" | "false";
/**
 * Who a reach is credited to. `hands`: an operator or surface human touched the chain. `possible`: an
 * unattributable (unknown-route) landing touched it. `autonomous_other`: no hands, but a non-R autonomous
 * dispatcher (boredom, rhythm, ...) reached it: reached-without-hands for the user's metric, NOT credited
 * to R. `r`: R's own re-dispatch reached it with no hands anywhere.
 */
export type ReachAttribution = "hands" | "possible" | "autonomous_other" | "r";
export type ExtractionStatus = "not_attempted" | "pending" | "found" | "absent" | "unknown";

export interface GoalReachRecord {
  goal: string;
  goal_hash: string;
  origin: GoalReachOrigin;
  /** The operator id the goal's first observed dispatch carried (who an ask goes to), or null. */
  origin_operator: string | null;
  /** The dispatch chain for this goal_hash, oldest first. */
  dispatches: ChainEntry[];
  /** Dispatch ids this tick issued (re-dispatches). */
  r_issued: string[];
  /** The re-dispatches a LANDING on an open linked gap triggered: landing sha → redispatch id, so a reach can show its chain. */
  redispatch_triggers?: Array<{ dispatch_id: string; landed: Array<{ gap: string; sha: string; at: string }> }>;
  last_redispatch_at: number | null;
  /** Gap ids currently linked / ever linked / currently open among the linked. */
  linked: string[];
  linked_ever: string[];
  waiting_on: string[];
  cycles: number;
  cost_usd: number;
  cost_known: boolean;
  status: ReachStatus;
  stop_reason?: string;
  limit_proposal_filed?: boolean;
  attribution: ReachAttribution;
  attribution_reasons: string[];
  /** Set once attribution was taken at reach time; later evidence does not re-grade a reach. */
  attribution_final: boolean;
  /** Derived from attribution for the design's field: hands→"true", possible→"possible", else "false". */
  operator_hands: HandsVerdict;
  reached_nodes: string[];
  reached_dispatch_id?: string;
  reached_execution_id?: string;
  reached_template_id?: string;
  reached_at?: number;
  first_failure_at: number | null;
  /** Break signatures of the failed dispatches, in chain order (duplicates kept: futility reads them). */
  break_signatures: string[];
  landed_write_shapes: string[];
  extracted_template_id?: string;
  extraction: { status: ExtractionStatus; reason?: string; checked_at?: number };
  extraction_evidence_filed?: boolean;
  last_action?: { kind: string; reason?: string; at: number };
  created_at: number;
  updated_at: number;
}

/** A gap as R reads it. */
export interface GapView {
  id: string;
  status: string;
  source: string;
  closed_reason?: string | null;
  closed_at?: string | null;
  edit_site?: string | null;
  demand_goals?: unknown;
  reopen_count?: number;
  /** When the lane last LANDED a change for this gap that is not yet verified (pending_set_at with a pending sha), else null. */
  landed_at?: string | null;
  landed_sha?: string | null;
}

/** One landing on the attempt ledger, classified by ROUTE (never by git author strings). */
export interface LandingView {
  sha: string;
  at: number;
  route: "substrate" | "operator" | "unknown";
  files: string[];
}

export interface GoalReachPolicy {
  max_cycles: number;
  max_cost_usd: number;
  /** An issued re-dispatch not seen on any goal-host after this long is treated as lost. */
  pending_timeout_ms: number;
  /** goalWalkState detail reads per tick (bounds the tick's fan-out). */
  max_detail_reads: number;
  /** R7: how long after a reach the template store may still produce its extracted template. */
  extraction_window_ms: number;
  /** The caller's floor: a full tick (which loads the whole gap store) runs at most this often. */
  min_interval_s: number;
  /** Log and grade would-actions only: no re-dispatch, no record/evidence/limit writes. Flipping it is a recorded step. */
  dry_run: boolean;
  /** Link the gaps a non-reaching walk filed to its goal (bookkeeping: runs in dry-run too). */
  link_filed_gaps: boolean;
}
/** Interim defaults until slice L; overridden by the newest open `goalReachPolicy` pool record (law 1). */
export const DEFAULT_GOAL_REACH_POLICY: GoalReachPolicy = {
  max_cycles: 5,
  max_cost_usd: 5,
  pending_timeout_ms: 30 * 60_000,
  max_detail_reads: 20,
  extraction_window_ms: 30 * 60_000,
  min_interval_s: 300,
  dry_run: true,
  link_filed_gaps: true,
};

export type GoalReachAction =
  | { kind: "none"; reason: string }
  | { kind: "wait"; waiting_on: string[] }
  | { kind: "redispatch"; goal: string; goal_hash: string; landed?: Array<{ gap: string; sha: string; at: string }> }
  | { kind: "stop"; reason: string; limit_proposal?: { goal_hash: string; paths: string[]; gap_ids: string[] } }
  | { kind: "ask_human"; reason: string; write_shapes: string[]; addressee: string };

// ── classification helpers ────────────────────────────────────────────────────────────────────────

/** A goal hash as goal-reach records carry it. */
const GOAL_HASH_TOKEN = /^[0-9a-f]{8}$/;
/** A listing row whose goal text is the 200-char cut and not yet completed by a detail read. */
export const isCutGoal = (d: Pick<DispatchObservation, "goal" | "goal_full">): boolean =>
  typeof d.goal === "string" && !d.goal_full && d.goal.length >= ACTIVE_DISPATCHES_GOAL_CUT;

/**
 * What the prior records already know (C-longgoal-1): terminal dispatch ids WITH the goal hash of the record that holds them, so
 * a listing row whose goal is only the 200-char cut still hashes, without a detail read. A record without a usable hash
 * (written before hashes existed) makes NONE of its dispatches known: they get a detail read, never a silent skip.
 */
export function knownFromRecords(prior: Record<string, GoalReachRecord>): { known: Set<string>; known_hashes: Map<string, string>; r_issued: Set<string> } {
  const known = new Set<string>(), known_hashes = new Map<string, string>(), r_issued = new Set<string>();
  for (const r of Object.values(prior)) {
    const h = typeof r.goal_hash === "string" && GOAL_HASH_TOKEN.test(r.goal_hash) ? r.goal_hash : null;
    for (const e of r.dispatches) if (isTerminal(e.status) && h) { known.add(e.dispatchId); known_hashes.set(e.dispatchId, h); }
    for (const id of r.r_issued ?? []) r_issued.add(id);
  }
  return { known, known_hashes, r_issued };
}

/**
 * Which listing rows get a detail read this tick, in order, at most `budget`. Rows still unhashable (a cut goal and no
 * known hash) come first, so a cut goal is never starved by detail reads that only refine rows already hashed.
 */
export function detailReadOrder(
  obs: readonly DispatchObservation[],
  ctx: { known: Set<string>; r_issued: Set<string> },
  budget: number,
): string[] {
  const want = obs.filter((o) => {
    if (ctx.known.has(o.dispatchId)) return false;
    const failedTerminal = o.status !== "running" && o.reached !== true;
    return failedTerminal || ctx.r_issued.has(o.dispatchId) || isCutGoal(o);
  });
  const unhashable = (o: DispatchObservation) => isCutGoal(o) && !o.goal_hash;
  return [...want.filter(unhashable), ...want.filter((o) => !unhashable(o))].slice(0, Math.max(0, budget)).map((o) => o.dispatchId);
}

/** A known run's cut goal hashes under the record that holds it (C-longgoal-1). Returns the same observation. */
export function applyKnownHash(obs: DispatchObservation, known_hashes: Map<string, string> | undefined): DispatchObservation {
  const kh = known_hashes?.get(obs.dispatchId);
  if (kh && isCutGoal(obs) && !obs.goal_hash) obs.goal_hash = kh;
  return obs;
}

/** The runs R2 cannot tally this tick because they have no goal hash, and how many of those are a cut goal (G3: always reported). */
export function unhashedRuns(dispatches: readonly DispatchObservation[]): { no_goal_hash: number; cut_goal: number } {
  let no_goal_hash = 0, cut_goal = 0;
  for (const d of dispatches) if (!dispatchGoalHash(d)) { no_goal_hash++; if (isCutGoal(d)) cut_goal++; }
  return { no_goal_hash, cut_goal };
}

/** The goal_hash of a dispatch, or null when its goal text may be the activeDispatches 200-char cut. */
export function dispatchGoalHash(d: DispatchObservation): string | null {
  if (typeof d.goal_hash === "string" && d.goal_hash.length > 0) return d.goal_hash;
  if (typeof d.goal !== "string" || d.goal.trim().length === 0) return null;
  if (!d.goal_full && d.goal.length >= ACTIVE_DISPATCHES_GOAL_CUT) return null;
  return goalHashOf(d.goal);
}

/**
 * Who posed the goal, from the FIRST dispatch of its chain. goal-host derives trigger "operator" from
 * ANY operator id, and the Obsidian surface stamps the vault's operator id too, so the operator/surface
 * split is read from the id itself (an obsidian/vault/surface/human id is a surface) or trigger "note".
 * Unverified against every surface; the write guard therefore treats operator AND surface alike.
 */
/**
 * Operator ids MACHINE dispatchers stamp. goal-host maps any operator id to trigger "operator", so
 * these would read as a human without this list. Census of origin/dev operator literals + live
 * activeDispatches (2026-10-02): rhythm-conductor-tick.ts drain (`rhythm-conductor-drain`),
 * scripts/substrate/learning-liveness-probe.ts, scripts/substrate/substrate-status.sh (known-answer
 * probe), scripts/substrate/learning-loop-selftest-tick.ts (its PROBE_TAG, matched by prefix).
 * Human ids seen live: human-surface, claude-code-operator, codex-operator.
 */
export const MACHINE_OPERATOR_IDS: ReadonlySet<string> = new Set(["rhythm-conductor-drain", "learning-liveness-probe", "substrate-status"]);
export function isHumanOperatorId(op: unknown): boolean {
  if (typeof op !== "string") return false;
  const o = op.trim();
  if (!o) return false;
  return !MACHINE_OPERATOR_IDS.has(o) && !/^learning-loop-selftest/.test(o);
}

export function originOf(d: Pick<DispatchObservation, "operator" | "trigger">): GoalReachOrigin {
  const op = typeof d.operator === "string" ? d.operator.trim() : "";
  if (d.trigger === "note") return "surface";
  if (!isHumanOperatorId(op)) return "autonomous";
  if (/obsidian|vault|surface|human/i.test(op)) return "surface";
  return "operator";
}

/** R-issued iff R recorded the id when it dispatched, or goal-host derived trigger "goal_reach" from R's tag. */
export function isRIssued(rec: Pick<GoalReachRecord, "r_issued">, d: { dispatchId: string; trigger: string | null }): boolean {
  return rec.r_issued.includes(d.dispatchId) || d.trigger === "goal_reach";
}

/**
 * Break signature of a failed dispatch: its normalised goalReachReason (volatile ids, hashes and long
 * numbers stripped). R2 will refine this to (edit_site, break); until then the reach judge's reason is
 * the best per-dispatch break key goal-host exposes.
 */
export function breakSignature(d: Pick<DispatchObservation, "reached" | "status" | "goalReachReason" | "selectedTemplateId">): string | null {
  if (d.reached !== false || d.status === "running") return null;
  const raw = typeof d.goalReachReason === "string" ? d.goalReachReason : "";
  const norm = raw.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<h>")
    .replace(/\d{3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return norm.length > 0 ? norm : "unexplained";
}

const isTerminal = (status: string): boolean => status !== "running" && status !== "pending";

// ── R1: observe ───────────────────────────────────────────────────────────────────────────────────

function emptyRecord(goal: string, hash: string, origin: GoalReachOrigin, now: number): GoalReachRecord {
  return {
    goal, goal_hash: hash, origin, origin_operator: null, dispatches: [], r_issued: [], last_redispatch_at: null,
    linked: [], linked_ever: [], waiting_on: [], cycles: 0, cost_usd: 0, cost_known: true,
    status: "open", attribution: "r", attribution_reasons: [], attribution_final: false, operator_hands: "false",
    reached_nodes: [], first_failure_at: null, break_signatures: [], landed_write_shapes: [],
    extraction: { status: "not_attempted" }, created_at: now, updated_at: now,
  };
}

function toChainEntry(d: DispatchObservation): ChainEntry {
  const shapes = [...(d.poolShapes ?? []), ...(d.completionShapes ?? [])];
  return {
    dispatchId: d.dispatchId, startedAt: d.startedAt, endedAt: d.endedAt ?? null, status: d.status, reached: d.reached,
    trigger: d.trigger ?? null, operator: d.operator ?? null, node: d.node ?? null,
    cost_usd: typeof d.cost_usd === "number" && Number.isFinite(d.cost_usd) ? d.cost_usd : null,
    signature: breakSignature(d), write_shapes: [...new Set(shapes.filter(isWriteEffectShape))],
    executionId: d.executionId ?? null, selectedTemplateId: d.selectedTemplateId ?? null, edit_sites: d.edit_sites ?? [],
  };
}

/** Recompute every derived field of a record from its chain (idempotent). */
function recompute(rec: GoalReachRecord, now: number, policy: Pick<GoalReachPolicy, "pending_timeout_ms"> = DEFAULT_GOAL_REACH_POLICY): void {
  rec.dispatches.sort((a, b) => a.startedAt - b.startedAt);
  const chain = rec.dispatches;
  const firstFail = chain.find((e) => isTerminal(e.status) && e.reached !== true);
  rec.first_failure_at = firstFail ? firstFail.startedAt : null;
  const terminal = chain.filter((e) => isTerminal(e.status));
  rec.cost_usd = terminal.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  rec.cost_known = terminal.every((e) => e.cost_usd !== null);
  rec.break_signatures = chain.map((e) => e.signature).filter((s): s is string => s !== null);
  rec.cycles = chain.filter((e) => isRIssued(rec, e)).length
    + rec.r_issued.filter((id) => !chain.some((e) => e.dispatchId === id)).length;
  rec.landed_write_shapes = [...new Set(chain.flatMap((e) => e.write_shapes))];
  if (rec.status === "stopped" && !chain.some((e) => e.reached === true && rec.first_failure_at !== null && e.startedAt >= rec.first_failure_at)) return;
  const reachedAfter = rec.first_failure_at === null ? [] : chain.filter((e) => e.reached === true && e.startedAt >= rec.first_failure_at!);
  if (reachedAfter.length > 0) {
    const first = reachedAfter[0]!;
    rec.status = "reached";
    rec.reached_nodes = [...new Set(reachedAfter.map((e) => e.node).filter((n): n is string => !!n))];
    rec.reached_dispatch_id = first.dispatchId;
    if (first.executionId) rec.reached_execution_id = first.executionId;
    if (first.selectedTemplateId) rec.reached_template_id = first.selectedTemplateId;
    rec.reached_at = rec.reached_at ?? first.endedAt ?? now;
    return;
  }
  const pending = rec.r_issued.filter((id) => !chain.some((e) => e.dispatchId === id));
  const latest = chain[chain.length - 1];
  const pendingLive = pending.length > 0 && rec.last_redispatch_at !== null && now - rec.last_redispatch_at < policy.pending_timeout_ms;
  if (pendingLive || (latest && !isTerminal(latest.status) && isRIssued(rec, latest))) rec.status = "redispatching";
  else rec.status = rec.waiting_on.length > 0 ? "waiting" : "open";
}

/**
 * R1. Upsert records from goal-host dispatch observations. A record is OPENED only by a non-reached
 * terminal dispatch (a goal that reached first time needs nothing); every later dispatch of a tracked
 * goal_hash joins its chain. Returns a new map; never mutates `records`.
 */
export function observe(records: Record<string, GoalReachRecord>, dispatches: DispatchObservation[], now: number, policy?: Pick<GoalReachPolicy, "pending_timeout_ms">): Record<string, GoalReachRecord> {
  const out: Record<string, GoalReachRecord> = JSON.parse(JSON.stringify(records ?? {}));
  const touched = new Set<string>();
  for (const d of [...dispatches].sort((a, b) => a.startedAt - b.startedAt)) {
    const h = dispatchGoalHash(d);
    if (!h) continue;
    let rec = out[h];
    if (!rec) {
      if (!(isTerminal(d.status) && d.reached !== true)) continue;
      rec = out[h] = emptyRecord(String(d.goal), h, originOf(d), now);
      rec.origin_operator = d.operator ?? null;
    }
    if (d.goal_full && typeof d.goal === "string" && d.goal.length > rec.goal.length) rec.goal = d.goal;
    const entry = toChainEntry(d);
    const i = rec.dispatches.findIndex((e) => e.dispatchId === d.dispatchId);
    if (i >= 0) {
      const prev = rec.dispatches[i]!;
      // A later, thinner observation (activeDispatches without walk detail) must not erase detail.
      rec.dispatches[i] = {
        ...entry,
        signature: entry.signature ?? prev.signature,
        write_shapes: entry.write_shapes.length ? entry.write_shapes : prev.write_shapes,
        cost_usd: entry.cost_usd ?? prev.cost_usd,
        edit_sites: entry.edit_sites.length ? entry.edit_sites : prev.edit_sites,
        executionId: entry.executionId ?? prev.executionId,
        selectedTemplateId: entry.selectedTemplateId ?? prev.selectedTemplateId,
      };
    } else {
      rec.dispatches.push(entry);
      if (rec.dispatches.length === 1) { rec.origin = originOf(d); rec.origin_operator = d.operator ?? null; }
    }
    touched.add(h);
  }
  for (const h of Object.keys(out)) {
    const rec = out[h]!;
    recompute(rec, now, policy);
    if (touched.has(h)) rec.updated_at = now;
  }
  return out;
}

// ── R4: link and wait ─────────────────────────────────────────────────────────────────────────────

/**
 * A gap blocks a goal iff its demand_goals carries a `{source:"goal_reach", goal_hash}` entry for that
 * goal_hash. Legacy string entries (goal-host fileCapabilityGap's demand ledger) are never linkage.
 * Mutates `rec`: linked, linked_ever, waiting_on, and status open↔waiting.
 */
export function linkGaps(rec: GoalReachRecord, gaps: GapView[]): GoalReachRecord {
  const linked = gaps.filter((g) => linkedGoalHashes(g.demand_goals).includes(rec.goal_hash));
  rec.linked = linked.map((g) => g.id);
  rec.linked_ever = [...new Set([...rec.linked_ever, ...rec.linked])];
  rec.waiting_on = linked.filter((g) => g.status === "open").map((g) => g.id);
  if (rec.status === "open" || rec.status === "waiting") rec.status = rec.waiting_on.length > 0 ? "waiting" : "open";
  return rec;
}

// ── R5/R6: decide ─────────────────────────────────────────────────────────────────────────────────

/** The repeated signature an R cycle produced, or null. Repeats among non-R attempts are not futility. */
function futileSignature(rec: GoalReachRecord): string | null {
  const seen = new Set<string>();
  for (const e of rec.dispatches) {
    if (e.signature === null) continue;
    if (isRIssued(rec, e) && seen.has(e.signature)) return e.signature;
    seen.add(e.signature);
  }
  return null;
}

/**
 * Writes whose resolver UPSERTS by a caller-supplied id, so replaying them rewrites one row instead of
 * adding an effect: memoryNote_write (upsert by id), poolImpulse_write (pool-impulse.ts, upsert by id),
 * substrateGap_write (the id is the idempotency key). Re-running a goal that landed only these needs no ask.
 */
export const IDEMPOTENT_BY_KEY_WRITE_SHAPES: ReadonlySet<string> = new Set(["memoryNote_write", "poolImpulse_write", "substrateGap_write"]);
/** Who an ask goes to: the goal's ORIGIN. An operator-session goal asks that operator id; a surface goal its human. */
export function askAddressee(rec: Pick<GoalReachRecord, "origin" | "origin_operator">): string {
  return `${rec.origin}:${rec.origin_operator ?? (rec.origin === "surface" ? "note" : "unknown")}`;
}

const gapClosedAt = (g: GapView): number => (typeof g.closed_at === "string" ? Date.parse(g.closed_at) : NaN);
const gapLandedAt = (g: GapView): number => (typeof g.landed_at === "string" && g.landed_sha ? Date.parse(g.landed_at) : NaN);

export function nextAction(
  rec: GoalReachRecord,
  gaps: GapView[],
  policy: GoalReachPolicy,
  ctx: { scopeExcludes?: ((path: string) => string | null) | null } = {},
): GoalReachAction {
  if (rec.status === "reached" || rec.status === "stopped") return { kind: "none", reason: "terminal" };
  if (rec.status === "redispatching") return { kind: "none", reason: "in_flight" };
  const latest = rec.dispatches[rec.dispatches.length - 1];
  if (latest && !isTerminal(latest.status)) return { kind: "none", reason: "in_flight" };

  const futile = futileSignature(rec);
  if (futile) return { kind: "stop", reason: `futile:${futile}` };
  if (rec.cycles >= policy.max_cycles) return { kind: "stop", reason: "budget:cycles" };
  if (rec.cost_known && rec.cost_usd >= policy.max_cost_usd) return { kind: "stop", reason: "budget:cost" };

  const byId = new Map(gaps.map((g) => [g.id, g]));
  const linked = rec.linked.map((id) => byId.get(id)).filter((g): g is GapView => !!g);
  const open = linked.filter((g) => g.status === "open");
  if (ctx.scopeExcludes) {
    const blocked = open.filter((g) => typeof g.edit_site === "string" && g.edit_site && ctx.scopeExcludes!(g.edit_site) !== null);
    if (blocked.length > 0) {
      const paths = [...new Set(blocked.map((g) => String(g.edit_site)))];
      return { kind: "stop", reason: `blocked_by_scope:${paths.join(",")}`, limit_proposal: { goal_hash: rec.goal_hash, paths, gap_ids: blocked.map((g) => g.id) } };
    }
  }
  const lastAttempt = latest ? latest.startedAt : 0;
  // AN OPEN GAP WHOSE FIX HAS LANDED IS TESTED BY RUNNING THE GOAL. A gap judged by the goal's own reach (its falsifier is a
  // later reach) can never close while the goal waits on it: a landing newer than the last attempt re-runs the goal once
  // (the next attempt is newer than that landing, so the same landing never re-runs it twice). Budgets and scope above.
  const landedSince = open.filter((g) => gapLandedAt(g) > lastAttempt);
  if (open.length > 0 && landedSince.length === 0) return { kind: "wait", waiting_on: open.map((g) => g.id) };
  if (linked.length === 0) return { kind: "none", reason: "unlinked" };

  // Only a REPAIR closure re-runs the goal. An expiry or give-up close (expired_not_redetected: "we stopped seeing it",
  // indistinguishable from "we stopped looking"; churned_unlandable; persistent_compose_failure; walk_artifact) is not
  // evidence the condition is gone, and a reach after it would be scored reached_without_hands, the headline measure
  // (81% of 487 closes in 10 days were such reasons, 2026-10-16). One "really fixed" rule: detector-yield-registry's.
  if (landedSince.length === 0 && !linked.some((g) => gapClosedAt(g) > lastAttempt && REALLY_FIXED_REASONS.has(String(g.closed_reason ?? "")))) return { kind: "none", reason: "no_new_closure" };

  const unkeyed = rec.landed_write_shapes.filter((w) => !IDEMPOTENT_BY_KEY_WRITE_SHAPES.has(w));
  if (rec.origin !== "autonomous" && unkeyed.length > 0) {
    return { kind: "ask_human", reason: `${rec.origin} goal landed writes on an earlier attempt`, write_shapes: unkeyed, addressee: askAddressee(rec) };
  }
  const landed = landedSince.map((g) => ({ gap: g.id, sha: String(g.landed_sha), at: String(g.landed_at) }));
  return { kind: "redispatch", goal: rec.goal, goal_hash: rec.goal_hash, ...(landed.length ? { landed } : {}) };
}

// ── attribution ───────────────────────────────────────────────────────────────────────────────────

/**
 * Close reasons written by an autonomous closer (the store's own sweeps, the lane's verified landing,
 * detectors). Any other closed state — `human_dropped`, or no reason at all — is a hand close.
 * Grep of dev-vessel origin/dev 182d2447 for closed_reason writers.
 */
export const AUTONOMOUS_CLOSE_REASONS: ReadonlySet<string> = new Set([
  "landed_verified", "landed_literal_only", "landed_partial", "already_resolved", "condition_gone", "producer_now_exists",
  "predicate_verified_by_detector", "violation_not_reproduced_on_rescan", "closed_via_child",
  "expired_not_redetected", "churned_unlandable", "persistent_compose_failure", "walk_artifact",
  // doc_drift_fix: a documentation fix that landed through the cutover (close_needs_evidence, 2026-10-03).
  "doc_fix_landed",
]);
const isOperatorRouteSource = (s: unknown): boolean => typeof s === "string" && (s === "human_reported" || /^operator/.test(s));
/** A dispatch a human made: goal-host trigger "operator" (any operator id) or a surface/note dispatch. */
const isHumanDispatch = (e: Pick<ChainEntry, "trigger" | "operator">): boolean =>
  e.trigger === "note" || isHumanOperatorId(e.operator);

const normPath = (p: string): string => String(p).replace(/:\d+.*$/, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^repos\//, "").trim();
const samePath = (a: string, b: string): boolean => {
  const x = normPath(a), y = normPath(b);
  return x.length > 0 && y.length > 0 && (x === y || x.endsWith("/" + y) || y.endsWith("/" + x));
};

/**
 * Attribute a reach. hands: any human (operator or surface) dispatch on the chain after the first
 * failure (including the one that reached), any linked prerequisite with an operator-route source
 * (human_reported / operator_*: an operator filing it or arming its check; the store keeps the LAST
 * writer's source) or closed by hand, or an operator-route landing on an edit site between first failure
 * and reach. possible: only an unknown-route landing on an edit site. Otherwise credit goes to the
 * dispatch that reached: R's own → "r", any other autonomous dispatcher → "autonomous_other".
 */
export function attributeReach(rec: GoalReachRecord, gaps: GapView[], landings: LandingView[], now = Date.now()): { attribution: ReachAttribution; reasons: string[] } {
  const hands: string[] = [];
  const F = rec.first_failure_at;
  if (F !== null) {
    for (const e of rec.dispatches) if (e.startedAt > F && isHumanDispatch(e)) hands.push(`operator_dispatch:${e.dispatchId}:${e.trigger ?? "unknown"}`);
  }
  const byId = new Map(gaps.map((g) => [g.id, g]));
  const linked = rec.linked_ever.map((id) => byId.get(id)).filter((g): g is GapView => !!g);
  for (const g of linked) {
    if (isOperatorRouteSource(g.source)) hands.push(`operator_route_gap:${g.id}:${g.source}`);
    if (g.status !== "open" && !AUTONOMOUS_CLOSE_REASONS.has(String(g.closed_reason ?? ""))) hands.push(`hand_closed:${g.id}:${g.closed_reason ?? "no_reason"}`);
  }
  const possible: string[] = [];
  if (F !== null) {
    const until = rec.reached_at ?? now;
    const sites = [
      ...linked.map((g) => g.edit_site).filter((s): s is string => typeof s === "string" && s.length > 0),
      ...rec.dispatches.filter((e) => e.dispatchId === rec.reached_dispatch_id).flatMap((e) => e.edit_sites),
    ];
    for (const l of landings) {
      if (l.route === "substrate" || l.at < F || l.at > until) continue;
      const hit = l.files.find((f) => sites.some((s) => samePath(f, s)));
      if (!hit) continue;
      (l.route === "operator" ? hands : possible).push(`${l.route}_landing:${l.sha}:${hit}`);
    }
  }
  if (hands.length > 0) return { attribution: "hands", reasons: hands };
  if (possible.length > 0) return { attribution: "possible", reasons: possible };
  const reacher = rec.dispatches.find((e) => e.dispatchId === rec.reached_dispatch_id);
  if (reacher && isRIssued(rec, reacher)) {
    // A reach by a re-dispatch a landing triggered carries its chain (landing sha → redispatch id → reach), so grading can tell
    // a system repair's effect from an external re-run.
    const t = (rec.redispatch_triggers ?? []).find((x) => x.dispatch_id === reacher.dispatchId);
    return { attribution: "r", reasons: t ? t.landed.map((l) => `landing:${l.gap}@${l.sha}->redispatch:${reacher.dispatchId}->reach`) : [] };
  }
  return { attribution: "autonomous_other", reasons: [`reached_by:${reacher?.dispatchId ?? "unknown"}:${reacher?.trigger ?? "unknown"}`] };
}
const handsOf = (a: ReachAttribution): HandsVerdict => (a === "hands" ? "true" : a === "possible" ? "possible" : "false");

// ── R7: measure learning ──────────────────────────────────────────────────────────────────────────

/** Only a graded reach without hands is measured, and only until a found/absent verdict. */
export function needsExtractionCheck(rec: GoalReachRecord): boolean {
  return rec.status === "reached" && rec.attribution_final && (rec.attribution === "r" || rec.attribution === "autonomous_other")
    && !!rec.reached_execution_id && rec.extraction.status !== "found" && rec.extraction.status !== "absent";
}

/**
 * The template whose provenance is `executionId`. The field names are the ribosome's own: the
 * ribosome-extract template (ias-executor-ts src/templates/lifecycle/ribosome-extract.json) MUST write
 * `metadata.extracted_from` and `metadata.sourceExecutionId` = lifecycle.executionId, and activity-api's
 * template write (routes/activities.ts, "Ratchet lineage") persists metadata.extracted_from onto the
 * `activity` row's top-level `extracted_from` column. `source_execution_id` is the schema's alias.
 */
export function matchExtractedTemplate(templates: Array<Record<string, unknown>>, executionId: string): string | null {
  for (const t of templates) {
    const m = (t["metadata"] ?? {}) as Record<string, unknown>;
    const ids = [t["extracted_from"], t["source_execution_id"], m["extracted_from"], m["sourceExecutionId"]];
    if (ids.some((x) => x === executionId)) return String(t["id"] ?? t["template_id"] ?? "unknown");
  }
  return null;
}

/**
 * One measurement step. Unreadable store → "unknown", never "absent". Not found inside the window →
 * "pending" (the extraction may still land). Not found after it → "absent" and evidence is filed once.
 * A template counts only if it was written (updated_at) in [reach − 1 min, reach + window].
 */
export function extractionStep(
  rec: GoalReachRecord,
  read: { ok: true; templates: Array<Record<string, unknown>> } | { ok: false; why: string },
  now: number,
  policy: Pick<GoalReachPolicy, "extraction_window_ms">,
): { extraction: GoalReachRecord["extraction"]; extracted_template_id?: string; file_evidence: boolean } {
  if (!read.ok) return { extraction: { status: "unknown", reason: `template store unreadable: ${read.why}`, checked_at: now }, file_evidence: false };
  const from = (rec.reached_at ?? now) - 60_000;
  const until = (rec.reached_at ?? now) + policy.extraction_window_ms;
  const inWindow = read.templates.filter((t) => {
    const at = Date.parse(String(t["updated_at"] ?? t["created_at"] ?? ""));
    return Number.isFinite(at) && at >= from && at <= until;
  });
  const id = matchExtractedTemplate(inWindow, String(rec.reached_execution_id));
  if (id) return { extraction: { status: "found", checked_at: now }, extracted_template_id: id, file_evidence: false };
  if (now <= until) return { extraction: { status: "pending", checked_at: now }, file_evidence: false };
  return { extraction: { status: "absent", reason: `no template with provenance ${rec.reached_execution_id} written within ${Math.round(policy.extraction_window_ms / 60_000)} min of the reach`, checked_at: now }, file_evidence: !rec.extraction_evidence_filed };
}

/** The ribosome gap R's absent verdicts are evidence for. */
export const RIBOSOME_EVIDENCE_GAP_ID = "the-ribosome-learns-from-self-scan-ticks-and-auth-traces-instead-of-reached-goals";
/** Append an evidence entry, idempotent per goal_hash; every existing entry is kept. */
export function appendEvidenceEntry(existing: unknown, entry: { goal_hash: string } & Record<string, unknown>): unknown[] {
  const base = Array.isArray(existing) ? existing.slice() : [];
  if (base.some((x) => !!x && typeof x === "object" && (x as { goal_hash?: unknown }).goal_hash === entry.goal_hash)) return base;
  base.push(entry);
  return base;
}

// ── the reader: summary ───────────────────────────────────────────────────────────────────────────

export interface GoalReachSummary {
  goals: number;
  open_unlinked: number;
  open_linked: number;
  waiting: number;
  redispatching: number;
  reached: number;
  /** The user's metric: reached with no hands, by R or by any other autonomous dispatcher. */
  reached_without_hands: number;
  /** R's own credit: reached by R's re-dispatch with no hands. */
  reached_by_r: number;
  reached_by_autonomous_other: number;
  /** Reached, but attribution could not be taken yet (ledger unreadable): never counted as success. */
  reached_ungraded: number;
  reached_hands_possible: number;
  reached_hands: number;
  stopped: number;
  stopped_by_reason: Record<string, number>;
  extraction_found: number;
  extraction_absent: number;
  extraction_unknown: number;
}
const reasonKey = (r: string | undefined): string => {
  const s = String(r ?? "unknown");
  return s.startsWith("budget:") ? s : s.split(":")[0]!;
};
export function summarize(records: GoalReachRecord[]): GoalReachSummary {
  const s: GoalReachSummary = {
    goals: records.length, open_unlinked: 0, open_linked: 0, waiting: 0, redispatching: 0, reached: 0,
    reached_without_hands: 0, reached_by_r: 0, reached_by_autonomous_other: 0, reached_ungraded: 0, reached_hands_possible: 0, reached_hands: 0,
    stopped: 0, stopped_by_reason: {}, extraction_found: 0, extraction_absent: 0, extraction_unknown: 0,
  };
  for (const r of records) {
    if (r.status === "open") { if (r.linked.length === 0) s.open_unlinked++; else s.open_linked++; }
    else if (r.status === "waiting") s.waiting++;
    else if (r.status === "redispatching") s.redispatching++;
    else if (r.status === "reached") {
      s.reached++;
      if (!r.attribution_final) s.reached_ungraded++;
      else if (r.attribution === "r") { s.reached_without_hands++; s.reached_by_r++; }
      else if (r.attribution === "autonomous_other") { s.reached_without_hands++; s.reached_by_autonomous_other++; }
      else if (r.attribution === "possible") s.reached_hands_possible++;
      else s.reached_hands++;
    } else if (r.status === "stopped") {
      s.stopped++;
      const k = reasonKey(r.stop_reason);
      s.stopped_by_reason[k] = (s.stopped_by_reason[k] ?? 0) + 1;
    }
    if (r.extraction.status === "found") s.extraction_found++;
    else if (r.extraction.status === "absent") s.extraction_absent++;
    else if (r.extraction.status === "unknown") s.extraction_unknown++;
  }
  return s;
}

// ── the caller condition ──────────────────────────────────────────────────────────────────────────

/**
 * Should a full tick run now? Cheap by construction (pool records + one activeDispatches page; no gap
 * store read), so a mis-selection by the idle selector costs almost nothing and earns nothing.
 * Run iff min_interval_s has passed since the last full tick AND there is work: a non-reached terminal
 * dispatch no goalReach record holds yet, or a record waiting / redispatching / with its reach's
 * extraction still undecided.
 */
export function tickEligibility(
  input: { records: Record<string, GoalReachRecord>; peek: Array<{ dispatchId: string; status: string; reached: boolean | null }>; last_run_at: number | null },
  now: number,
  policy: Pick<GoalReachPolicy, "min_interval_s">,
): { run: boolean; reason: string } {
  if (input.last_run_at !== null && now - input.last_run_at < policy.min_interval_s * 1000) {
    return { run: false, reason: `min_interval: last full tick ${Math.round((now - input.last_run_at) / 1000)}s ago < ${policy.min_interval_s}s` };
  }
  const tracked = new Set<string>();
  for (const r of Object.values(input.records)) for (const e of r.dispatches) tracked.add(e.dispatchId);
  const untracked = input.peek.filter((p) => isTerminal(p.status) && p.reached !== true && !tracked.has(p.dispatchId)).length;
  const recs = Object.values(input.records);
  const waiting = recs.filter((r) => r.status === "waiting").length;
  const redispatching = recs.filter((r) => r.status === "redispatching").length;
  const extraction = recs.filter((r) => needsExtractionCheck(r) || (r.status === "reached" && !r.attribution_final)).length;
  const reason = `untracked_failures=${untracked} waiting=${waiting} redispatching=${redispatching} extraction_pending=${extraction}`;
  return { run: untracked + waiting + redispatching + extraction > 0, reason };
}

// ── the effect grade ──────────────────────────────────────────────────────────────────────────────

export type TickGrade = { verdict: "success" | "neutral" | "failure"; reasons: string[] };

/**
 * Grade the PREVIOUS tick on its effect, against the state this tick observed before acting.
 *   failure: an error; a (would-)redispatch while a linked gap was open at action time; a redispatch
 *     whose "closed" gap the next tick sees open WITHOUT a reopen since (the action read stale state);
 *     two actions on one goal; a duplicate (goal_hash, dispatch_id) link on a gap; an eligible goal the
 *     tick decided on but did not act on; or a goal that per the observed state was already eligible
 *     at the previous tick (every linked gap closed before it, after the goal's last attempt) and got
 *     no action.
 *   success: at least one action and no failure. neutral: nothing done and nothing missed.
 * Dry-run would-actions are graded identically, so the posterior is earned before going live.
 */
export function gradeTick(prev: TickLedger | null, observed: { records: GoalReachRecord[]; gaps: GapView[] }): TickGrade {
  if (!prev) return { verdict: "neutral", reasons: ["no previous tick"] };
  const reasons: string[] = [];
  for (const e of prev.errors) reasons.push(`error:${e.slice(0, 120)}`);
  const gapById = new Map(observed.gaps.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (const a of prev.actions) {
    if (seen.has(a.goal_hash)) reasons.push(`duplicate_action:${a.goal_hash}`);
    seen.add(a.goal_hash);
    if (a.kind !== "redispatch") continue;
    const openAtAction = a.linked.filter((l) => l.status === "open").map((l) => l.id);
    if (openAtAction.length > 0) reasons.push(`redispatch_with_open_gap:${a.goal_hash}:${openAtAction.join(",")}`);
    for (const l of a.linked) {
      const now = gapById.get(l.id);
      if (l.status !== "open" && now && now.status === "open" && (now.reopen_count ?? 0) <= l.reopen_count) {
        reasons.push(`redispatch_contradicted:${a.goal_hash}:${l.id} read closed, open with no reopen since`);
      }
    }
  }
  for (const g of observed.gaps) {
    const keys = Array.isArray(g.demand_goals)
      ? (g.demand_goals as unknown[]).filter((x): x is { source: string; goal_hash: string; dispatch_id: string } => !!x && typeof x === "object" && (x as { source?: unknown }).source === "goal_reach")
        .map((x) => `${x.goal_hash}|${x.dispatch_id}`)
      : [];
    if (new Set(keys).size !== keys.length) reasons.push(`duplicate_link:${g.id}`);
  }
  const acted = new Set(prev.actions.map((a) => a.goal_hash));
  for (const h of prev.eligible) if (!acted.has(h)) reasons.push(`missed_eligible:${h}:decided but not acted on`);
  for (const r of observed.records) {
    if (acted.has(r.goal_hash) || prev.eligible.includes(r.goal_hash)) continue;
    if (r.status === "reached" || r.status === "stopped" || r.status === "redispatching") continue;
    const linked = r.linked.map((id) => gapById.get(id)).filter((g): g is GapView => !!g);
    if (linked.length === 0 || linked.some((g) => g.status === "open")) continue;
    const closes = linked.map((g) => Date.parse(String(g.closed_at ?? ""))).filter(Number.isFinite);
    if (closes.length !== linked.length) continue;
    const lastAttempt = Math.max(0, ...r.dispatches.filter((e) => e.startedAt < prev.at).map((e) => e.startedAt));
    if (Math.max(...closes) < prev.at && closes.some((c) => c > lastAttempt)) reasons.push(`missed_eligible:${r.goal_hash}:all linked gaps closed before the tick`);
  }
  if (reasons.length > 0) return { verdict: "failure", reasons };
  return prev.actions.length > 0 ? { verdict: "success", reasons: [`${prev.actions.length} correct action(s)`] } : { verdict: "neutral", reasons: ["nothing eligible, nothing done"] };
}

/**
 * Put the previous tick's grade on THIS execution, in the forms the existing grading reads:
 *   failure → a structuredError result: the executor records a failed task, light-dispatch posts
 *     reach:false, activity-api applies beta to this template.
 *   success / neutral → goalReachTickResult with `information_yield` ("productive" when this tick
 *     acted, else "idle") and `findings` = this tick's actions (the array light-dispatch counts for
 *     its own information_yield). See the report for why "neutral" cannot yet avoid the late /reach.
 */
export function carryGrade(grade: TickGrade, body: { summary: unknown; actions: TickAction[] } & Record<string, unknown>): ResolverResult {
  if (grade.verdict === "failure") {
    return { shape: "structuredError", body: { resolver: "goal_reach_tick", failure_mode: "previous_tick_graded_failure", detail: `previous goal_reach tick graded failure: ${grade.reasons.slice(0, 5).join("; ")}`, previous_tick_grade: grade, ...body, findings: body.actions } };
  }
  return { shape: "goalReachTickResult", body: { ...body, previous_tick_grade: grade, findings: body.actions, information_yield: body.actions.length > 0 ? "productive" : "idle" } };
}

// ── the tick ──────────────────────────────────────────────────────────────────────────────────────

export interface GoalDispatchRequest {
  goal: string;
  goal_hash: string;
  tags: string[];
  variables: Record<string, unknown>;
}
export interface GoalReachIO {
  /** Recent goal-host dispatches (this substrate's own goal-hosts). `known` = chain ids already detailed. */
  listDispatches(ctx: { known: Set<string>; r_issued: Set<string>; known_hashes?: Map<string, string> }): Promise<{ ok: true; dispatches: DispatchObservation[] } | { ok: false; why: string }>;
  readGaps(goalHashes: string[]): Promise<{ ok: true; gaps: GapView[] } | { ok: false; why: string }>;
  readLandings(fromMs: number, toMs: number): Promise<{ ok: true; landings: LandingView[] } | { ok: false; why: string }>;
  /** The autonomy-scope check, or null when the scope is unreadable (then no blocked_by_scope verdict). */
  scopeExcludes(): Promise<((path: string) => string | null) | null>;
  loadRecords(): Promise<Record<string, GoalReachRecord>>;
  saveRecord(rec: GoalReachRecord): Promise<void>;
  /** Persist many records in ONE store write; one entry per record, in order. Absent ⇒ saveRecord per record. */
  saveRecords?(recs: GoalReachRecord[]): Promise<Array<{ goal_hash: string; ok: boolean; why?: string }>>;
  dispatchGoal(req: GoalDispatchRequest): Promise<{ ok: true; dispatch_id: string; coalesced: boolean } | { ok: false; why: string }>;
  /** Templates written since `fromMs`, with their provenance fields (a READ of the template store). */
  readTemplatesSince(fromMs: number): Promise<{ ok: true; templates: Array<Record<string, unknown>> } | { ok: false; why: string }>;
  /** Append an absent-extraction evidence entry to the ribosome gap (idempotent per goal_hash). */
  attachExtractionEvidence(entry: { goal_hash: string } & Record<string, unknown>): Promise<{ ok: boolean; why?: string }>;
  fileLimitProposal(p: { goal_hash: string; paths: string[]; gap_ids: string[]; reason: string }): Promise<{ ok: boolean; why?: string }>;
  /**
   * Attach a goal_reach demand entry to a gap a walk filed, only while the gap is open. linked:false when it
   * already carried this (goal_hash, dispatch_id). Absent from an I/O ⇒ the tick links nothing and says so.
   */
  linkFiledGap?(gapId: string, entry: GoalReachDemandEntry): Promise<{ ok: true; linked: boolean } | { ok: false; reason: "closed" | "not_found" | "write_refused"; why: string }>;
  /** R2: tally the runs' judge reasons per goal and file one gap per (goal, repeated reason class). Optional. */
  recogniseDeficiencies?(dispatches: DispatchObservation[], now: number): Promise<DeficiencyReport>;
}

/** What R2 did this tick (goal-deficiency.ts decides; the I/O writes). */
export interface DeficiencyReport {
  ok: boolean;
  /** Package A's report for this tick (absent when it did not run). */
  producer_dispatch?: import("./producer-dispatch.js").ProducerDispatchReport;
  why?: string;
  tallied: number;
  ignored: number;
  filed: Array<{ id: string; kind: string; count: number }>;
  refused: Array<{ id: string; why: string }>;
  skipped: Array<{ goal_hash: string; reason_class?: string; why: string }>;
  unclassified: Array<{ goal_hash: string; count: number; samples: string[] }>;
  unread: Array<{ goal_hash: string; count: number }>;
  unrecorded: Array<{ goal_hash: string; count: number }>;
  /** Judge reasons R2 read itself this tick; records read that carry NO reason (unrecorded); reads that failed (stay unread). */
  reasons_read: number;
  reasons_unrecorded: number;
  reason_reads_failed: number;
  /** Listed runs R2 could not tally for want of a goal hash, and how many of those are a cut goal (C-longgoal-1; 0 in steady state). */
  skipped_no_goal_hash: number;
  skipped_cut_goal: number;
  /** #1a: deficiency rows localized this call (sited, or a loud unknown with its kind). */
  localized: Array<{ id: string; state: string; kind: string; refused?: boolean }>;
  candidates: Array<{ goal_hash: string; reason_class: string; count: number; class_source: string }>;
}

/** One action (or, in dry-run, would-action) a tick took, with the linked gaps as it saw them. */
export interface TickAction {
  kind: "redispatch" | "stop" | "ask_human";
  goal_hash: string;
  would: boolean;
  reason?: string;
  linked: Array<{ id: string; status: string; reopen_count: number }>;
}
/** What a tick did, kept so the NEXT tick can grade it against the state it then observes. */
export interface TickLedger {
  at: number;
  dry_run: boolean;
  actions: TickAction[];
  /** Goals nextAction said to act on this tick (redispatch/stop/ask_human), recorded at decision time. */
  eligible: string[];
  errors: string[];
}

/** What the tick did with the gaps the observed walks filed. */
export interface FiledGapLinks {
  linked: Array<{ gap_id: string; goal_hash: string; dispatch_id: string }>;
  already: number;
  skipped: Array<{ gap_id: string; goal_hash: string | null; dispatch_id: string; why: string }>;
}

export interface GoalReachTickResult {
  linked_filed: FiledGapLinks;
  deficiency?: DeficiencyReport;
  ledger: TickLedger;
  /** The state this tick observed before acting: what grades the previous tick. */
  observed: { records: GoalReachRecord[]; gaps: GapView[] };
  ok: boolean;
  why?: string;
  summary: GoalReachSummary;
  redispatched: Array<{ goal_hash: string; dispatch_id: string }>;
  stopped: Array<{ goal_hash: string; reason: string }>;
  asked_human: Array<{ goal_hash: string; write_shapes: string[] }>;
  errors: string[];
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/** A record's content as a change test sees it: `updated_at` and `last_action.at` are stamps of WHEN, so a tick that
 *  re-decides the same action on an unchanged record has changed nothing. */
function contentOf(rec: GoalReachRecord): string {
  const { updated_at: _u, last_action, ...rest } = rec;
  return JSON.stringify({ ...rest, ...(last_action ? { last_action: { ...last_action, at: 0 } } : {}) });
}

/**
 * Persist the records whose content changed since `prior` (the state loaded at the tick's start), stamping each
 * updated_at, in ONE store write. Every failure is loud and lands in `errors`; one refused record never drops another.
 */
export async function flushChangedRecords(io: GoalReachIO, prior: Record<string, GoalReachRecord>, recs: GoalReachRecord[], now: number, errors: string[]): Promise<number> {
  const changed = recs.filter((r) => !prior[r.goal_hash] || contentOf(r) !== contentOf(prior[r.goal_hash]!));
  if (changed.length === 0) return 0;
  for (const r of changed) r.updated_at = now;
  const fail = (h: string, why: string): void => {
    errors.push(`record ${h} not persisted: ${why}`);
    console.error(`[goal-reach] RECORD NOT PERSISTED goal_hash=${h}: ${why}`);
  };
  if (io.saveRecords) {
    try {
      for (const r of await io.saveRecords(changed)) if (!r.ok) fail(r.goal_hash, r.why ?? "write refused");
    } catch (e) { for (const r of changed) fail(r.goal_hash, `batch write threw: ${errText(e)}`); }
  } else {
    for (const r of changed) { try { await io.saveRecord(r); } catch (e) { fail(r.goal_hash, errText(e)); } }
  }
  return changed.length;
}

/**
 * Link each gap a terminal, non-reaching walk filed to that walk's goal. Every filed entry ends in exactly one
 * of linked / already / skipped (with why): nothing is dropped. Only open gaps are linked (never a reopen).
 */
export async function linkFiledGaps(io: GoalReachIO, dispatches: DispatchObservation[], out: FiledGapLinks): Promise<void> {
  for (const d of dispatches) {
    if (d.status === "running" || d.reached === true) continue;
    const filed = Array.isArray(d.gaps_filed) ? d.gaps_filed : [];
    if (filed.length === 0) continue;
    const goalHash = dispatchGoalHash(d);
    const seen = new Set<string>();
    for (const raw of filed) {
      const gapId = typeof raw === "string" ? raw.trim() : "";
      const skip = (why: string) => {
        out.skipped.push({ gap_id: gapId || JSON.stringify(raw).slice(0, 80), goal_hash: goalHash, dispatch_id: d.dispatchId, why });
        console.warn(`[goal-reach] filed gap ${gapId || "(not an id)"} of dispatch ${d.dispatchId} NOT linked: ${why}`);
      };
      if (!gapId) { skip("not a gap id"); continue; }
      if (seen.has(gapId)) continue;
      seen.add(gapId);
      if (!goalHash) { skip("the goal text is incomplete, so its goal_hash is unknown"); continue; }
      if (!io.linkFiledGap) { skip("this I/O cannot link gaps"); continue; }
      const entry: GoalReachDemandEntry = { source: "goal_reach", goal_hash: goalHash, dispatch_id: d.dispatchId, origin: originOf(d) };
      let r: Awaited<ReturnType<NonNullable<GoalReachIO["linkFiledGap"]>>>;
      try { r = await io.linkFiledGap(gapId, entry); } catch (e) { r = { ok: false, reason: "write_refused", why: errText(e) }; }
      if (!r.ok) { skip(`${r.reason}: ${r.why}`); continue; }
      if (r.linked) {
        out.linked.push({ gap_id: gapId, goal_hash: goalHash, dispatch_id: d.dispatchId });
        console.log(`[goal-reach] LINKED filed gap ${gapId} to goal_hash=${goalHash} (dispatch ${d.dispatchId})`);
      } else out.already++;
    }
  }
}

export async function runGoalReachTick(io: GoalReachIO, policy: GoalReachPolicy, now = Date.now()): Promise<GoalReachTickResult> {
  const result: GoalReachTickResult = {
    ok: true, summary: summarize([]), redispatched: [], stopped: [], asked_human: [], errors: [],
    ledger: { at: now, dry_run: policy.dry_run, actions: [], eligible: [], errors: [] }, observed: { records: [], gaps: [] },
    linked_filed: { linked: [], already: 0, skipped: [] },
  };
  const tag = policy.dry_run ? "DRY-RUN would " : "";
  const prior = await io.loadRecords();
  const { known, known_hashes, r_issued: rIssued } = knownFromRecords(prior);
  const listed = await io.listDispatches({ known, r_issued: rIssued, known_hashes });
  if (!listed.ok) { result.ledger.errors.push(`dispatches unreadable: ${listed.why}`); return { ...result, ok: false, why: `dispatches unreadable: ${listed.why}`, summary: summarize(Object.values(prior)) }; }

  // LINK THE WALKS' OWN FILINGS before the gaps are read, so this tick's linkGaps already sees them.
  if (policy.link_filed_gaps !== false) await linkFiledGaps(io, listed.dispatches, result.linked_filed);
  // R2: recognise repeated content failures (files before the gaps are read, so this tick's wait sees them).
  if (io.recogniseDeficiencies) {
    try { result.deficiency = await io.recogniseDeficiencies(listed.dispatches, now); }
    catch (e) { result.errors.push(`deficiency recognition failed: ${errText(e)}`); console.warn(`[goal-reach] R2 recognition failed: ${errText(e)}`); }
  }

  const records = observe(prior, listed.dispatches, now, policy);
  const live = Object.values(records);
  const gapsRead = await io.readGaps(live.map((r) => r.goal_hash));
  if (!gapsRead.ok) {
    await flushChangedRecords(io, prior, live, now, result.errors);
    result.ledger.errors.push(`gaps unreadable: ${gapsRead.why}`);
    return { ...result, ok: false, why: `gaps unreadable: ${gapsRead.why}`, summary: summarize(live) };
  }
  const gaps = gapsRead.gaps;
  for (const rec of live) linkGaps(rec, gaps);
  result.observed = { records: JSON.parse(JSON.stringify(live)) as GoalReachRecord[], gaps };
  const gapById = new Map(gaps.map((g) => [g.id, g]));
  const linkedSnapshot = (rec: GoalReachRecord): TickAction["linked"] =>
    rec.linked.map((id) => gapById.get(id)).filter((g): g is GapView => !!g).map((g) => ({ id: g.id, status: g.status, reopen_count: g.reopen_count ?? 0 }));
  const scope = await io.scopeExcludes().catch(() => null);
  let landings: LandingView[] | null = null;

  // ONE WRITE PER TICK. The loop decides; what it changed is persisted once, below, and in `finally` when the loop
  // is cut by a throw, so a transition it already made (a REACHED, a stop) is never decided again on the next tick.
  let flushed = false;
  try {
    for (const rec of live) {
      const wasTerminal = prior[rec.goal_hash]?.status === "stopped";
      linkGaps(rec, gaps);

      if (rec.status === "reached") {
        if (!rec.attribution_final) {
          if (landings === null) {
            const from = Math.min(...live.map((r) => r.first_failure_at ?? now));
            const lr = await io.readLandings(from, now).catch((e) => ({ ok: false as const, why: errText(e) }));
            if (lr.ok) landings = lr.landings;
            else result.errors.push(`landings unreadable (${lr.why}); attribution taken without them would over-credit, so held`);
          }
          if (landings !== null) {
            const a = attributeReach(rec, gaps, landings, now);
            rec.attribution = a.attribution;
            rec.attribution_reasons = a.reasons;
            rec.operator_hands = handsOf(a.attribution);
            rec.attribution_final = true;
            rec.last_action = { kind: "reached", reason: `attribution=${a.attribution}`, at: now };
            console.log(`[goal-reach] REACHED goal_hash=${rec.goal_hash} dispatch=${rec.reached_dispatch_id} attribution=${a.attribution}${a.reasons.length ? ` (${a.reasons.slice(0, 3).join("; ")})` : ""}`);
          }
        }
        if (needsExtractionCheck(rec)) {
          const read = await io.readTemplatesSince((rec.reached_at ?? now) - 60_000).catch((e) => ({ ok: false as const, why: errText(e) }));
          const step = extractionStep(rec, read, now, policy);
          rec.extraction = step.extraction;
          if (step.extracted_template_id) rec.extracted_template_id = step.extracted_template_id;
          if (step.extraction.status === "found" || step.extraction.status === "absent") {
            console.log(`[goal-reach] EXTRACTION ${step.extraction.status.toUpperCase()} goal_hash=${rec.goal_hash} execution=${rec.reached_execution_id}${step.extracted_template_id ? ` template=${step.extracted_template_id}` : ""}`);
          }
          if (step.file_evidence) {
            try {
              const f = await io.attachExtractionEvidence({
                goal_hash: rec.goal_hash, dispatch_id: rec.reached_dispatch_id ?? null, execution_id: rec.reached_execution_id ?? null,
                attribution: rec.attribution, reached_at: new Date(rec.reached_at ?? now).toISOString(),
                window_min: Math.round(policy.extraction_window_ms / 60_000), observed_at: new Date(now).toISOString(), source: "goal_reach_tick",
              });
              rec.extraction_evidence_filed = f.ok;
              if (!f.ok) result.errors.push(`extraction evidence for ${rec.goal_hash} not filed: ${f.why ?? "unknown"}`);
            } catch (e) { result.errors.push(`extraction evidence for ${rec.goal_hash} threw: ${errText(e)}`); }
          }
        }
        continue;
      }
      if (wasTerminal) continue;

      const action = nextAction(rec, gaps, policy, { scopeExcludes: scope });
      rec.last_action = { kind: action.kind, ...("reason" in action ? { reason: action.reason } : {}), at: now };
      if (action.kind === "stop" || action.kind === "ask_human" || action.kind === "redispatch") result.ledger.eligible.push(rec.goal_hash);
      if (action.kind === "stop") {
        rec.status = "stopped";
        rec.stop_reason = action.reason;
        result.stopped.push({ goal_hash: rec.goal_hash, reason: action.reason });
        result.ledger.actions.push({ kind: "stop", goal_hash: rec.goal_hash, would: policy.dry_run, reason: action.reason, linked: linkedSnapshot(rec) });
        console.log(`[goal-reach] ${policy.dry_run ? "DRY-RUN would stop" : "STOPPED"} goal_hash=${rec.goal_hash} reason=${action.reason}`);
        if (action.limit_proposal && !rec.limit_proposal_filed) {
          try {
            const f = await io.fileLimitProposal({ ...action.limit_proposal, reason: action.reason });
            rec.limit_proposal_filed = f.ok;
            if (!f.ok) result.errors.push(`limit proposal for ${rec.goal_hash} not filed: ${f.why ?? "unknown"}`);
          } catch (e) { result.errors.push(`limit proposal for ${rec.goal_hash} threw: ${errText(e)}`); }
        }
      } else if (action.kind === "ask_human") {
        // No ask channel exists yet: the honest state is stopped-with-reason, visible in the summary.
        rec.status = "stopped";
        // The ask goes to the goal's ORIGIN (an operator-session goal asks that operator id; a surface goal
        // its human). No ask channel exists yet, so the stop reason names the intended addressee.
        rec.stop_reason = `needs_human:ask=${action.addressee}:write_effects:${action.write_shapes.join(",")}`;
        result.asked_human.push({ goal_hash: rec.goal_hash, write_shapes: action.write_shapes });
        result.ledger.actions.push({ kind: "ask_human", goal_hash: rec.goal_hash, would: policy.dry_run, reason: rec.stop_reason, linked: linkedSnapshot(rec) });
        console.log(`[goal-reach] ${tag}stop for a human ask goal_hash=${rec.goal_hash} reason=${rec.stop_reason}`);
      } else if (action.kind === "redispatch") {
        const cycle = rec.cycles + 1;
        try {
          const r = await io.dispatchGoal({
            goal: action.goal,
            goal_hash: action.goal_hash,
            // NEVER `operator`: goal-host maps any operator id to trigger "operator", which would make
            // R's own re-dispatch read as operator hands. The tag yields trigger "goal_reach".
            tags: ["dispatcher_reason:goal_reach", `goal_reach:${action.goal_hash}`, `goal_reach_cycle:${cycle}`, ...(action.landed ?? []).map((l) => `goal_reach_landing:${l.sha}`)],
            variables: { source: "goal_reach", goal_reach_goal_hash: action.goal_hash, goal_reach_cycle: cycle },
          });
          if (!r.ok) { result.errors.push(`redispatch ${rec.goal_hash} failed: ${r.why}`); result.ledger.errors.push(`redispatch ${rec.goal_hash} failed: ${r.why}`); }
          else if (r.coalesced) {
            rec.last_action = { kind: "redispatch_coalesced", reason: `goal-host returned the already-running ${r.dispatch_id}`, at: now };
          } else {
            rec.r_issued.push(r.dispatch_id);
            if (action.landed?.length) (rec.redispatch_triggers ??= []).push({ dispatch_id: r.dispatch_id, landed: action.landed });
            rec.last_redispatch_at = now;
            rec.status = "redispatching";
            rec.cycles = cycle;
            result.redispatched.push({ goal_hash: rec.goal_hash, dispatch_id: r.dispatch_id });
            result.ledger.actions.push({ kind: "redispatch", goal_hash: rec.goal_hash, would: policy.dry_run, linked: linkedSnapshot(rec) });
            const why = action.landed?.length ? `landing ${action.landed.map((l) => `${l.gap}@${l.sha.slice(0, 12)}`).join(",")} on an open linked gap` : `all ${rec.linked.length} linked gap(s) closed`;
            console.log(policy.dry_run
              ? `[goal-reach] DRY-RUN would redispatch goal_hash=${rec.goal_hash} cycle=${cycle}/${policy.max_cycles} (${why})`
              : `[goal-reach] REDISPATCHED goal_hash=${rec.goal_hash} dispatch=${r.dispatch_id} cycle=${cycle}/${policy.max_cycles} (${why})`);
          }
        } catch (e) {
          result.errors.push(`redispatch ${rec.goal_hash} threw: ${errText(e)}`);
          result.ledger.errors.push(`redispatch ${rec.goal_hash} threw: ${errText(e)}`);
        }
      }
    }
    flushed = true;
    await flushChangedRecords(io, prior, live, now, result.errors);
  } finally {
    if (!flushed) await flushChangedRecords(io, prior, live, now, result.errors).catch((e) => console.error(`[goal-reach] cut tick's records not persisted: ${errText(e)}`));
  }
  result.summary = summarize(live);
  console.log(`[goal-reach] tick linked_filed=${result.linked_filed.linked.length} already=${result.linked_filed.already} not_linked=${result.linked_filed.skipped.length} goals=${result.summary.goals} unlinked=${result.summary.open_unlinked} waiting=${result.summary.waiting} redispatched=${result.redispatched.length} reached_without_hands=${result.summary.reached_without_hands} reached_by_r=${result.summary.reached_by_r} stopped=${result.summary.stopped} errors=${result.errors.length}`);
  return result;
}

// ── default I/O: the fleet, by shape ──────────────────────────────────────────────────────────────

const GOAL_REACH_SHAPE = "goalReach";
const POLICY_SHAPE = "goalReachPolicy";
const recordId = (h: string): string => `goalReach:${h}`;

async function postResolve(url: string, pointer: Record<string, unknown>, timeoutMs: number): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const { METABOB_API_KEY } = await import("../config.js");
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}) },
      body: JSON.stringify({ impulse: { pointer } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: Record<string, unknown> | null = null;
    try { json = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

/** Own-substrate producers of `shape` (gap-to-feature.ts discoverOwnResolveUrls): a peer cannot steer R. */
async function ownUrls(shape: string): Promise<{ ok: true; urls: string[] } | { ok: false; why: string }> {
  const { discoverOwnResolveUrls } = await import("../judge/gap-policy.js");
  const d = await discoverOwnResolveUrls(shape);
  if (!d.ok) return { ok: false, why: d.why };
  if (d.urls.length === 0) return { ok: false, why: `no own-substrate ${shape} producer discovered` };
  return { ok: true, urls: d.urls };
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The durable trace of an execution (activity-api), unwrapped, or null when unreadable. */
async function readTrace(executionId: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!executionId) return null;
  try {
    const { executionTrace } = await import("./execution-trace.js");
    const t = (await executionTrace({ execution_id: executionId })).body as Record<string, unknown> | null;
    return ((t?.["trace"] ?? t?.["data"] ?? t) as Record<string, unknown> | null) ?? null;
  } catch { return null; }
}
async function traceCost(executionId: string | null | undefined): Promise<number | null> {
  const t = await readTrace(executionId);
  return asNum(t?.["costUsd"]) ?? asNum(t?.["cost_usd"]) ?? null;
}

/** Classify ledger landingEvent records by route. Host commits never pass the container hooks: they
 *  arrive as a ref_update whose new shas match no in-container commit event. */
export function classifyLandingRoute(rec: Record<string, unknown>): LandingView["route"] {
  const unit = rec["committer_unit"];
  const hasId = (typeof rec["attempt_id"] === "string" && rec["attempt_id"]) || (typeof rec["execution_id"] === "string" && rec["execution_id"]);
  if (typeof unit === "string" && unit.endsWith(".service")) return hasId ? "substrate" : "unknown";
  return "operator";
}

function gitLines(repo: string, args: string[]): string[] | null {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", timeout: 10_000 });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
const repoPrefix = (repo: string): string => {
  const b = basename(repo);
  return b === "super-repo" || b === "substrate" ? "" : `${b}/`;
};

/** Every gap row in the store (for step-gap reuse), or [] when unreadable. */
async function readAllGaps(read: (p: never) => Promise<{ shape: string; body: unknown }>): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await read({ type: "substrateGap", limit: 1_000_000 } as never);
    const rows = (r.body as { gaps?: Array<Record<string, unknown>> } | null)?.gaps;
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export type StepChild = { id?: string; resolver: string; failure_class: string; state: "filed" | "linked" | "unsited" | "refused"; why?: string };
/**
 * #1b for one localized deficiency row: per distinct failing step (resolver, failure class) of its counted runs, LINK an
 * existing open gap that is that defect (enriching it with the site) or FILE one at the canonical step id, sited from
 * discovery + the locator, its falsifier_spec quoting the trace's observed failure text. Every child carries the parent goal's
 * demand, so linkGaps parks the goal on it and the deadlock fix re-runs the goal when it lands. Output errors and
 * composition-only runs get no child. A step with no single serving vessel or no located file is recorded unsited, loudly.
 */
export async function ensureStepChildren(
  parent: Record<string, unknown>, loc: import("./goal-deficiency.js").Localization,
  rowsOf: () => Promise<Array<Record<string, unknown>>>, write: (p: never) => Promise<{ shape: string; body: unknown }>,
  deps: { vesselOf?: (r: string) => Promise<{ vessel: string } | { why: string }>; locate?: typeof locateStepFile } = {},
): Promise<StepChild[]> {
  const gd = await import("./goal-deficiency.js");
  const pmeta = (parent["classification_metadata"] ?? {}) as Record<string, unknown>;
  const goalHash = String(pmeta["goal_hash"] ?? "");
  const ids = Array.isArray(pmeta["dispatch_ids"]) ? (pmeta["dispatch_ids"] as unknown[]).map(String) : [];
  const out: StepChild[] = [];
  for (const plan of gd.stepChildren(loc.runs).slice(0, 5)) {
    const v = await (deps.vesselOf ?? vesselOfResolver)(plan.resolver);
    if ("why" in v) { out.push({ resolver: plan.resolver, failure_class: plan.failure_class, state: "unsited", why: v.why }); console.warn(`[goal-reach] R2 step child ${plan.resolver}/${plan.failure_class} for ${parent["id"]}: unsited — ${v.why}`); continue; }
    const f = await (deps.locate ?? locateStepFile)(v.vessel, plan.resolver, plan.excerpt);
    if (!f) { out.push({ resolver: plan.resolver, failure_class: plan.failure_class, state: "unsited", why: `no single file located in ${v.vessel}` }); console.warn(`[goal-reach] R2 step child ${plan.resolver}/${plan.failure_class} for ${parent["id"]}: unsited — no file located in ${v.vessel}`); continue; }
    const observed = gd.observedFailureText(plan.excerpt);
    const demand = { source: "goal_reach" as const, goal_hash: goalHash, dispatch_id: plan.dispatch_ids[plan.dispatch_ids.length - 1] ?? ids[ids.length - 1] ?? "", origin: "autonomous" as const };
    const sited = { failing_activity: plan.resolver, failure_class: plan.failure_class, vessel: v.vessel, edit_site: f.file, step_dispatch_ids: plan.dispatch_ids, parent_gap: String(parent["id"] ?? ""),
      ...(observed ? { falsifier_spec: `must-fail: a \`${plan.resolver}\` step given the walk's input no longer fails with "${observed}"; control: the step's other inputs still succeed` } : {}) };
    const existing = gd.findStepGap(await rowsOf(), plan.resolver, plan.failure_class);
    const gap = existing
      ? { id: existing["id"], category: existing["category"], source: existing["source"], summary: existing["summary"], detected_at: existing["detected_at"], status: "open",
          classification_metadata: { ...((existing["classification_metadata"] ?? {}) as Record<string, unknown>), ...sited, ...(((existing["classification_metadata"] ?? {}) as Record<string, unknown>)["falsifier_spec"] ? { falsifier_spec: ((existing["classification_metadata"] ?? {}) as Record<string, unknown>)["falsifier_spec"] } : {}) } }
      : { id: gd.stepGapId(plan.resolver, plan.failure_class), category: "systematic_failure", source: "goal_reach_tick", status: "open", detected_at: new Date().toISOString(),
          summary: `Step \`${plan.resolver}\` fails (${plan.failure_class}) in ${v.vessel} on ${plan.dispatch_ids.length} run(s) of a goal judged deficient: ${String(plan.excerpt ?? "(no failure text)").slice(0, 240)}`,
          classification_metadata: { kind: "step_failure", ...sited } };
    const res = await write({ type: "substrateGap_write", gap, demand_goals_append: [demand], ...(existing ? { expect_status: "open" } : {}) } as never);
    const body = (res.body ?? {}) as Record<string, unknown>;
    if (res.shape !== "substrateGapWriteResult" || body["skip_reason"]) {
      out.push({ id: String(gap.id), resolver: plan.resolver, failure_class: plan.failure_class, state: "refused", why: String(body["skip_reason"] ?? body["detail"] ?? res.shape).slice(0, 160) });
      continue;
    }
    out.push({ id: String(gap.id), resolver: plan.resolver, failure_class: plan.failure_class, state: existing ? "linked" : "filed" });
    console.log(`[goal-reach] R2 step child ${existing ? "LINKED" : "FILED"} ${gap.id} (${plan.resolver}/${plan.failure_class} → ${f.file}) for ${parent["id"]}`);
  }
  return out;
}

/** A deficiency row needs (re)localizing when it has none, or its counted runs changed since it was localized. */
export function needsLocalization(g: Record<string, unknown>, self = "", now = Date.now(), retryMs = Number.POSITIVE_INFINITY): boolean {
  const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
  if (meta["kind"] !== "goal_content_deficiency") return false;
  const ids = Array.isArray(meta["dispatch_ids"]) ? (meta["dispatch_ids"] as unknown[]).map(String) : [];
  if (ids.length === 0) return false;
  const loc = meta["localization"] as { runs?: import("./goal-deficiency.js").RunAttribution[] } | undefined;
  if (!loc || !Array.isArray(loc.runs)) return true;
  const had = new Map(loc.runs.map((r) => [String(r.dispatch_id), r]));
  // Unattributed runs, another node's trace_unreadable (never its verdict to give), and this node's own after retryMs.
  return ids.some((id) => runNeedsAttributionSync(had.get(id), self, now, retryMs));
}
function runNeedsAttributionSync(prior: import("./goal-deficiency.js").RunAttribution | undefined, self: string, now: number, retryMs: number): boolean {
  if (!prior) return true;
  if (prior.kind !== "trace_unreadable") return false;
  if (prior.node !== self) return true;
  return !(now - (prior.at ?? 0) < retryMs);
}

/**
 * The serving vessel of a resolver/shape: exactly one LOCAL (non-federated) producer that is a repo here, else why not.
 * A producer is named by `id`: that is the field the ias discovery adapter maps every discovery row's id/vesselId into
 * (adapters/discovery-adapter.js lookupUncached). Reading `vesselId` here named NO producer, so every step read
 * "no local vessel serves" live (node1 2026-10-13 11:58Z) while a hand-made fixture with `vesselId` passed.
 */
export async function vesselOfResolver(resolver: string, deps: { repoExists?: (rel: string) => boolean } = {}): Promise<{ vessel: string } | { why: string }> {
  const { lookupShape } = await import("../config.js");
  const r = await lookupShape(resolver);
  if (!r.ok) return { why: `discovery unreadable for ${resolver} (${"reason" in r ? r.reason : "?"})` };
  const local = (r.producers as Array<{ id?: string; vesselId?: string }>).map((p) => String(p.id || p.vesselId || "")).filter((v) => v && !v.includes("@"));
  if (local.length !== 1) return { why: local.length ? `${resolver} is served by ${local.length} local vessels: ${local.join(", ")}` : `no local vessel serves ${resolver}` };
  const repoPathExists = deps.repoExists ?? (await import("../judge/gap-admission.js")).repoPathExists;
  const name = local[0]!.replace(/-local$/, "");
  return repoPathExists(`repos/${name}`) ? { vessel: name } : { why: `${local[0]} maps to no repo here (${name})` };
}

/** The file the failing step lives in: the existing localizer's grep over the vessel, with the resolver and the failure evidence as its ONLY terms. */
async function locateStepFile(vessel: string, resolver: string, excerpt: string | undefined): Promise<{ file: string; method: string } | null> {
  const { localizeGap } = await import("./gap-to-feature.js");
  const loc = await localizeGap({ summary: "", classification_metadata: { vessel, live_resolver: resolver, ...(excerpt ? { matched_excerpt: excerpt } : {}) } }, { useLlm: false });
  return loc ? { file: loc.file, method: loc.method } : null;
}

/**
 * THE GOAL-HOST THAT RAN A DISPATCH: its tally entry's node (the goal-host that listed it), else THIS node's own goal-host
 * (entries tallied before nodes were recorded carry none). A run's record lives on the goal-host that ran it; a shared
 * gap's dispatch ids come from every node, so reading them all from this node's goal-host skipped other nodes' runs as
 * "unreadable here" (432 per day on one node, 101 on another, 2026-10-16). One rule for every run read (executionIdOf,
 * producer-dispatch's readRun); restores 7861c76e's origin read, which readRun (1eaff12d) did not take.
 */
export async function runOriginBase(entry: { node?: string | null } | undefined, ownGoalHost?: () => Promise<string | null>): Promise<string | null> {
  return entry?.node ? entry.node.replace(/\/v2\/impulses\/resolve\/?$/, "").replace(/\/resolve\/?$/, "") : await (ownGoalHost ?? ownGoalHostBase)();
}
/** The execution id of a counted run: the tally's, else goal-host's own dispatch record on the node that ran it. */
async function executionIdOf(entry: import("./goal-deficiency.js").TallyEntry | undefined, dispatchId: string, ownGoalHost?: () => Promise<string | null>): Promise<string | null> {
  if (entry?.execution_id) return entry.execution_id;
  // The goal-host that ran it, when the entry names one; else THIS node's own goal-host (entries tallied before
  // execution ids were recorded carry neither). A dispatch this node's goal-host does not know is not this node's run.
  const node = await runOriginBase(entry, ownGoalHost);
  if (!node) return null;
  try {
    const r = await fetch(`${node}/executions/${encodeURIComponent(dispatchId)}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    return typeof j["executionId"] === "string" ? (j["executionId"] as string) : null;
  } catch { return null; }
}
/** This node's own goal-host base URL (the activeDispatches producer on this substrate), or null. */
async function ownGoalHostBase(): Promise<string | null> {
  const u = await ownUrls("activeDispatches");
  return u.ok && u.urls[0] ? u.urls[0].replace(/\/v2\/impulses\/resolve\/?$/, "").replace(/\/resolve\/?$/, "") : null;
}

/** #1a for one row: attribute each counted run from its trace, then site (or not) by the policy majority. */
export async function localizeRow(
  g: Record<string, unknown>, tallies: Record<string, import("./goal-deficiency.js").DeficiencyTally>, majority: number, now: number,
  deps: { executionIdOf?: typeof executionIdOf; readTrace?: (id: string | null) => Promise<Record<string, unknown> | null>; vesselOf?: (r: string) => Promise<{ vessel: string } | { why: string }>; locate?: typeof locateStepFile; self?: string; retryMs?: number; ownGoalHost?: () => Promise<string | null> } = {},
): Promise<import("./goal-deficiency.js").Localization & { fresh: number }> {
  const gd = await import("./goal-deficiency.js");
  const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
  const ids = (Array.isArray(meta["dispatch_ids"]) ? (meta["dispatch_ids"] as unknown[]) : []).map(String);
  const t = tallies[String(meta["goal_hash"] ?? "")];
  const self = deps.self ?? localizingNode();
  const retryMs = deps.retryMs ?? Number.POSITIVE_INFINITY;
  const prior = ((meta["localization"] as { runs?: import("./goal-deficiency.js").RunAttribution[] } | undefined)?.runs ?? []).filter((r) => r && typeof r.dispatch_id === "string");
  const priorBy = new Map(prior.map((r) => [r.dispatch_id, r]));
  const fresh: import("./goal-deficiency.js").RunAttribution[] = [];
  for (const id of ids) {
    if (!gd.runNeedsAttribution(priorBy.get(id), self, now, retryMs)) continue;
    const e = t?.entries.find((x) => x.dispatch_id === id);
    const exec = await (deps.executionIdOf ?? executionIdOf)(e, id, deps.ownGoalHost);
    // OWNERSHIP: a run this node neither tallied nor finds on its own goal-host is another node's to attribute.
    if (!e && !exec) continue;
    if (!exec) { fresh.push({ dispatch_id: id, kind: "trace_unreadable", unread: "execution_id_unknown", node: self, at: now }); continue; }
    const tr = await (deps.readTrace ?? readTrace)(exec);
    const a = tr ? gd.attributeRun(id, tr as never, e?.reason ?? "") : { dispatch_id: id, kind: "trace_unreadable" as const, unread: "trace_read_failed" as const };
    fresh.push({ ...a, node: self, at: now });
  }
  const runs = gd.mergeRunAttributions(ids, prior, fresh);
  const loc = await gd.localizeFromRuns(runs, majority, deps.vesselOf ?? vesselOfResolver, deps.locate ?? locateStepFile, now);
  return { ...loc, fresh: fresh.length };
}
/** The name this node attributes runs under (its substrate identity, the same one check supply records as dispatch_node). */
function localizingNode(): string { return process.env["SUBSTRATE_NAME"] ?? "substrate"; }

export function defaultGoalReachIO(policy: GoalReachPolicy): GoalReachIO {
  return {
    async listDispatches({ known, r_issued, known_hashes }) {
      const prod = await ownUrls("activeDispatches");
      if (!prod.ok) return { ok: false, why: prod.why };
      const out: DispatchObservation[] = [];
      let answered = 0;
      let detailBudget = policy.max_detail_reads;
      for (const url of prod.urls) {
        const rows: Array<Record<string, unknown>> = [];
        for (let offset = 0; offset < 200; offset += 50) {
          const r = await postResolve(url, { type: "activeDispatches", limit: 50, offset }, 10_000);
          const body = (r.json?.["body"] ?? null) as { dispatches?: unknown; hasMore?: unknown } | null;
          if (!r.ok || !body || !Array.isArray(body.dispatches)) break;
          if (offset === 0) answered++;
          rows.push(...(body.dispatches as Array<Record<string, unknown>>));
          if (body.hasMore !== true) break;
        }
        const page: DispatchObservation[] = [];
        for (const row of rows) {
          const id = String(row["dispatchId"] ?? "");
          if (!id) continue;
          const obs: DispatchObservation = {
            dispatchId: id, goal: typeof row["goal"] === "string" ? row["goal"] : null, status: String(row["status"] ?? "unknown"),
            reached: typeof row["reached"] === "boolean" ? row["reached"] : null, operator: typeof row["operator"] === "string" ? row["operator"] : null,
            trigger: typeof row["trigger"] === "string" ? row["trigger"] : null, startedAt: asNum(row["startedAt"]) ?? 0, node: url,
            executionId: typeof row["executionId"] === "string" ? row["executionId"] : null,
            selectedTemplateId: typeof row["selectedTemplateId"] === "string" ? row["selectedTemplateId"] : null,
          };
          page.push(applyKnownHash(obs, known_hashes));
        }
        const detail = new Set(detailReadOrder(page, { known, r_issued }, detailBudget));
        detailBudget -= detail.size;
        for (const obs of page) {
          const id = obs.dispatchId;
          if (detail.has(id)) {
            const w = await postResolve(url, { type: "goalWalkState", dispatchId: id }, 10_000);
            const b = (w.json?.["body"] ?? null) as Record<string, unknown> | null;
            if (w.ok && b) {
              if (typeof b["goal"] === "string") { obs.goal = b["goal"]; obs.goal_full = true; }
              obs.goalReachReason = typeof b["goalReachReason"] === "string" ? b["goalReachReason"] : null;
              obs.poolShapes = asStrArr(b["poolShapes"]);
              obs.completionShapes = asStrArr(b["completionShapes"]);
              if (typeof b["reached"] === "boolean") obs.reached = b["reached"];
              const learning = b["learning"] as { gapsFiled?: unknown } | null | undefined;
              if (learning && Array.isArray(learning.gapsFiled)) obs.gaps_filed = learning.gapsFiled;
            }
            if (obs.status !== "running") obs.cost_usd = await traceCost(obs.executionId);
          }
          out.push(obs);
        }
      }
      if (answered === 0) return { ok: false, why: `no activeDispatches producer answered (${prod.urls.length} asked)` };
      return { ok: true, dispatches: out };
    },

    async readGaps(goalHashes) {
      try {
        const { resolveSubstrateGap } = await import("./substrate-gap.js");
        const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 });
        const body = r.body as { gaps?: Array<Record<string, unknown>> } | null;
        if (r.shape !== "substrateGap" || !Array.isArray(body?.gaps)) return { ok: false, why: `gap store answered ${r.shape}` };
        const want = new Set(goalHashes);
        const gaps: GapView[] = [];
        for (const g of body!.gaps!) {
          const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
          if (!linkedGoalHashes(meta["demand_goals"]).some((h) => want.has(h))) continue;
          gaps.push({
            id: String(g["id"]), status: String(g["status"] ?? "open"), source: String(g["source"] ?? ""),
            closed_reason: typeof meta["closed_reason"] === "string" ? meta["closed_reason"] : null,
            closed_at: typeof g["closed_at"] === "string" ? g["closed_at"] : null,
            edit_site: typeof meta["edit_site"] === "string" ? meta["edit_site"] : null,
            landed_at: typeof meta["pending_set_at"] === "string" && typeof meta["pending_outcome_verification"] === "string" && meta["pending_outcome_verification"] ? meta["pending_set_at"] : null,
            landed_sha: typeof meta["pending_outcome_verification"] === "string" && meta["pending_outcome_verification"] ? meta["pending_outcome_verification"] : null,
            demand_goals: meta["demand_goals"],
          });
        }
        return { ok: true, gaps };
      } catch (e) { return { ok: false, why: errText(e) }; }
    },

    async readLandings(fromMs, toMs) {
      try {
        // DRAIN THE SPOOL FIRST. landingEvent.jsonl fills only when unaccounted_landing_scan ingests the
        // git-hook spool; reading it undrained misses a landing made since the last scan and grades a
        // hand-assisted reach "false". goal-host's mintReachedTrace runs the same scan first for the same
        // reason. A failed drain makes the read unreadable, so the tick holds the hands grade.
        const { resolveUnaccountedLandingScan } = await import("./unaccounted-landing-scan.js");
        const drained = await resolveUnaccountedLandingScan({ type: "unaccounted_landing_scan" });
        if ((drained.body as { spool_readable?: boolean } | null)?.spool_readable !== true) return { ok: false, why: "attempt-ledger spool unreadable" };
        const { readRecords } = await import("./attempt-ledger.js");
        const events = readRecords("landingEvent").map((r) => r.record as Record<string, unknown>);
        const inContainer = new Set(events.filter((e) => e["event"] === "commit" || e["event"] === "rewrite").map((e) => String(e["sha"] ?? "")));
        const out: LandingView[] = [];
        for (const e of events) {
          const at = Date.parse(String(e["at"] ?? ""));
          if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
          const repo = String(e["repo"] ?? "");
          if (e["event"] === "commit" || e["event"] === "rewrite") {
            const sha = String(e["sha"] ?? "");
            if (!sha) continue;
            const files = (repo && gitLines(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])) || [];
            out.push({ sha, at, route: classifyLandingRoute(e), files: files.map((f) => repoPrefix(repo) + f) });
          } else if (e["event"] === "ref_update" && typeof e["old"] === "string" && typeof e["new"] === "string" && repo) {
            const shas = gitLines(repo, ["rev-list", "--max-count=50", `${e["old"]}..${e["new"]}`]) ?? [];
            for (const sha of shas) {
              if (inContainer.has(sha)) continue;
              const files = gitLines(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? [];
              out.push({ sha, at, route: "operator", files: files.map((f) => repoPrefix(repo) + f) });
            }
          }
        }
        return { ok: true, landings: out };
      } catch (e) { return { ok: false, why: errText(e) }; }
    },

    async scopeExcludes() {
      const { autonomyScope, autonomyScopeExcludes } = await import("../judge/gap-policy.js");
      const s = await autonomyScope();
      if (!s.readable) return null;
      return (p: string) => autonomyScopeExcludes(s, p);
    },

    async loadRecords() {
      const { resolvePoolImpulse } = await import("./pool-impulse.js");
      const res = resolvePoolImpulse({ type: "poolImpulse", shape: GOAL_REACH_SHAPE, status: "open" });
      const out: Record<string, GoalReachRecord> = {};
      for (const imp of res.body.impulses) {
        const r = imp.body as GoalReachRecord | null;
        if (r && typeof r.goal_hash === "string" && Array.isArray(r.dispatches)) out[r.goal_hash] = r;
      }
      return out;
    },

    async saveRecord(rec) {
      const { resolvePoolImpulseWrite } = await import("./pool-impulse.js");
      resolvePoolImpulseWrite({ type: "poolImpulse_write", id: recordId(rec.goal_hash), shape: GOAL_REACH_SHAPE, body: rec, source: "goal_reach_tick", status: "open" });
    },

    async saveRecords(recs) {
      const { resolvePoolImpulseWriteMany } = await import("./pool-impulse.js");
      const out = resolvePoolImpulseWriteMany(recs.map((rec) => ({ type: "poolImpulse_write", id: recordId(rec.goal_hash), shape: GOAL_REACH_SHAPE, body: rec, source: "goal_reach_tick", status: "open" as const })));
      return out.map((r, i) => ({ goal_hash: recs[i]!.goal_hash, ok: r.body.ok, ...(r.body.ok ? {} : { why: r.body.error ?? "refused" }) }));
    },

    async dispatchGoal(req) {
      const prod = await ownUrls("goalDispatchAsync");
      if (!prod.ok) return { ok: false, why: prod.why };
      const r = await postResolve(prod.urls[0]!, { type: "goalDispatchAsync", goal: req.goal, tags: req.tags, variables: req.variables }, 30_000);
      const j = r.json ?? {};
      const id = (j["dispatchId"] ?? (j["body"] as Record<string, unknown> | undefined)?.["dispatchId"]) as unknown;
      if (!r.ok || typeof id !== "string" || !id) return { ok: false, why: `goalDispatchAsync HTTP ${r.status}${typeof j["error"] === "string" ? `: ${j["error"]}` : ""}` };
      return { ok: true, dispatch_id: id, coalesced: j["coalesced"] === true };
    },

    async readTemplatesSince(fromMs) {
      // READ of the live template store (activity-api `activity` table) through the same route
      // resolvers/activity-template.ts uses: GET /v2/activities/templates, newest first by created_at.
      // The list omits provenance and orders by created_at, while the ribosome UPSERTs a deterministic
      // learned-<slug> (an old created_at, a new updated_at), so: page the whole list, keep rows whose
      // updated_at is since fromMs, and read each of those in full (GET /templates/:id selects *).
      const { METABOB_ENDPOINT, METABOB_API_KEY } = await import("../config.js");
      const headers = { Authorization: `ApiKey ${METABOB_API_KEY}` };
      const recent: Array<Record<string, unknown>> = [];
      try {
        for (let offset = 0, pages = 0; pages < 60; offset += 100, pages++) {
          const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=100&offset=${offset}`, { headers, signal: AbortSignal.timeout(15_000) });
          if (!r.ok) return { ok: false, why: `template list HTTP ${r.status}` };
          const j = (await r.json()) as { templates?: Array<Record<string, unknown>> };
          const rows = Array.isArray(j.templates) ? j.templates : null;
          if (!rows) return { ok: false, why: "template list answered without templates[]" };
          for (const t of rows) if (Date.parse(String(t["updated_at"] ?? t["created_at"] ?? "")) >= fromMs) recent.push(t);
          if (rows.length < 100) break;
          if (pages === 59) return { ok: false, why: "template list longer than 6000 rows: scan incomplete" };
        }
        const full: Array<Record<string, unknown>> = [];
        for (const t of recent.slice(0, 200)) {
          const id = String(t["id"] ?? "").replace(/^activity:/, "").replace(/^⟨|⟩$/g, "");
          if (!id) continue;
          const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(10_000) });
          if (!r.ok) return { ok: false, why: `template ${id} HTTP ${r.status}` };
          const j = (await r.json()) as Record<string, unknown>;
          full.push({ ...t, ...((j["template"] ?? j) as Record<string, unknown>) });
        }
        if (recent.length > 200) return { ok: false, why: `${recent.length} templates written since the reach: too many to read in full this tick` };
        return { ok: true, templates: full };
      } catch (e) { return { ok: false, why: errText(e) }; }
    },

    async attachExtractionEvidence(entry) {
      // Resend the ribosome gap's own fields (an open gap must carry its summary) with the evidence entry
      // appended, guarded by the status read. Single writer of this key (this tick), idempotent per goal_hash.
      const { resolveSubstrateGap, resolveSubstrateGapWrite } = await import("./substrate-gap.js");
      const r = await resolveSubstrateGap({ type: "substrateGap", id: RIBOSOME_EVIDENCE_GAP_ID, limit: 5 });
      const g = ((r.body as { gaps?: Array<Record<string, unknown>> } | null)?.gaps ?? []).find((x) => x["id"] === RIBOSOME_EVIDENCE_GAP_ID);
      if (!g) return { ok: false, why: `gap ${RIBOSOME_EVIDENCE_GAP_ID} not found` };
      const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
      const KEY = "goal_reach_extraction_evidence";
      const next = appendEvidenceEntry(meta[KEY], entry);
      if (Array.isArray(meta[KEY]) && (meta[KEY] as unknown[]).length === next.length) return { ok: true };
      const w = await resolveSubstrateGapWrite({
        type: "substrateGap_write", expect_status: String(g["status"] ?? "open"),
        gap: {
          id: RIBOSOME_EVIDENCE_GAP_ID, category: g["category"], source: g["source"], status: g["status"], summary: g["summary"],
          detected_at: g["detected_at"], classification_metadata: { [KEY]: next },
        },
      } as never);
      const body = (w.body ?? {}) as Record<string, unknown>;
      if (w.shape !== "substrateGapWriteResult" || body["skip_reason"]) return { ok: false, why: String(body["skip_reason"] ?? body["detail"] ?? w.shape) };
      return { ok: true };
    },

    async fileLimitProposal(p) {
      const { resolvePoolImpulseWrite } = await import("./pool-impulse.js");
      const w = resolvePoolImpulseWrite({
        type: "poolImpulse_write", id: `limitChangeProposal:goal_reach:${p.goal_hash}`, shape: "limitChangeProposal",
        body: { ...p, source: "goal_reach_tick", proposed_at: new Date().toISOString() }, source: "goal_reach_tick", status: "open",
      });
      return { ok: w.body.ok, ...(w.body.error ? { why: w.body.error } : {}) };
    },

    async linkFiledGap(gapId, entry) {
      // Resend the gap's own fields (an open gap must carry its summary) with the entry appended under the store's
      // lock (demand_goals_append) and expect_status "open": a gap closed in between is not reopened.
      const { resolveSubstrateGap, resolveSubstrateGapWrite } = await import("./substrate-gap.js");
      const r = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 5 });
      const g = ((r.body as { gaps?: Array<Record<string, unknown>> } | null)?.gaps ?? []).find((x) => x["id"] === gapId);
      if (!g) return { ok: false, reason: "not_found", why: `gap ${gapId} not found` };
      const status = String(g["status"] ?? "open");
      if (status !== "open") return { ok: false, reason: "closed", why: `gap ${gapId} is ${status}${typeof (g["classification_metadata"] as Record<string, unknown> | undefined)?.["closed_reason"] === "string" ? ` (${String((g["classification_metadata"] as Record<string, unknown>)["closed_reason"]).slice(0, 80)})` : ""}` };
      const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
      const before = Array.isArray(meta["demand_goals"]) ? (meta["demand_goals"] as unknown[]).length : 0;
      if (mergeDemandGoal(meta["demand_goals"], entry).length === before) return { ok: true, linked: false };
      const w = await resolveSubstrateGapWrite({
        type: "substrateGap_write", expect_status: "open", demand_goals_append: [entry],
        gap: { id: gapId, category: g["category"], source: g["source"], status: "open", summary: g["summary"], detected_at: g["detected_at"], classification_metadata: {} },
      } as never);
      const body = (w.body ?? {}) as Record<string, unknown>;
      if (w.shape !== "substrateGapWriteResult" || body["skip_reason"]) {
        const why = String(body["skip_reason"] ?? body["detail"] ?? w.shape);
        return { ok: false, reason: body["skip_reason"] === "status_precondition_failed" ? "closed" : "write_refused", why };
      }
      return { ok: true, linked: true };
    },

    async recogniseDeficiencies(dispatches, now) {
      const gd = await import("./goal-deficiency.js");
      const empty: DeficiencyReport = { ok: true, tallied: 0, ignored: 0, filed: [], refused: [], skipped: [], unclassified: [], unread: [], unrecorded: [], reasons_read: 0, reasons_unrecorded: 0, reason_reads_failed: 0, skipped_no_goal_hash: 0, skipped_cut_goal: 0, candidates: [], localized: [] };
      const pol = await gd.readDeficiencyPolicy();
      if (!pol.ok) { console.warn(`[goal-reach] R2 off this tick: ${pol.why}`); return { ...empty, ok: false, why: pol.why }; }
      const { resolvePoolImpulse, resolvePoolImpulseWrite } = await import("./pool-impulse.js");
      const tallies: Record<string, import("./goal-deficiency.js").DeficiencyTally> = {};
      for (const imp of resolvePoolImpulse({ type: "poolImpulse", shape: gd.GOAL_DEFICIENCY_TALLY_SHAPE, status: "open" }).body.impulses) {
        const t = imp.body as import("./goal-deficiency.js").DeficiencyTally | null;
        if (t && typeof t.goal_hash === "string" && Array.isArray(t.entries)) tallies[t.goal_hash] = t;
      }
      // A reach of a tallied goal is graded by its judge path (leniency), so read its detail when the listing lacks it.
      let detailBudget = 10;
      for (const d of dispatches) {
        const h = dispatchGoalHash(d);
        if (d.reached !== true || !h || !tallies[h] || d.goalReachReason || !d.node || detailBudget <= 0) continue;
        detailBudget--;
        const w = await postResolve(d.node, { type: "goalWalkState", dispatchId: d.dispatchId }, 10_000);
        const b = (w.json?.["body"] ?? null) as Record<string, unknown> | null;
        if (w.ok && b) { d.goalReachReason = typeof b["goalReachReason"] === "string" ? b["goalReachReason"] : null; d.completionShapes = asStrArr(b["completionShapes"]); d.poolShapes = asStrArr(b["poolShapes"]); }
      }
      const { classifyFalsifier, resolveSubstrateGap, resolveSubstrateGapWrite } = await import("./substrate-gap.js");
      const isAdvertised = (shape: string): boolean | null => {
        const c = classifyFalsifier({ evidence_resolve: { shape } } as never) as unknown;
        const cls = typeof c === "string" ? c : String((c as { class?: unknown } | null)?.class ?? "");
        return cls === "class2" ? true : cls === "unresolvable" ? false : null;
      };
      const runs: import("./goal-deficiency.js").RunView[] = dispatches.map((d) => ({ ...d, goal_hash: dispatchGoalHash(d), origin: originOf(d), node: d.node ?? null }));
      // G3: a run R2 cannot tally is counted every tick, never folded away; only 0 in steady state means none is invisible.
      const unhashed = unhashedRuns(dispatches);
      console.log(`[goal-reach] R2 runs skipped: no goal_hash ${unhashed.no_goal_hash} (cut goal ${unhashed.cut_goal})`);
      // READ THE MISSING REASONS (C-tally-1): a not-reached run with no judge reason is unread until R2 reads it here, oldest first.
      let reasonsRead = 0, reasonsUnrecorded = 0, reasonReadsFailed = 0;
      const byId = new Map(runs.map((r) => [r.dispatchId, r]));
      // Legacy entries (tallied before C-tally-1: no reason, no class, often no node) are read too, through this node's own
      // goal-host when they name none; a record that stays unreadable for max_reason_read_attempts becomes UNRECORDED.
      const ownWalk = await ownUrls("goalWalkState").then((u) => (u.ok ? u.urls[0] ?? null : null)).catch(() => null);
      const failedReadHashes = new Set<string>();
      for (const n of gd.reasonsToRead(tallies, runs, pol.policy.max_reason_reads, ownWalk)) {
        const w = await postResolve(n.node, { type: "goalWalkState", dispatchId: n.dispatchId }, 10_000);
        const b = (w.json?.["body"] ?? null) as Record<string, unknown> | null;
        if (!w.ok || !b) { // the record could not be read: stays unread, retried later, until the attempt bound
          reasonReadsFailed++;
          if (gd.recordFailedRead(tallies, n.goal_hash, n.dispatchId, pol.policy.max_reason_read_attempts) !== "absent") failedReadHashes.add(n.goal_hash);
          continue;
        }
        const reason = typeof b["goalReachReason"] === "string" ? (b["goalReachReason"] as string).trim() : "";
        // Read, and the record has no reason: UNRECORDED (the source never wrote one), never re-read.
        if (reason) reasonsRead++; else reasonsUnrecorded++;
        const shapes = asStrArr(b["completionShapes"]);
        const r = byId.get(n.dispatchId);
        if (r) { r.goalReachReason = reason || null; r.completionShapes = shapes; r.reason_unrecorded = !reason; continue; }
        const t = tallies[n.goal_hash]!;
        runs.push({ dispatchId: n.dispatchId, goal_hash: n.goal_hash, goal: t.goal, status: "failed", reached: false, operator: null, origin: t.origin, startedAt: n.at, endedAt: n.at, goalReachReason: reason || null, completionShapes: shapes, node: n.node, reason_unrecorded: !reason });
      }
      const up = gd.tallyUpdate(tallies, runs, now, pol.policy, isAdvertised);
      for (const h of failedReadHashes) if (!up.touched.includes(h)) up.touched.push(h);
      // The current policy applies to the evidence already held, not only to runs seen from now on.
      const rc = gd.reclassifyStored(up.tallies, pol.policy, isAdvertised);
      for (const h of rc.changed) if (!up.touched.includes(h)) up.touched.push(h);
      if (rc.moved > 0) console.log(`[goal-reach] R2 reclassified ${rc.moved} stored entr${rc.moved === 1 ? "y" : "ies"} across ${rc.changed.length} goal(s) under the current policy`);
      for (const h of up.touched) resolvePoolImpulseWrite({ type: "poolImpulse_write", id: gd.tallyId(h), shape: gd.GOAL_DEFICIENCY_TALLY_SHAPE, body: up.tallies[h], source: "goal_reach_tick", status: "open" });
      let existing: Map<string, Record<string, unknown>> | null = null;
      try {
        const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
        const rows = (r.body as { gaps?: Array<Record<string, unknown>> } | null)?.gaps;
        if (r.shape === "substrateGap" && Array.isArray(rows)) existing = new Map(rows.filter((g) => String(g["id"] ?? "").startsWith("goal-deficiency-")).map((g) => [String(g["id"]), g]));
      } catch { existing = null; }
      const dec = gd.deficiencyDecisions(up.tallies, existing, now, pol.policy);
      const report: DeficiencyReport = { ...empty, tallied: up.touched.length, ignored: up.ignored, skipped: dec.skipped, unclassified: dec.unclassified, unread: dec.unread, unrecorded: dec.unrecorded, reasons_read: reasonsRead, reasons_unrecorded: reasonsUnrecorded, reason_reads_failed: reasonReadsFailed, skipped_no_goal_hash: unhashed.no_goal_hash, skipped_cut_goal: unhashed.cut_goal, candidates: dec.candidates, localized: [] };
      const sum = (xs: Array<{ count: number }>) => xs.reduce((s, u) => s + u.count, 0);
      console.log(`[goal-reach] R2 read ${reasonsRead} reason(s), ${reasonsUnrecorded} record(s) with none, ${reasonReadsFailed} unreadable; still unread ${sum(dec.unread)} run(s), unrecorded ${sum(dec.unrecorded)}; ${dec.candidates.length} candidate(s) (${dec.candidates.map((c) => `${c.reason_class}/${c.class_source}`).join(", ") || "none"})`);
      for (const w of dec.writes) {
        const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: w.gap, demand_goals_append: [w.demand], ...(w.expect_status ? { expect_status: w.expect_status } : {}) } as never);
        const body = (res.body ?? {}) as Record<string, unknown>;
        if (res.shape !== "substrateGapWriteResult" || body["skip_reason"]) {
          const why = String(body["skip_reason"] ?? body["detail"] ?? res.shape).slice(0, 200);
          report.refused.push({ id: w.id, why });
          console.warn(`[goal-reach] R2 ${w.kind} of ${w.id} refused: ${why}`);
        } else {
          report.filed.push({ id: w.id, kind: w.kind, count: w.count });
          console.log(`[goal-reach] R2 ${w.kind.toUpperCase()} ${w.id} (${w.count} not-reached run(s) judged ${w.reason_class})`);
        }
      }
      for (const u of dec.unclassified) console.warn(`[goal-reach] R2 ${u.count} unclassified reason(s) for goal_hash=${u.goal_hash}: ${u.samples.map((x) => JSON.stringify(x.slice(0, 120))).join(" | ")}`);
      // #1a LOCALIZE: an open deficiency row whose counted runs have not been attributed (or changed since) gets a site from
      // what its runs' own traces name — or a loud unknown with the per-run breakdown. Never from the goal or judge prose.
      if (existing !== null && pol.policy.max_localizations > 0) {
        const rows = new Map(existing);
        for (const w of dec.writes) rows.set(w.id, { ...(rows.get(w.id) ?? {}), ...w.gap, status: "open" });
        // Only rows with runs THIS node may attribute: its goal has a tally here (a row filed from another node's runs is
        // that node's to localize; a shared goal's runs are sorted per run by ownership inside localizeRow).
        const self = localizingNode();
        const due = [...rows.values()].filter((g) => String(g["status"] ?? "") === "open"
          && !!up.tallies[String(((g["classification_metadata"] ?? {}) as Record<string, unknown>)["goal_hash"] ?? "")]
          && needsLocalization(g, self, now, pol.policy.relocalize_unread_after_ms)).slice(0, pol.policy.max_localizations);
        let allRows: Array<Record<string, unknown>> | undefined;
        for (const g of due) {
          try {
            const { fresh, ...loc } = await localizeRow(g, up.tallies, pol.policy.siting_majority, now, { self, retryMs: pol.policy.relocalize_unread_after_ms });
            if (fresh === 0) continue; // nothing of this node's to attribute: never rewrite another node's verdict
            const meta = (g["classification_metadata"] ?? {}) as Record<string, unknown>;
            // #1b: each distinct failing step becomes a linked, sited step gap (reuse first), carrying this goal's demand,
            // so the goal waits on it and re-runs when it lands. Filed only when the policy files gaps.
            const children = pol.policy.file_gaps === 1
              ? await ensureStepChildren(g, loc, async () => (allRows ??= await readAllGaps(resolveSubstrateGap)), resolveSubstrateGapWrite)
              : [];
            const patch: Record<string, unknown> = { ...meta, localization: { ...loc, children }, ...(loc.state === "sited" ? { vessel: loc.vessel, failing_activity: loc.failing_activity, edit_site: loc.edit_site } : {}) };
            const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: g["id"], category: g["category"], source: g["source"], summary: g["summary"], detected_at: g["detected_at"], status: "open", classification_metadata: patch }, expect_status: "open" } as never);
            const ok = res.shape === "substrateGapWriteResult" && !((res.body ?? {}) as Record<string, unknown>)["skip_reason"];
            report.localized.push({ id: String(g["id"]), state: loc.state, kind: loc.kind, ...(ok ? {} : { refused: true }) });
            console.log(loc.state === "sited"
              ? `[goal-reach] R2 localization ${g["id"]}: SITED ${loc.vessel} ${loc.edit_site} (failing step ${loc.failing_activity}; ${loc.method})${ok ? "" : " — write refused"}`
              : `[goal-reach] R2 localization ${g["id"]}: unknown (${loc.kind}) — ${loc.why}${ok ? "" : " — write refused"}`);
          } catch (e) { console.warn(`[goal-reach] R2 localization ${g["id"]} failed: ${errText(e)}`); }
        }
      }
      // PACKAGE A: goal-linked missing-producer demand → the capability author route (src/resolvers/producer-dispatch.ts).
      // Only with file_gaps 1 (the same consent as filing); shaped mode, budget and cooldown in goalDeficiencyPolicy.
      if (pol.policy.file_gaps === 1 && pol.policy.producer_dispatch !== "off") {
        try {
          const pd = await import("./producer-dispatch.js");
          const all = await readAllGaps(resolveSubstrateGap);
          const { isWritePointerType } = await import("../lib/caller-credential.js");
          const { lookupShape } = await import("../config.js");
          const tallies = up.tallies;
          report.producer_dispatch = await pd.runProducerDispatch(all, now, pol.policy, (h) => [...new Set((tallies[h]?.entries ?? []).flatMap((e) => ((e.class === gd.MISSING_PRODUCER_CLASS || e.class === "phantom") && Array.isArray(e.missing_shapes) ? e.missing_shapes : [])))], {
            isWrite: isWritePointerType,
            advertised: async (shape) => pd.advertisedFrom(await lookupShape(shape)),
            declaredBy: async (shape) => pd.declaredBy(shape, (await import("../lib/evaluator-tree.js")).evaluatorTreeRoot()),
            readRun: async (id) => {
              // Read the run where it ran (runOriginBase): the dispatch's tally entry names its goal-host.
              const entry = Object.values(tallies).flatMap((t) => t?.entries ?? []).find((e) => e.dispatch_id === id);
              const base = await runOriginBase(entry);
              if (!base) return null;
              const r = await fetch(`${base}/executions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
              return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
            },
            write: async (gap, demand) => {
              const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap, demand_goals_append: [demand] } as never);
              const b = (res.body ?? {}) as Record<string, unknown>;
              return res.shape === "substrateGapWriteResult" && !b["skip_reason"] ? { ok: true } : { ok: false, why: String(b["skip_reason"] ?? b["detail"] ?? res.shape).slice(0, 200) };
            },
            dispatch: async (gapId, tag) => {
              const { selfAuthHeaders } = await import("../lib/self-auth.js");
              const url = process.env["SELF_RESOLVE_ENDPOINT"] ?? `http://localhost:${process.env["PORT"] ?? "8090"}/v2/impulses/resolve`;
              // fire-and-forget: the author compose runs for minutes; its outcome is graded on the gap row by the route itself
              void fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...selfAuthHeaders(url, url) }, body: JSON.stringify({ impulse: { pointer: { type: "gap_to_feature", gap_id: gapId, triggered_by: "goal-reach-producer-dispatch", flow: "capability-author", attribution: tag } } }), signal: AbortSignal.timeout(900_000) })
                .then((r) => console.log(`[producer-dispatch] author route answered HTTP ${r.status} for ${gapId}`))
                .catch((e) => console.warn(`[producer-dispatch] author route call for ${gapId} failed: ${errText(e)}`));
              return { ok: true };
            },
          }, (h) => String(tallies[h]?.goal ?? ""));
        } catch (e) { console.warn(`[producer-dispatch] failed: ${errText(e)}`); }
      }
      return report;
    },
  };
}

/** Wrap an I/O so nothing is written or dispatched: a read-only probe of what the tick would do. */
export function dryRunIO(io: GoalReachIO): GoalReachIO {
  return {
    ...io,
    saveRecord: async () => {},
    saveRecords: async (recs) => recs.map((r) => ({ goal_hash: r.goal_hash, ok: true })),
    dispatchGoal: async (req) => ({ ok: true, dispatch_id: `dry-run:${req.goal_hash}`, coalesced: false }),
    attachExtractionEvidence: async (e) => { console.log(`[goal-reach] DRY-RUN would attach extraction evidence goal_hash=${e.goal_hash}`); return { ok: true }; },
    fileLimitProposal: async (p) => { console.log(`[goal-reach] DRY-RUN would file limitChangeProposal goal_hash=${p.goal_hash} paths=${p.paths.join(",")}`); return { ok: true }; },
  };
}

async function readPolicy(): Promise<GoalReachPolicy> {
  try {
    const { resolvePoolImpulse } = await import("./pool-impulse.js");
    const res = resolvePoolImpulse({ type: "poolImpulse", shape: POLICY_SHAPE, status: "open", limit: 1 });
    const b = (res.body.impulses[0]?.body ?? {}) as Partial<GoalReachPolicy>;
    const p = { ...DEFAULT_GOAL_REACH_POLICY };
    if (asNum(b.max_cycles) !== null) p.max_cycles = b.max_cycles!;
    if (asNum(b.max_cost_usd) !== null) p.max_cost_usd = b.max_cost_usd!;
    if (asNum(b.pending_timeout_ms) !== null) p.pending_timeout_ms = b.pending_timeout_ms!;
    if (asNum(b.max_detail_reads) !== null) p.max_detail_reads = b.max_detail_reads!;
    if (asNum(b.extraction_window_ms) !== null) p.extraction_window_ms = b.extraction_window_ms!;
    if (asNum(b.min_interval_s) !== null) p.min_interval_s = b.min_interval_s!;
    if (typeof b.dry_run === "boolean") p.dry_run = b.dry_run;
    if (typeof b.link_filed_gaps === "boolean") p.link_filed_gaps = b.link_filed_gaps;
    return p;
  } catch { return { ...DEFAULT_GOAL_REACH_POLICY }; }
}

const LEDGER_SHAPE = "goalReachTickLedger";
const LEDGER_ID = "goalReachTickLedger:latest";
interface LedgerRow { ledger: TickLedger | null; last_run_at: number | null }

async function loadLedger(): Promise<LedgerRow> {
  const { resolvePoolImpulse } = await import("./pool-impulse.js");
  const res = resolvePoolImpulse({ type: "poolImpulse", id: LEDGER_ID, status: "open", limit: 1 });
  const b = (res.body.impulses[0]?.body ?? null) as LedgerRow | null;
  return { ledger: b?.ledger ?? null, last_run_at: typeof b?.last_run_at === "number" ? b.last_run_at : null };
}
async function saveLedger(row: LedgerRow): Promise<void> {
  // R's own grading memory, written in dry-run too: it is not an effect on the goals it observes.
  const { resolvePoolImpulseWrite } = await import("./pool-impulse.js");
  resolvePoolImpulseWrite({ type: "poolImpulse_write", id: LEDGER_ID, shape: LEDGER_SHAPE, body: row, source: "goal_reach_tick", status: "open" });
}
/** One activeDispatches page per own goal-host, no walk detail: the caller condition's cheap read. */
async function peekDispatches(): Promise<{ ok: true; rows: Array<{ dispatchId: string; status: string; reached: boolean | null }> } | { ok: false; why: string }> {
  const prod = await ownUrls("activeDispatches");
  if (!prod.ok) return { ok: false, why: prod.why };
  const rows: Array<{ dispatchId: string; status: string; reached: boolean | null }> = [];
  let answered = 0;
  for (const url of prod.urls) {
    const r = await postResolve(url, { type: "activeDispatches", limit: 50, offset: 0 }, 10_000);
    const ds = (r.json?.["body"] as { dispatches?: Array<Record<string, unknown>> } | undefined)?.dispatches;
    if (!r.ok || !Array.isArray(ds)) continue;
    answered++;
    for (const d of ds) rows.push({ dispatchId: String(d["dispatchId"] ?? ""), status: String(d["status"] ?? ""), reached: typeof d["reached"] === "boolean" ? d["reached"] : null });
  }
  return answered > 0 ? { ok: true, rows } : { ok: false, why: "no activeDispatches producer answered" };
}

/**
 * The resolver: `{type:"goal_reach_tick", dry_run?: boolean, force?: boolean}`.
 * 1. Caller condition (tickEligibility): not due → an idle result, nothing read beyond the cheap peek.
 * 2. Full tick (dry-run per goalReachPolicy.dry_run, default true; a pointer dry_run:true also forces it).
 * 3. Grade the previous tick against what this tick observed (gradeTick) and carry it (carryGrade).
 */
export async function resolveGoalReachTick(pointer: { type?: string; dry_run?: boolean; force?: boolean } = {}): Promise<ResolverResult> {
  const base = await readPolicy();
  const policy: GoalReachPolicy = { ...base, dry_run: base.dry_run || pointer.dry_run === true };
  const now = Date.now();
  try {
    const row = await loadLedger();
    if (!pointer.force) {
      const io0 = defaultGoalReachIO(policy);
      const [records, peek] = await Promise.all([io0.loadRecords(), peekDispatches()]);
      if (!peek.ok) return { shape: "structuredError", body: { resolver: "goal_reach_tick", detail: `caller condition unreadable: ${peek.why}` } };
      const e = tickEligibility({ records, peek: peek.rows, last_run_at: row.last_run_at }, now, policy);
      if (!e.run) {
        console.log(`[goal-reach] idle: ${e.reason}`);
        return carryGrade({ verdict: "neutral", reasons: ["not run: " + e.reason] }, { summary: summarize(Object.values(records)), actions: [], idle: true, idle_reason: e.reason, policy });
      }
    }
    const io = policy.dry_run ? dryRunIO(defaultGoalReachIO(policy)) : defaultGoalReachIO(policy);
    const r = await runGoalReachTick(io, policy, now);
    const grade = r.ok ? gradeTick(row.ledger, r.observed) : { verdict: "neutral" as const, reasons: ["this tick could not observe state; previous tick left ungraded"] };
    await saveLedger({ ledger: r.ok ? r.ledger : row.ledger, last_run_at: now });
    console.log(`[goal-reach] previous tick graded ${grade.verdict}${grade.reasons.length ? `: ${grade.reasons.slice(0, 3).join("; ")}` : ""}`);
    const { observed: _observed, ...rest } = r;
    return carryGrade(grade, { ...rest, summary: r.summary, actions: r.ledger.actions, policy, dry_run: policy.dry_run });
  } catch (e) {
    return { shape: "structuredError", body: { resolver: "goal_reach_tick", detail: errText(e) } };
  }
}
