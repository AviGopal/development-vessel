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
}
/** Interim defaults until slice L; overridden by the newest open `goalReachPolicy` pool record (law 1). */
export const DEFAULT_GOAL_REACH_POLICY: GoalReachPolicy = {
  max_cycles: 5,
  max_cost_usd: 5,
  pending_timeout_ms: 30 * 60_000,
  max_detail_reads: 20,
  extraction_window_ms: 30 * 60_000,
};

export type GoalReachAction =
  | { kind: "none"; reason: string }
  | { kind: "wait"; waiting_on: string[] }
  | { kind: "redispatch"; goal: string; goal_hash: string }
  | { kind: "stop"; reason: string; limit_proposal?: { goal_hash: string; paths: string[]; gap_ids: string[] } }
  | { kind: "ask_human"; reason: string; write_shapes: string[]; addressee: string };

// ── classification helpers ────────────────────────────────────────────────────────────────────────

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
export function originOf(d: Pick<DispatchObservation, "operator" | "trigger">): GoalReachOrigin {
  const op = typeof d.operator === "string" ? d.operator.trim() : "";
  if (d.trigger === "note") return "surface";
  if (!op) return "autonomous";
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
  if (open.length > 0) return { kind: "wait", waiting_on: open.map((g) => g.id) };
  if (linked.length === 0) return { kind: "none", reason: "unlinked" };

  const lastAttempt = latest ? latest.startedAt : 0;
  if (!linked.some((g) => gapClosedAt(g) > lastAttempt)) return { kind: "none", reason: "no_new_closure" };

  const unkeyed = rec.landed_write_shapes.filter((w) => !IDEMPOTENT_BY_KEY_WRITE_SHAPES.has(w));
  if (rec.origin !== "autonomous" && unkeyed.length > 0) {
    return { kind: "ask_human", reason: `${rec.origin} goal landed writes on an earlier attempt`, write_shapes: unkeyed, addressee: askAddressee(rec) };
  }
  return { kind: "redispatch", goal: rec.goal, goal_hash: rec.goal_hash };
}

// ── attribution ───────────────────────────────────────────────────────────────────────────────────

/**
 * Close reasons written by an autonomous closer (the store's own sweeps, the lane's verified landing,
 * detectors). Any other closed state — `human_dropped`, or no reason at all — is a hand close.
 * Grep of dev-vessel origin/dev 182d2447 for closed_reason writers.
 */
export const AUTONOMOUS_CLOSE_REASONS: ReadonlySet<string> = new Set([
  "landed_verified", "landed_literal_only", "already_resolved", "condition_gone", "producer_now_exists",
  "predicate_verified_by_detector", "violation_not_reproduced_on_rescan", "closed_via_child",
  "expired_not_redetected", "churned_unlandable", "persistent_compose_failure", "walk_artifact",
]);
const isOperatorRouteSource = (s: unknown): boolean => typeof s === "string" && (s === "human_reported" || /^operator/.test(s));
/** A dispatch a human made: goal-host trigger "operator" (any operator id) or a surface/note dispatch. */
const isHumanDispatch = (e: Pick<ChainEntry, "trigger" | "operator">): boolean =>
  e.trigger === "operator" || e.trigger === "note" || (typeof e.operator === "string" && e.operator.trim().length > 0);

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
  if (reacher && isRIssued(rec, reacher)) return { attribution: "r", reasons: [] };
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

// ── the tick ──────────────────────────────────────────────────────────────────────────────────────

export interface GoalDispatchRequest {
  goal: string;
  goal_hash: string;
  tags: string[];
  variables: Record<string, unknown>;
}
export interface GoalReachIO {
  /** Recent goal-host dispatches (this substrate's own goal-hosts). `known` = chain ids already detailed. */
  listDispatches(ctx: { known: Set<string>; r_issued: Set<string> }): Promise<{ ok: true; dispatches: DispatchObservation[] } | { ok: false; why: string }>;
  readGaps(goalHashes: string[]): Promise<{ ok: true; gaps: GapView[] } | { ok: false; why: string }>;
  readLandings(fromMs: number, toMs: number): Promise<{ ok: true; landings: LandingView[] } | { ok: false; why: string }>;
  /** The autonomy-scope check, or null when the scope is unreadable (then no blocked_by_scope verdict). */
  scopeExcludes(): Promise<((path: string) => string | null) | null>;
  loadRecords(): Promise<Record<string, GoalReachRecord>>;
  saveRecord(rec: GoalReachRecord): Promise<void>;
  dispatchGoal(req: GoalDispatchRequest): Promise<{ ok: true; dispatch_id: string; coalesced: boolean } | { ok: false; why: string }>;
  /** Templates written since `fromMs`, with their provenance fields (a READ of the template store). */
  readTemplatesSince(fromMs: number): Promise<{ ok: true; templates: Array<Record<string, unknown>> } | { ok: false; why: string }>;
  /** Append an absent-extraction evidence entry to the ribosome gap (idempotent per goal_hash). */
  attachExtractionEvidence(entry: { goal_hash: string } & Record<string, unknown>): Promise<{ ok: boolean; why?: string }>;
  fileLimitProposal(p: { goal_hash: string; paths: string[]; gap_ids: string[]; reason: string }): Promise<{ ok: boolean; why?: string }>;
}

export interface GoalReachTickResult {
  ok: boolean;
  why?: string;
  summary: GoalReachSummary;
  redispatched: Array<{ goal_hash: string; dispatch_id: string }>;
  stopped: Array<{ goal_hash: string; reason: string }>;
  asked_human: Array<{ goal_hash: string; write_shapes: string[] }>;
  errors: string[];
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

export async function runGoalReachTick(io: GoalReachIO, policy: GoalReachPolicy, now = Date.now()): Promise<GoalReachTickResult> {
  const result: GoalReachTickResult = { ok: true, summary: summarize([]), redispatched: [], stopped: [], asked_human: [], errors: [] };
  const prior = await io.loadRecords();
  const known = new Set<string>();
  const rIssued = new Set<string>();
  for (const r of Object.values(prior)) {
    for (const e of r.dispatches) if (isTerminal(e.status)) known.add(e.dispatchId);
    for (const id of r.r_issued) rIssued.add(id);
  }
  const listed = await io.listDispatches({ known, r_issued: rIssued });
  if (!listed.ok) return { ...result, ok: false, why: `dispatches unreadable: ${listed.why}`, summary: summarize(Object.values(prior)) };

  const records = observe(prior, listed.dispatches, now, policy);
  const live = Object.values(records);
  const gapsRead = await io.readGaps(live.map((r) => r.goal_hash));
  if (!gapsRead.ok) {
    for (const r of live) await io.saveRecord(r);
    return { ...result, ok: false, why: `gaps unreadable: ${gapsRead.why}`, summary: summarize(live) };
  }
  const gaps = gapsRead.gaps;
  const scope = await io.scopeExcludes().catch(() => null);
  let landings: LandingView[] | null = null;

  for (const rec of live) {
    const wasTerminal = prior[rec.goal_hash]?.status === "stopped";
    linkGaps(rec, gaps);

    if (rec.status === "reached") {
      const before = JSON.stringify(rec);
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
      if (JSON.stringify(rec) !== before || !prior[rec.goal_hash]) { rec.updated_at = now; await io.saveRecord(rec); }
      continue;
    }
    if (wasTerminal) continue;

    const action = nextAction(rec, gaps, policy, { scopeExcludes: scope });
    rec.last_action = { kind: action.kind, ...("reason" in action ? { reason: action.reason } : {}), at: now };
    if (action.kind === "stop") {
      rec.status = "stopped";
      rec.stop_reason = action.reason;
      result.stopped.push({ goal_hash: rec.goal_hash, reason: action.reason });
      console.log(`[goal-reach] STOPPED goal_hash=${rec.goal_hash} reason=${action.reason}`);
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
    } else if (action.kind === "redispatch") {
      const cycle = rec.cycles + 1;
      try {
        const r = await io.dispatchGoal({
          goal: action.goal,
          goal_hash: action.goal_hash,
          // NEVER `operator`: goal-host maps any operator id to trigger "operator", which would make
          // R's own re-dispatch read as operator hands. The tag yields trigger "goal_reach".
          tags: ["dispatcher_reason:goal_reach", `goal_reach:${action.goal_hash}`, `goal_reach_cycle:${cycle}`],
          variables: { source: "goal_reach", goal_reach_goal_hash: action.goal_hash, goal_reach_cycle: cycle },
        });
        if (!r.ok) result.errors.push(`redispatch ${rec.goal_hash} failed: ${r.why}`);
        else if (r.coalesced) {
          rec.last_action = { kind: "redispatch_coalesced", reason: `goal-host returned the already-running ${r.dispatch_id}`, at: now };
        } else {
          rec.r_issued.push(r.dispatch_id);
          rec.last_redispatch_at = now;
          rec.status = "redispatching";
          rec.cycles = cycle;
          result.redispatched.push({ goal_hash: rec.goal_hash, dispatch_id: r.dispatch_id });
          console.log(`[goal-reach] REDISPATCHED goal_hash=${rec.goal_hash} dispatch=${r.dispatch_id} cycle=${cycle}/${policy.max_cycles}`);
        }
      } catch (e) {
        result.errors.push(`redispatch ${rec.goal_hash} threw: ${errText(e)}`);
      }
    }
    rec.updated_at = now;
    await io.saveRecord(rec);
  }
  result.summary = summarize(live);
  console.log(`[goal-reach] tick goals=${result.summary.goals} unlinked=${result.summary.open_unlinked} waiting=${result.summary.waiting} redispatched=${result.redispatched.length} reached_without_hands=${result.summary.reached_without_hands} reached_by_r=${result.summary.reached_by_r} stopped=${result.summary.stopped} errors=${result.errors.length}`);
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
  const { discoverOwnResolveUrls } = await import("./gap-to-feature.js");
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

export function defaultGoalReachIO(policy: GoalReachPolicy): GoalReachIO {
  return {
    async listDispatches({ known, r_issued }) {
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
          const failedTerminal = obs.status !== "running" && obs.reached !== true;
          const wantDetail = !known.has(id) && (failedTerminal || r_issued.has(id) || (obs.goal !== null && obs.goal.length >= ACTIVE_DISPATCHES_GOAL_CUT));
          if (wantDetail && detailBudget > 0) {
            detailBudget--;
            const w = await postResolve(url, { type: "goalWalkState", dispatchId: id }, 10_000);
            const b = (w.json?.["body"] ?? null) as Record<string, unknown> | null;
            if (w.ok && b) {
              if (typeof b["goal"] === "string") { obs.goal = b["goal"]; obs.goal_full = true; }
              obs.goalReachReason = typeof b["goalReachReason"] === "string" ? b["goalReachReason"] : null;
              obs.poolShapes = asStrArr(b["poolShapes"]);
              obs.completionShapes = asStrArr(b["completionShapes"]);
              if (typeof b["reached"] === "boolean") obs.reached = b["reached"];
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
      const { autonomyScope, autonomyScopeExcludes } = await import("./gap-to-feature.js");
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
  };
}

/** Wrap an I/O so nothing is written or dispatched: a read-only probe of what the tick would do. */
export function dryRunIO(io: GoalReachIO): GoalReachIO {
  return {
    ...io,
    saveRecord: async () => {},
    dispatchGoal: async (req) => ({ ok: true, dispatch_id: `dry-run:${req.goal_hash}`, coalesced: false }),
    attachExtractionEvidence: async () => ({ ok: false, why: "dry_run" }),
    fileLimitProposal: async () => ({ ok: false, why: "dry_run" }),
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
    return p;
  } catch { return { ...DEFAULT_GOAL_REACH_POLICY }; }
}

/** The resolver: `{type:"goal_reach_tick", dry_run?: boolean}` → goalReachTickResult. */
export async function resolveGoalReachTick(pointer: { type?: string; dry_run?: boolean } = {}): Promise<ResolverResult> {
  const policy = await readPolicy();
  const base = defaultGoalReachIO(policy);
  const io = pointer.dry_run ? dryRunIO(base) : base;
  try {
    const r = await runGoalReachTick(io, policy);
    return { shape: "goalReachTickResult", body: { ...r, policy, dry_run: pointer.dry_run === true } };
  } catch (e) {
    return { shape: "structuredError", body: { resolver: "goal_reach_tick", detail: errText(e) } };
  }
}
