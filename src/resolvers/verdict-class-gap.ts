/**
 * One gap per deterministic verdict CLASS, never one per instance (slice Y, step Y2a).
 *
 * "Wrongness is a goal seed": hundreds of deterministic not-reached verdicts became zero gaps,
 * because nothing keyed them by class. goal-host's missing-verifier generator
 * (missing-verifier-gap.ts) already keys by FAMILY with a stable id, but only for its regex
 * families, and its dedup is an in-process Set that a restart forgets. This is that generator
 * re-keyed by verdict class, as a PURE builder: the caller (the detector-coverage tick, Y2c)
 * supplies per-class counts read from traceAggregateReport over `execution` plus the existing
 * class rows, and this decides what to write. It writes nothing itself.
 *
 * Flood guards (each one fails closed):
 *  - ONE ROW PER CLASS: the id is `verdict-class-<token>`, upserted by the gap store
 *    (substrateGap_write matches an exact id first), so dedup lives in the store, not in memory.
 *    A token must be canonical and must survive the store's volatile-token stripping unchanged
 *    (gapClassKey), so two classes can never collapse onto one row, nor one class spread over two.
 *  - ONLY `deterministic:<token>` classes: transport / structural / judged classes have other owners.
 *  - REACHED-SIDE tokens excluded by the policy's globs (the floor records passes such as
 *    `code-investigation-cited` as a failure reason).
 *  - FLOORS: distinct goals >= min_distinct_goals is checked FIRST (one goal repeating is one
 *    problem, not a class), then records >= min_count. An unknown goal count is 0.
 *  - BUDGET: at most max_new_per_run NEW ids plus REOPENS per call, highest count first.
 *    Refreshing an open row is free (it writes the same row).
 *  - AN UNREAD STORE FILES NOTHING: `existing: null` means the store was not read, and every
 *    class is skipped (`store_unread`); `[]` means it was read and is empty.
 *  - COUNTS COME FROM NOT-REACHED ROWS ONLY (see ClassCount); reached-side tokens are also
 *    excluded by the policy's globs as a belt.
 *  - NO SILENT REOPEN: writing `open` over a closed row is a reopen (substrate-gap.ts reopen
 *    accounting), so a closed class is written open only when its count SINCE closed_at clears
 *    both floors. A closed row with no parseable (or a future) closed_at has no recurrence anchor and is left
 *    alone; a rejected row is an operator disposition and is never refiled; a row whose status is
 *    anything else is unknown and is left alone.
 *  - An invalid policy files nothing.
 *
 * Honesty: no `edit_site` is fabricated. The verdict's emitting literal (grep-located by the
 * caller) is carried as `verdict_site`, a pointer for localization, not a claim about the fix
 * site. The falsifier is class2: a READ shape the dev-vessel serves (trace_failure_pattern_report,
 * windowed) whose zero_field counts the DEFECT (rows over the tolerated rate), so 0 means fixed.
 */
import { gapClassKey } from "./substrate-gap.js";
import { VERDICT_CLASS_PREFIX, verdictTokenOfClass } from "../lib/verdict-token.js";
import { hoursSince, knownCount, readShapedPolicy, validatePolicy, type PolicySpec, type ShapedPolicy } from "../lib/signal-window.js";

export interface VerdictClassPolicy {
  /** Records of the class in the window, at least. */
  min_count: number;
  /** Distinct goals that drew the class in the window, at least. Checked first. */
  min_distinct_goals: number;
  /** NEW class gaps one call may file. 0 turns the filer off. */
  max_new_per_run: number;
  /** The window the counts were read over, and the falsifier's window. */
  window_hours: number;
  /** The tolerated rate: the falsifier's defect count is records above this per window. */
  max_rate_count: number;
  /** Token globs (`*` wildcard) that are never filed: reached-side verdicts. */
  exclude_tokens: string[];
}

/** The shaped policy's name: `<live super-repo clone>/policies/verdictClassPolicy.json`. */
export const VERDICT_CLASS_POLICY_NAME = "verdictClassPolicy";

export const DEFAULT_VERDICT_CLASS_POLICY: Readonly<VerdictClassPolicy> = Object.freeze({
  min_count: 20,
  min_distinct_goals: 3,
  max_new_per_run: 3,
  window_hours: 168,
  max_rate_count: 5,
  // Reached-side tokens: the floor records passes (code-investigation-cited, transform-verified,
  // independent-recompute-agrees) as failure reasons, and goal-host emits edit-intent-landed,
  // early-edit-intent-landed, grounded-report, true, favorable-compose, escalation-landed and
  // interrupted-landed on the REACHED side today. Belt to the
  // reached=false contract below: a pass mis-recorded as a failure still never files.
  // Named one by one, never `*-landed`: that glob would also hide staged-not-landed.
  exclude_tokens: [
    "verified-*", "*-cited", "*-agrees", "*-verified",
    "edit-intent-landed", "early-edit-intent-landed", "grounded-report", "true",
    "favorable-compose", "escalation-landed", "interrupted-landed",
  ],
});

export const VERDICT_CLASS_POLICY_SPEC: PolicySpec<VerdictClassPolicy> = {
  min_count: { kind: "int", min: 1, max: 1_000_000 },
  min_distinct_goals: { kind: "int", min: 1, max: 100_000 },
  max_new_per_run: { kind: "int", min: 0, max: 20 },
  window_hours: { kind: "int", min: 1, max: 720 },
  max_rate_count: { kind: "int", min: 0, max: 1_000_000 },
  exclude_tokens: { kind: "globs", max_items: 64 },
};

/** Reads verdictClassPolicy at use time. `ok: false` → the caller files nothing. */
export function readVerdictClassPolicy(env: Record<string, string | undefined> = process.env): Promise<ShapedPolicy<VerdictClassPolicy>> {
  return readShapedPolicy(VERDICT_CLASS_POLICY_NAME, { ...DEFAULT_VERDICT_CLASS_POLICY, exclude_tokens: [...DEFAULT_VERDICT_CLASS_POLICY.exclude_tokens] }, VERDICT_CLASS_POLICY_SPEC, env);
}

/**
 * Per-class counts. CONTRACT: counted over NOT-REACHED rows only (reached=false: the late verdict's
 * metadata.verdict_class, or a failed row's failure_mode.class). A count that includes reached rows
 * would file a gap against passes; the exclude list is the belt, not the mechanism.
 */
export interface ClassCount {
  /** `deterministic:<token>` for a fileable class; anything else is skipped. */
  class: string;
  count: number;
  distinct_goals: number | null;
  /** For a CLOSED class row: the same counts over the window since its closed_at. */
  since_close_count?: number;
  since_close_distinct_goals?: number;
}

export interface ExistingClassGap {
  id: string;
  status?: string;
  closed_at?: string;
  classification_metadata?: Record<string, unknown>;
}

export type VerdictClassSkip =
  | "not_deterministic" | "malformed_token" | "excluded_token" | "duplicate_class" | "unmeasured_count"
  | "rejected_disposition" | "existing_status_unknown" | "closed_no_anchor" | "closed_no_recurrence"
  | "below_distinct_goals" | "below_count" | "rate_limited" | "policy_invalid" | "store_unread";

export interface VerdictClassGap {
  id: string;
  category: "verdict_class";
  source: "substrate_detected";
  status: "open";
  summary: string;
  classification_metadata: {
    detector: "verdict_class_scan";
    verdict_class: string;
    occurrence_count: number;
    distinct_goals: number;
    window_hours: number;
    falsifier: "class2";
    evidence_resolve: {
      shape: "trace_failure_pattern_report";
      input: { failure_class: string; window_hours: number; max_count: number };
      zero_field: "excess_failures";
    };
    reopen_basis?: { since_closed_at: string; since_close_count: number; since_close_distinct_goals: number };
    verdict_site?: string;
  };
}

export interface VerdictClassResult {
  gaps: VerdictClassGap[];
  skipped: Array<{ class: string; reason: VerdictClassSkip; detail?: string }>;
}

export const VERDICT_CLASS_ID_PREFIX = "verdict-class-";

function globRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

function closedAtOf(row: ExistingClassGap): string | null {
  const meta = row.classification_metadata;
  const at = typeof row.closed_at === "string" ? row.closed_at : typeof meta?.["closed_at"] === "string" ? (meta["closed_at"] as string) : null;
  // A future (or unparseable) closed_at anchors no recurrence window.
  return at && hoursSince(at) !== null ? at : null;
}

/**
 * The window the caller must read a CLOSED row's since-close counts over (hours since its
 * closed_at, capped at the store horizon). Null when the row has no usable anchor: then there is
 * no recurrence to measure, and the builder leaves the row closed.
 */
export function recurrenceWindowHours(row: ExistingClassGap, now: number = Date.now()): number | null {
  const at = closedAtOf(row);
  return at ? hoursSince(at, now) : null;
}

/** The gap id for a class, or null when the class is not a canonical deterministic token. */
export function verdictClassGapId(cls: string): string | null {
  // The shared verdict-token rule (vendored byte-identical in activity-api, which stamps the
  // class) already refuses what the store's gapClassKey would rewrite; checking the store's own
  // key too keeps a future gapClassKey change from collapsing two classes onto one row.
  const token = verdictTokenOfClass(cls);
  if (!token) return null;
  const id = `${VERDICT_CLASS_ID_PREFIX}${token}`;
  return gapClassKey(id) === id ? id : null;
}

/** Pure: decides which class gaps to write. See the header for every guard. */
export function verdictClassGaps(
  counts: ReadonlyArray<ClassCount>,
  /** The store's class rows; null when the store could not be read. */
  existing: ReadonlyArray<ExistingClassGap> | null,
  policy: VerdictClassPolicy,
  opts: { verdictSites?: Record<string, string> } = {},
): VerdictClassResult {
  const gaps: VerdictClassGap[] = [];
  const skipped: VerdictClassResult["skipped"] = [];
  const valid = validatePolicy(policy, DEFAULT_VERDICT_CLASS_POLICY as VerdictClassPolicy, VERDICT_CLASS_POLICY_SPEC);
  if (!valid.ok) {
    for (const c of counts) skipped.push({ class: String(c?.class), reason: "policy_invalid", detail: valid.why });
    return { gaps, skipped };
  }
  // An unread store files NOTHING: an open write over a closed row this call never saw is a
  // silent reopen (the store upserts by id), and `[]` would read every class as new.
  if (!Array.isArray(existing)) {
    for (const c of counts) skipped.push({ class: String(c?.class), reason: "store_unread" });
    return { gaps, skipped };
  }
  const p = valid.policy;
  const excluded = p.exclude_tokens.map(globRe);
  const byId = new Map<string, ExistingClassGap>();
  for (const e of existing) if (e && typeof e.id === "string" && !byId.has(e.id)) byId.set(e.id, e);

  const seen = new Set<string>();
  let fresh = 0;
  const ordered = [...counts].sort((a, b) => (knownCount(b?.count) ?? -1) - (knownCount(a?.count) ?? -1));
  for (const c of ordered) {
    const cls = String(c?.class ?? "");
    if (!cls.startsWith(VERDICT_CLASS_PREFIX)) { skipped.push({ class: cls, reason: "not_deterministic" }); continue; }
    const id = verdictClassGapId(cls);
    if (!id) { skipped.push({ class: cls, reason: "malformed_token" }); continue; }
    const token = id.slice(VERDICT_CLASS_ID_PREFIX.length);
    if (excluded.some((re) => re.test(token))) { skipped.push({ class: cls, reason: "excluded_token" }); continue; }
    if (seen.has(id)) { skipped.push({ class: cls, reason: "duplicate_class" }); continue; }
    seen.add(id);

    const total = knownCount(c.count);
    if (total === null) { skipped.push({ class: cls, reason: "unmeasured_count" }); continue; }
    const totalGoals = knownCount(c.distinct_goals) ?? 0;

    const prior = byId.get(id);
    let n = total;
    let goals = totalGoals;
    let reopen: VerdictClassGap["classification_metadata"]["reopen_basis"];
    if (prior) {
      const status = prior.status;
      if (status === "rejected") { skipped.push({ class: cls, reason: "rejected_disposition" }); continue; }
      if (status === "closed") {
        const at = closedAtOf(prior);
        if (!at) { skipped.push({ class: cls, reason: "closed_no_anchor" }); continue; }
        n = knownCount(c.since_close_count) ?? 0;
        goals = knownCount(c.since_close_distinct_goals) ?? 0;
        if (n < p.min_count || goals < p.min_distinct_goals) { skipped.push({ class: cls, reason: "closed_no_recurrence" }); continue; }
        reopen = { since_closed_at: at, since_close_count: n, since_close_distinct_goals: goals };
      } else if (status !== "open") {
        skipped.push({ class: cls, reason: "existing_status_unknown", detail: String(status) }); continue;
      }
    }
    if (goals < p.min_distinct_goals) { skipped.push({ class: cls, reason: "below_distinct_goals" }); continue; }
    if (n < p.min_count) { skipped.push({ class: cls, reason: "below_count" }); continue; }
    // NEW ids and REOPENS share the per-run budget: both change what the open backlog holds.
    if (!prior || reopen) {
      if (fresh >= p.max_new_per_run) { skipped.push({ class: cls, reason: "rate_limited" }); continue; }
      fresh++;
    }

    const site = opts.verdictSites?.[cls];
    gaps.push({
      id,
      category: "verdict_class",
      source: "substrate_detected",
      status: "open",
      summary:
        `The deterministic verdict class "${token}" graded ${total} dispatches not-reached across ${totalGoals} distinct goals in ${p.window_hours}h` +
        (reopen ? ` (${reopen.since_close_count} across ${reopen.since_close_distinct_goals} goals since this class gap closed at ${reopen.since_closed_at})` : "") +
        `. One repair for the class, not one per goal: find the shared cause and fix the path that produces it, so this class falls to at most ${p.max_rate_count} per ${p.window_hours}h.`,
      classification_metadata: {
        detector: "verdict_class_scan",
        verdict_class: cls,
        occurrence_count: total,
        distinct_goals: totalGoals,
        window_hours: p.window_hours,
        falsifier: "class2",
        evidence_resolve: {
          shape: "trace_failure_pattern_report",
          input: { failure_class: cls, window_hours: p.window_hours, max_count: p.max_rate_count },
          zero_field: "excess_failures",
        },
        ...(reopen ? { reopen_basis: reopen } : {}),
        ...(typeof site === "string" && site.trim() ? { verdict_site: site.trim() } : {}),
      },
    });
  }
  return { gaps, skipped };
}
