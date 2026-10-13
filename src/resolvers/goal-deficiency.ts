/**
 * goal_deficiency — R2 of the goal-reach seam: RECOGNISE a goal that keeps failing a content judgment, and file the
 * gap that names it (the recognition link of the closed loop: a blocked goal → a gap the system knows must close).
 *
 * WHY. The goal-reach tick parks a goal on gaps linked to it and re-dispatches it when they close, but nothing filed a
 * gap for a goal whose runs are judged not reached for the SAME named deficiency, run after run. Measured (census of
 * goal-host dispatch records, 7 days): real goals are blocked by content judgments ("the required <deliverable> was not
 * produced", "did not address …"), not by missing producers; route-around shapes that name no registered producer are
 * mostly phantom. So recognition reads the judge's own reasons.
 *
 * WHAT IT DOES (pure functions; the tick supplies the I/O):
 *   - TALLY (tallyUpdate): per goal_hash, every terminal run of a goal that has failed at least once: reached or not,
 *     the judge's reason (normalised), its REASON CLASS by the shaped class map (first matching rule), and for a reach
 *     the judge path (reason, produced shapes, template). Abstains are kept but never counted; a run whose only reason
 *     is a missing producer for shapes that are neither in the goal's inferred target nor advertised is PHANTOM (kept,
 *     never counted). A reason no rule matches is UNCLASSIFIED: counted and sampled, never filed (unknown is loud).
 *   - DECIDE (deficiencyDecisions): at >= min_runs not-reached runs of one goal_hash sharing a class within the window,
 *     and after the goal's last trusted reach, ONE OPEN gap per (goal_hash, class): id goal-deficiency-<hash>-<class>,
 *     summary = the judge's own words and the goal text (never a suggested fix), classification_metadata
 *     {kind:"goal_content_deficiency", goal_hash, reason_class, sample_reasons, dispatch_ids}, linked to the goal by a
 *     demand_goals_append entry, NO edit_site (it enters the pipeline needing localization). The falsifier is class 2:
 *     goal_reach_verdict(goal_hash).unreached_since_last_reach must reach 0.
 *     Guards, mirroring the verdict-class filer: one row per (goal, class) by a canonical id; an unread store files
 *     nothing; a closed row is reopened only on >= min_runs failures since its closed_at; a rejected row is never
 *     refiled; any other status is left alone and reported; at most max_new_per_run creates + reopens per call.
 *   - VERDICT (goalReachVerdict): the flat read the falsifier resolves. A reach whose judge path matches a LENIENT rule
 *     (shaped; none by default) does not reset the count: it is reported as reached_lenient.
 *
 * STATE: one `goalDeficiencyTally:<hash>` pool record per goal (bookkeeping, written in dry-run too). POLICY: the newest
 * open `goalDeficiencyPolicy` pool record over the defaults below (law 1); an invalid record files nothing.
 */
import { gapClassKey } from "./substrate-gap.js";

export const GOAL_DEFICIENCY_POLICY_SHAPE = "goalDeficiencyPolicy";
export const GOAL_DEFICIENCY_TALLY_SHAPE = "goalDeficiencyTally";
export const GOAL_REACH_VERDICT_SHAPE = "goal_reach_verdict";
export const tallyId = (goalHash: string): string => `goalDeficiencyTally:${goalHash}`;
export const deficiencyGapId = (goalHash: string, cls: string): string => `goal-deficiency-${goalHash}-${cls}`;
export const DEFICIENCY_SOURCE = "goal_deficiency_recognition";

export interface DeficiencyClassRule { class: string; patterns: string[] }
/** A reach whose judge path matches any listed field is lenient: it does not count as the goal being reached. */
export interface LenientReachRule { reason_patterns?: string[]; shapes?: string[]; template_patterns?: string[] }
export interface GoalDeficiencyPolicy {
  /** 1: file gaps; 0: tally and report only. */
  file_gaps: number;
  /** Not-reached runs of one goal sharing a class, at least. */
  min_runs: number;
  window_hours: number;
  /** Creates + reopens one call may write. */
  max_new_per_run: number;
  /** Runs kept per goal. */
  max_entries: number;
  /** Ordered: the first rule whose pattern matches a reason names its class. */
  classes: DeficiencyClassRule[];
  /** A reason matching one of these is an abstain (not graded): kept, never counted. */
  abstain_patterns: string[];
  /** Runs whose operator matches one of these (operator-written test goals) are not tallied. */
  ignore_operator_patterns: string[];
  lenient_reach: LenientReachRule[];
}

export const MISSING_PRODUCER_CLASS = "missing_producer";
const MISSING_SHAPES_RE = /missing shapes \[([^\]]*)\]/i;

export const DEFAULT_GOAL_DEFICIENCY_POLICY: Readonly<GoalDeficiencyPolicy> = Object.freeze({
  file_gaps: 1,
  min_runs: 3,
  window_hours: 168,
  max_new_per_run: 2,
  max_entries: 60,
  classes: [
    { class: "deliverable_not_produced", patterns: ["\\bnot produced\\b", "did not produce", "did not provide the required", "\\brequired \\S+ was not\\b", "no (output|deliverable) (was )?produced", "missing (the )?required (output|deliverable)"] },
    { class: "did_not_address", patterns: ["did not address", "does not address", "failed to address", "not addressing"] },
    { class: "ungrounded", patterns: ["ungrounded", "not grounded", "unsupported claim"] },
    { class: "no_substantive_content", patterns: ["no substantive", "only general references", "generic (answer|response)", "\\bhollow\\b"] },
    { class: MISSING_PRODUCER_CLASS, patterns: ["no producer or constructible payload for missing shapes"] },
    { class: "execution_error", patterns: ["\\berror\\b", "\\bexception\\b", "unable to connect", "timed out", "failed to execute"] },
  ],
  abstain_patterns: ["\\babstain", "not graded", "cut-view"],
  ignore_operator_patterns: ["^test[-:_]", "^probe[-:_]"],
  lenient_reach: [],
}) as GoalDeficiencyPolicy;

const CLASS_TOKEN = /^[a-z][a-z0-9_]{1,40}$/;
const HASH_TOKEN = /^[0-9a-f]{8}$/;
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const compiles = (p: string): boolean => { try { new RegExp(p, "i"); return true; } catch { return false; } };
const intIn = (v: unknown, min: number, max: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** The policy from a pool record body over the defaults, or why it is invalid (then nothing is filed). */
export function parseDeficiencyPolicy(body: unknown): { ok: true; policy: GoalDeficiencyPolicy } | { ok: false; why: string } {
  const p: GoalDeficiencyPolicy = JSON.parse(JSON.stringify(DEFAULT_GOAL_DEFICIENCY_POLICY));
  if (body === null || body === undefined) return { ok: true, policy: p };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, why: "goalDeficiencyPolicy is not an object" };
  const b = body as Record<string, unknown>;
  const ints: Array<[keyof GoalDeficiencyPolicy, number, number]> = [["file_gaps", 0, 1], ["min_runs", 2, 1000], ["window_hours", 24, 24 * 90], ["max_new_per_run", 0, 50], ["max_entries", 10, 500]];
  for (const [k, lo, hi] of ints) {
    if (b[k] === undefined) continue;
    if (!intIn(b[k], lo, hi)) return { ok: false, why: `goalDeficiencyPolicy.${k} must be an integer in ${lo}..${hi}` };
    (p as unknown as Record<string, unknown>)[k] = b[k];
  }
  if (b["classes"] !== undefined) {
    if (!Array.isArray(b["classes"])) return { ok: false, why: "goalDeficiencyPolicy.classes must be an array" };
    const out: DeficiencyClassRule[] = [];
    for (const r of b["classes"] as unknown[]) {
      const cls = (r as { class?: unknown } | null)?.class;
      const pats = strList((r as { patterns?: unknown } | null)?.patterns);
      if (typeof cls !== "string" || !CLASS_TOKEN.test(cls) || !pats || !pats.every(compiles)) return { ok: false, why: `goalDeficiencyPolicy.classes: a rule needs a class token ${CLASS_TOKEN} and patterns that compile` };
      out.push({ class: cls, patterns: pats });
    }
    p.classes = out;
  }
  for (const k of ["abstain_patterns", "ignore_operator_patterns"] as const) {
    if (b[k] === undefined) continue;
    const l = strList(b[k]);
    if (!l || !l.every(compiles)) return { ok: false, why: `goalDeficiencyPolicy.${k} must be a list of patterns that compile` };
    p[k] = l;
  }
  if (b["lenient_reach"] !== undefined) {
    if (!Array.isArray(b["lenient_reach"])) return { ok: false, why: "goalDeficiencyPolicy.lenient_reach must be an array" };
    const out: LenientReachRule[] = [];
    for (const r of b["lenient_reach"] as unknown[]) {
      const o = (r ?? {}) as Record<string, unknown>;
      const rule: LenientReachRule = {};
      for (const k of ["reason_patterns", "shapes", "template_patterns"] as const) {
        if (o[k] === undefined) continue;
        const l = strList(o[k]);
        if (!l || (k !== "shapes" && !l.every(compiles))) return { ok: false, why: `goalDeficiencyPolicy.lenient_reach.${k} must be a list of strings (patterns that compile)` };
        rule[k] = l;
      }
      if (!rule.reason_patterns && !rule.shapes && !rule.template_patterns) return { ok: false, why: "goalDeficiencyPolicy.lenient_reach: a rule names no field" };
      out.push(rule);
    }
    p.lenient_reach = out;
  }
  return { ok: true, policy: p };
}

// ── the tally ───────────────────────────────────────────────────────────────────────────────────────

export interface ReachJudge { reason: string; shapes: string[]; template: string | null }
export interface TallyEntry {
  dispatch_id: string;
  at: number;
  reached: boolean;
  reason: string;
  /** The reason class; "abstain" and "phantom" are kept but never counted; null = unclassified. */
  class: string | null;
  missing_shapes?: string[];
  judge?: ReachJudge;
}
export interface DeficiencyTally {
  goal_hash: string;
  goal: string;
  origin: "operator" | "surface" | "autonomous";
  entries: TallyEntry[];
  updated_at: number;
}
/** The fields of a dispatch the tally reads (the goal-reach tick's DispatchObservation carries them). */
export interface RunView {
  dispatchId: string;
  goal_hash: string | null;
  goal: string | null;
  status: string;
  reached: boolean | null;
  operator: string | null;
  origin: "operator" | "surface" | "autonomous";
  startedAt: number;
  endedAt?: number | null;
  goalReachReason?: string | null;
  completionShapes?: string[] | null;
  poolShapes?: string[];
  selectedTemplateId?: string | null;
}

const normReason = (raw: unknown): string => String(raw ?? "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
  .replace(/\s+/g, " ").trim().slice(0, 300);
const anyMatch = (patterns: readonly string[], text: string): boolean => patterns.some((p) => { try { return new RegExp(p, "i").test(text); } catch { return false; } });

/**
 * The class of a not-reached run's reason. `isAdvertised(shape)` answers whether the fleet advertises a shape (null when
 * that cannot be judged: then nothing is called phantom on that ground).
 */
export function classifyReason(reason: string, inferredTarget: readonly string[], policy: GoalDeficiencyPolicy, isAdvertised: (shape: string) => boolean | null): { class: string | null; missing_shapes?: string[] } {
  if (anyMatch(policy.abstain_patterns, reason)) return { class: "abstain" };
  const m = MISSING_SHAPES_RE.exec(reason);
  if (m) {
    const shapes = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    const real = shapes.filter((s) => inferredTarget.includes(s) || isAdvertised(s) !== false);
    if (shapes.length > 0 && real.length === 0) return { class: "phantom", missing_shapes: shapes };
  }
  for (const r of policy.classes) if (anyMatch(r.patterns, reason)) return { class: r.class, ...(m ? { missing_shapes: m[1]!.split(",").map((s) => s.trim()).filter(Boolean) } : {}) };
  return { class: null };
}

/** Fold terminal runs into the per-goal tallies (returns new objects). A goal is tallied once it has failed. */
export function tallyUpdate(tallies: Record<string, DeficiencyTally>, runs: readonly RunView[], now: number, policy: GoalDeficiencyPolicy, isAdvertised: (shape: string) => boolean | null): { tallies: Record<string, DeficiencyTally>; touched: string[]; ignored: number } {
  const out: Record<string, DeficiencyTally> = JSON.parse(JSON.stringify(tallies ?? {}));
  const touched = new Set<string>();
  let ignored = 0;
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    if (r.status === "running" || r.status === "pending" || !r.goal_hash || !HASH_TOKEN.test(r.goal_hash)) continue;
    if (typeof r.operator === "string" && anyMatch(policy.ignore_operator_patterns, r.operator)) { ignored++; continue; }
    let t = out[r.goal_hash];
    if (!t) {
      if (r.reached === true) continue;
      t = out[r.goal_hash] = { goal_hash: r.goal_hash, goal: String(r.goal ?? ""), origin: r.origin, entries: [], updated_at: now };
    }
    if (typeof r.goal === "string" && r.goal.length > t.goal.length) t.goal = r.goal;
    const reason = normReason(r.goalReachReason);
    const target = r.completionShapes ?? [];
    const e: TallyEntry = r.reached === true
      ? { dispatch_id: r.dispatchId, at: r.endedAt ?? r.startedAt, reached: true, reason, class: null, judge: { reason, shapes: [...(r.completionShapes ?? r.poolShapes ?? [])], template: r.selectedTemplateId ?? null } }
      : { dispatch_id: r.dispatchId, at: r.endedAt ?? r.startedAt, reached: false, reason, ...(reason ? classifyReason(reason, target, policy, isAdvertised) : { class: null }) };
    const i = t.entries.findIndex((x) => x.dispatch_id === r.dispatchId);
    // A later, thinner observation (no reason) never erases a reason already read.
    if (i >= 0) { if (reason || !t.entries[i]!.reason) t.entries[i] = e; }
    else t.entries.push(e);
    t.entries.sort((a, b) => a.at - b.at);
    if (t.entries.length > policy.max_entries) t.entries = t.entries.slice(-policy.max_entries);
    t.updated_at = now;
    touched.add(r.goal_hash);
  }
  return { tallies: out, touched: [...touched], ignored };
}

export function isLenientReach(judge: ReachJudge | undefined, policy: Pick<GoalDeficiencyPolicy, "lenient_reach">): boolean {
  if (!judge) return false;
  return policy.lenient_reach.some((r) =>
    (r.reason_patterns ? anyMatch(r.reason_patterns, judge.reason) : false)
    || (r.shapes ? r.shapes.some((s) => judge.shapes.includes(s)) : false)
    || (r.template_patterns && judge.template ? anyMatch(r.template_patterns, judge.template) : false));
}

/** The entries after the goal's last TRUSTED (non-lenient) reach. */
function sinceLastTrustedReach(t: DeficiencyTally, policy: Pick<GoalDeficiencyPolicy, "lenient_reach">): TallyEntry[] {
  let from = 0;
  t.entries.forEach((e, i) => { if (e.reached && !isLenientReach(e.judge, policy)) from = i + 1; });
  return t.entries.slice(from);
}

// ── the verdict the falsifier reads ─────────────────────────────────────────────────────────────────

export interface GoalReachVerdict {
  measured: boolean;
  goal_hash: string;
  why?: string;
  runs?: number;
  /** Not-reached runs since the last trusted reach (abstains and phantoms excluded). 0 ⇔ the latest graded run reached. */
  unreached_since_last_reach?: number;
  last_reached_at?: string | null;
  /** The judge path of the latest reach (trusted or not): reason · shapes · template. */
  last_reach_judge?: string | null;
  /** The latest reach matched a lenient rule, and no trusted reach followed it. */
  reached_lenient?: boolean;
  lenient_reaches?: number;
}

export function goalReachVerdict(goalHash: string, tally: DeficiencyTally | null, policy: GoalDeficiencyPolicy): GoalReachVerdict {
  if (!HASH_TOKEN.test(goalHash)) return { measured: false, goal_hash: goalHash, why: "goal_hash must be 8 hex chars" };
  if (!tally) return { measured: false, goal_hash: goalHash, why: "no tally for this goal (it has not failed since the tally began)" };
  const since = sinceLastTrustedReach(tally, policy);
  const unreached = since.filter((e) => !e.reached && e.class !== "abstain" && e.class !== "phantom").length;
  const reaches = tally.entries.filter((e) => e.reached);
  const trusted = reaches.filter((e) => !isLenientReach(e.judge, policy));
  const latestReach = reaches[reaches.length - 1];
  const lastTrusted = trusted[trusted.length - 1];
  const judgeText = (j?: ReachJudge): string | null => (j ? `${j.reason || "(no reason)"} · shapes [${j.shapes.join(",")}] · template ${j.template ?? "-"}` : null);
  // A tally begins at a failure, so with no trusted reach the count is already >= 1: a lenient reach never zeroes it.
  const latestIsLenient = !!latestReach && isLenientReach(latestReach.judge, policy) && (!lastTrusted || lastTrusted.at < latestReach.at);
  return {
    measured: true,
    goal_hash: goalHash,
    runs: tally.entries.length,
    unreached_since_last_reach: unreached,
    last_reached_at: lastTrusted ? new Date(lastTrusted.at).toISOString() : null,
    last_reach_judge: judgeText(latestReach?.judge),
    reached_lenient: latestIsLenient,
    lenient_reaches: reaches.length - trusted.length,
  };
}

// ── deciding what to file ───────────────────────────────────────────────────────────────────────────

export interface DeficiencyWrite {
  kind: "create" | "reopen" | "refresh";
  id: string;
  goal_hash: string;
  reason_class: string;
  count: number;
  gap: Record<string, unknown>;
  expect_status?: string;
  demand: { source: "goal_reach"; goal_hash: string; dispatch_id: string; origin: "operator" | "surface" | "autonomous" };
}
export interface DeficiencyDecision {
  writes: DeficiencyWrite[];
  skipped: Array<{ goal_hash: string; reason_class?: string; why: string }>;
  unclassified: Array<{ goal_hash: string; count: number; samples: string[] }>;
  candidates: Array<{ goal_hash: string; reason_class: string; count: number }>;
}

const excerpt = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The gap row for one (goal, class): the judge's own words and the goal text, nothing else. */
export function deficiencyGapRow(t: DeficiencyTally, cls: string, failed: TallyEntry[], windowHours: number, nowIso: string): Record<string, unknown> {
  const latest = failed[failed.length - 1]!;
  const samples = [...new Set(failed.slice().reverse().map((e) => e.reason).filter(Boolean))].slice(0, 3);
  return {
    id: deficiencyGapId(t.goal_hash, cls),
    category: "systematic_failure",
    source: DEFICIENCY_SOURCE,
    status: "open",
    detected_at: nowIso,
    summary: `Goal not reached on ${failed.length} run(s) in ${windowHours} h, judged ${cls.replace(/_/g, " ")}: "${excerpt(latest.reason, 300)}". Goal: "${excerpt(t.goal, 300)}"`,
    classification_metadata: {
      kind: "goal_content_deficiency",
      goal_hash: t.goal_hash,
      reason_class: cls,
      sample_reasons: samples,
      dispatch_ids: failed.slice(-10).map((e) => e.dispatch_id),
      counted_runs: failed.length,
      window_hours: windowHours,
      evidence_resolve: { shape: GOAL_REACH_VERDICT_SHAPE, input: { goal_hash: t.goal_hash }, zero_field: "unreached_since_last_reach" },
      falsifier_spec: `${GOAL_REACH_VERDICT_SHAPE}(goal_hash=${t.goal_hash}).unreached_since_last_reach == 0: a later run of this goal is judged reached on a path not listed as lenient`,
    },
  };
}

/**
 * What to file. `existing` is the store's rows by id (null = the store was not read: nothing is filed). Highest count
 * first; creates + reopens share max_new_per_run; refreshing an open row is free but only when it has new runs.
 */
export function deficiencyDecisions(tallies: Record<string, DeficiencyTally>, existing: Map<string, Record<string, unknown>> | null, now: number, policy: GoalDeficiencyPolicy): DeficiencyDecision {
  const d: DeficiencyDecision = { writes: [], skipped: [], unclassified: [], candidates: [] };
  const fromMs = now - policy.window_hours * 3_600_000;
  const nowIso = new Date(now).toISOString();
  const ranked: Array<{ t: DeficiencyTally; cls: string; failed: TallyEntry[] }> = [];
  for (const t of Object.values(tallies)) {
    const recent = sinceLastTrustedReach(t, policy).filter((e) => !e.reached && e.at >= fromMs);
    const un = recent.filter((e) => e.class === null);
    if (un.length > 0) d.unclassified.push({ goal_hash: t.goal_hash, count: un.length, samples: [...new Set(un.map((e) => e.reason).filter(Boolean))].slice(0, 3) });
    const byClass = new Map<string, TallyEntry[]>();
    for (const e of recent) if (e.class && e.class !== "abstain" && e.class !== "phantom") byClass.set(e.class, [...(byClass.get(e.class) ?? []), e]);
    for (const [cls, failed] of byClass) if (failed.length >= policy.min_runs) { ranked.push({ t, cls, failed }); d.candidates.push({ goal_hash: t.goal_hash, reason_class: cls, count: failed.length }); }
  }
  if (policy.file_gaps !== 1) { for (const c of ranked) d.skipped.push({ goal_hash: c.t.goal_hash, reason_class: c.cls, why: "file_gaps is 0 (tally and report only)" }); return d; }
  if (existing === null) { for (const c of ranked) d.skipped.push({ goal_hash: c.t.goal_hash, reason_class: c.cls, why: "store_unread" }); return d; }
  ranked.sort((a, b) => b.failed.length - a.failed.length);
  let budget = policy.max_new_per_run;
  for (const { t, cls, failed } of ranked) {
    const id = deficiencyGapId(t.goal_hash, cls);
    if (!HASH_TOKEN.test(t.goal_hash) || !CLASS_TOKEN.test(cls) || gapClassKey(id) !== id) { d.skipped.push({ goal_hash: t.goal_hash, reason_class: cls, why: `id ${id} is not canonical` }); continue; }
    const latest = failed[failed.length - 1]!;
    const demand = { source: "goal_reach" as const, goal_hash: t.goal_hash, dispatch_id: latest.dispatch_id, origin: t.origin };
    const row = deficiencyGapRow(t, cls, failed, policy.window_hours, nowIso);
    const prior = existing.get(id);
    if (!prior) {
      if (budget <= 0) { d.skipped.push({ goal_hash: t.goal_hash, reason_class: cls, why: "budget: max_new_per_run reached" }); continue; }
      budget--;
      d.writes.push({ kind: "create", id, goal_hash: t.goal_hash, reason_class: cls, count: failed.length, gap: row, demand });
      continue;
    }
    const status = String(prior["status"] ?? "open");
    if (status === "open") {
      const known = new Set(((prior["classification_metadata"] as Record<string, unknown> | undefined)?.["dispatch_ids"] as string[] | undefined) ?? []);
      if (failed.every((e) => known.has(e.dispatch_id))) continue;
      d.writes.push({ kind: "refresh", id, goal_hash: t.goal_hash, reason_class: cls, count: failed.length, gap: { ...row, detected_at: prior["detected_at"] ?? row["detected_at"] }, expect_status: "open", demand });
      continue;
    }
    if (status === "closed") {
      const closedAt = Date.parse(String(prior["closed_at"] ?? ""));
      if (!Number.isFinite(closedAt) || closedAt > now) { d.skipped.push({ goal_hash: t.goal_hash, reason_class: cls, why: "closed with no usable closed_at: no recurrence anchor" }); continue; }
      const after = failed.filter((e) => e.at > closedAt);
      if (after.length < policy.min_runs) continue;
      if (budget <= 0) { d.skipped.push({ goal_hash: t.goal_hash, reason_class: cls, why: "budget: max_new_per_run reached" }); continue; }
      budget--;
      d.writes.push({ kind: "reopen", id, goal_hash: t.goal_hash, reason_class: cls, count: after.length, gap: deficiencyGapRow(t, cls, after, policy.window_hours, nowIso), expect_status: "closed", demand });
      continue;
    }
    d.skipped.push({ goal_hash: t.goal_hash, reason_class: cls, why: status === "rejected" ? "rejected by an operator: never refiled" : `stored status ${status} is unknown here: left alone` });
  }
  return d;
}

// ── the read shape ──────────────────────────────────────────────────────────────────────────────────

/** The newest open goalDeficiencyPolicy record over the defaults (law 1). */
export async function readDeficiencyPolicy(): Promise<{ ok: true; policy: GoalDeficiencyPolicy } | { ok: false; why: string }> {
  try {
    const { resolvePoolImpulse } = await import("./pool-impulse.js");
    const row = resolvePoolImpulse({ type: "poolImpulse", shape: GOAL_DEFICIENCY_POLICY_SHAPE, status: "open", limit: 1 }).body.impulses[0];
    return parseDeficiencyPolicy(row?.body ?? null);
  } catch (e) { return { ok: false, why: `goalDeficiencyPolicy unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}` }; }
}
export async function readTally(goalHash: string): Promise<DeficiencyTally | null> {
  const { resolvePoolImpulse } = await import("./pool-impulse.js");
  const row = resolvePoolImpulse({ type: "poolImpulse", id: tallyId(goalHash), shape: GOAL_DEFICIENCY_TALLY_SHAPE, status: "open", limit: 1 }).body.impulses[0];
  const b = row?.body as DeficiencyTally | undefined;
  return b && typeof b.goal_hash === "string" && Array.isArray(b.entries) ? b : null;
}

/** `{type:"goal_reach_verdict", goal_hash}` → flat fields the gap check reads (zero_field unreached_since_last_reach). */
export async function resolveGoalReachVerdict(pointer: { goal_hash?: unknown }): Promise<{ shape: string; body: GoalReachVerdict }> {
  const goalHash = typeof pointer.goal_hash === "string" ? pointer.goal_hash.trim() : "";
  const pol = await readDeficiencyPolicy();
  if (!pol.ok) return { shape: "goalReachVerdict", body: { measured: false, goal_hash: goalHash, why: pol.why } };
  try {
    return { shape: "goalReachVerdict", body: goalReachVerdict(goalHash, HASH_TOKEN.test(goalHash) ? await readTally(goalHash) : null, pol.policy) };
  } catch (e) {
    return { shape: "goalReachVerdict", body: { measured: false, goal_hash: goalHash, why: `tally unreadable: ${String((e as Error)?.message ?? e).slice(0, 160)}` } };
  }
}
