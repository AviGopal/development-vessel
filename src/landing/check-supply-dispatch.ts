// Check-supply dispatch: the node a check-supply goal is placed on, the probe of a dispatched goal and the verdict on its outcome. Lifted as-is from gap-check-supply.ts.
import { type JudgedInputs } from "../resolvers/substrate-gap.js";
import { METABOB_API_KEY } from "../config.js";

export const CHECK_SUPPLY_FAMILY = "gap-check-supply";

export type Row = Record<string, unknown>;
export type Ledger = {
  state?: string;
  attempts?: number;
  last_dispatch_at?: string;
  /** The check file, set only once it is read at origin/dev (the arm step). Rows written before that rule may carry the
   *  name from the send. */
  test_file?: string;
  /** The check file the test-writing goal was told to write, set at send: a name, not a file that exists. */
  intended_test_file?: string;
  vessel?: string;
  dispatch_id?: string | null;
  goal?: string;
  armed_at?: string;
  red_at_head?: boolean;
  last_verdict?: string;
  reason?: string;
  mode?: string;
  baseline_titles?: string[];
  edit_site?: string | null;
  /** The node that sent the goal (its bootstrap identity) and its goal-host: the only place its outcome can be read. */
  dispatch_node?: string;
  dispatch_host?: string;
  /** Set when THIS node placed the goal on a peer with a free compose slot (compose-placement.ts): the sender, and why. */
  placed_by?: string;
  placement?: string;
  /** The node whose tick wrote the arm (its bootstrap identity), and, for a check handed to the gap-store holder for its
   *  birth verdict, the node that handed it off: stamped by the hand-off write, carried to the arm. */
  armed_by_node?: string;
  handed_off_from?: string;
  /** The arm's own entry, copied when it was written: a later hand-off rewrites handed_off_from above, never this. */
  arm?: { armed_at: string; armed_by_node: string; handed_off_from?: string };
  /** Every arm's entry, oldest first, the last ARM_HISTORY_MAX: a re-arm (another node, or the same one again) adds one
   *  and never overwrites an earlier arm's attribution. `arm` above is the latest of them. */
  arms?: Array<{ armed_at: string; armed_by_node: string; handed_off_from?: string }>;
  /** The outcome read back for the last dispatch (status, reached, why it was lost, where and when it was read). */
  outcome?: Row;
  /** The settled attempts before the current one (state, reason, outcome), newest last, at most five. */
  history?: Row[];
  /** A NON-ATTEMPT (state non_attempt / send_refused) is not sent again before this instant (CHANGE-30). */
  not_before?: string;
  /** CONSECUTIVE non-attempts/refusals since the last SETTLED outcome (failed, lost, armed): each one doubles the
   *  wait up to the shaped cap, so a receiver that never takes the gap cannot be sent it without bound. */
  non_attempt_streak?: number;
  /** The new titles the arm step judged on the last attempt (kept so the next attempt can be told which check did not reproduce). */
  judged_titles?: string[];
  /** What else that judgement read (judgedInputsOf): a settled row whose inputs differ from these is judged again. */
  judged_inputs?: JudgedInputs;
  /** Set on an armed record when the missing-export guard could not run (typescript unavailable): it decided nothing. */
  guard_decided_nothing?: string;
  /** The edit-site mutation gate's reading at arm time (EDIT-SITE MUTATION GATE): mutants run, how many changed the red. */
  mutation_gate?: Row;
};
// A CHECK THAT WAS JUDGED AND NOT ARMED IS A SETTLED ATTEMPT TOO. Only failed and lost dispatches were kept, so a check
// that landed green at HEAD (or red for the wrong reason) left no trace and the next attempt was sent the same goal text.
export const JUDGED_NOT_ARMED: ReadonlySet<string> = new Set(["green_at_head", "arm_refused", "existence_only"]);
export const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

// ─── the dispatch's outcome, read back ──────────────────────────────────────

export const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
/** This node's identity in a ledger (bootstrap identity, the same one the lane's pick line names as owner). */
export const checkSupplyNode = (): string => process.env["SUBSTRATE_NAME"] ?? "substrate";
export const RUNNING_STATUSES: ReadonlySet<string> = new Set(["running", "pending", "accepted", "queued", "dispatched", "in_progress", "started"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "error", "errored", "cancelled", "canceled", "timeout", "timed_out", "aborted", "refused"]);

/** What a node's goal-host said about one dispatch: an HTTP answer, or unreachable. null = not probed (another node's). */
export type DispatchProbe = { http: number; status?: unknown; reached?: unknown; reach_reason?: unknown; outcome?: unknown } | { http: "unreachable"; error: string };
export type LostWhy = "not_found_on_host" | "host_unreachable" | "no_dispatch_id" | "unrecognised_status" | "owning_node_never_settled" | "timed_out";
export type DispatchVerdict =
  | { kind: "running" }
  | { kind: "awaiting_titles" }
  | { kind: "failed"; reason: string }
  | { kind: "non_attempt"; reason: string; retry_after_s?: number }
  | { kind: "refused"; reason: string; retry_after_s?: number }
  | { kind: "lost"; why: LostWhy; reason: string }
  | { kind: "wait"; why: LostWhy; detail: string };
export interface OutcomeBounds { stale_ms: number; timeout_ms: number; title_grace_ms: number; foreign_stale_ms: number }
/** The outcome bounds a family's rhythm body sets (this family's defaults where it sets none). Also read by the drain
 *  observer, which bounds a goal-host remedy's "running" dispatch by the same dispatch_timeout_hours. */
export function outcomeBoundsOf(body: Record<string, unknown>): OutcomeBounds {
  return {
    stale_ms: posNum(body["dispatch_stale_hours"], 24) * 3600_000,
    timeout_ms: posNum(body["dispatch_timeout_hours"], 6) * 3600_000,
    title_grace_ms: posNum(body["title_grace_hours"], 2) * 3600_000,
    foreign_stale_ms: posNum(body["foreign_stale_hours"], 72) * 3600_000,
  };
}

/**
 * THE ONE CLASSIFICATION OF A NON-SUCCESS THAT IS NOT A FAILED ATTEMPT (CHANGE-30), read from the receiver's
 * STRUCTURED `outcome` (goal-host: GET /executions/:id and the /run-goal 429 body), never from goalReachReason prose:
 *   non_attempt: the receiver will take it later (compose capacity, a landing that deferred with its park kept);
 *   refused:     the receiver declined it (the spend-rate breaker), with its own retry_after_s when it said one.
 * Neither is charged as an attempt; each waits its own shaped delay. Anything else is null (today's semantics).
 */
export function outcomeKindOf(o: unknown): { kind: "non_attempt" | "refused"; retry_after_s?: number; refuse_class?: string; failure_kind?: string } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Row;
  const kind = r["kind"];
  if (kind !== "non_attempt" && kind !== "refused") return null;
  const ra = r["retry_after_s"];
  return {
    kind,
    ...(typeof ra === "number" && Number.isFinite(ra) && ra > 0 ? { retry_after_s: ra } : {}),
    ...(typeof r["refuse_class"] === "string" ? { refuse_class: r["refuse_class"] as string } : {}),
    ...(typeof r["failure_kind"] === "string" ? { failure_kind: r["failure_kind"] as string } : {}),
  };
}

/**
 * The verdict on one in-flight dispatch. Pure. An outcome that cannot be read is never "failed": it waits (and is
 * reported) until the staleness bound, then is lost with the reason it could not be read.
 */
/**
 * THE TEST-WRITING STAGE SURVIVES THE CUT. goal-host's reach_reason for a refused check_supply compose opens with ~110
 * characters of routing prefix ("early edit-intent routed to feature_compose; check_supply compose refused at …"), and
 * the test-writing judgement that refused the check (`test_writing=<stage>: <reason>`) comes after the verify text. Cut
 * at 240 characters from the start, the stage was lost, so the ledger recorded a generic failed dispatch. When the text
 * names a test-writing stage, it is kept from the stage on (the stage and its reason, then the cut); otherwise as before.
 */
export const TEST_WRITING_STAGE_RE = /\b(test_writing_[a-z_]+|check_references_missing_export|edit_site_not_importable)\b/;
export function reachReasonText(reachReason: string): string {
  const text = reachReason.replace(/\s+/g, " ").trim();
  const m = TEST_WRITING_STAGE_RE.exec(text);
  return (m && m.index > 0 ? text.slice(m.index) : text).slice(0, 240);
}

export function dispatchVerdict(ledger: Ledger, probe: DispatchProbe | null, nowMs: number, bounds: OutcomeBounds, localNode: string): DispatchVerdict {
  const sent = Date.parse(String(ledger.last_dispatch_at ?? ""));
  const age = Number.isFinite(sent) ? nowMs - sent : Number.POSITIVE_INFINITY;
  const hours = (ms: number): string => `${Math.round(ms / 3_600_000)} h`;
  const lostOr = (why: LostWhy, detail: string, bound = bounds.stale_ms): DispatchVerdict =>
    age > bound ? { kind: "lost", why, reason: `${why}: ${detail}; unsettled ${hours(age)} (bound ${hours(bound)})` } : { kind: "wait", why, detail };
  const owner = nonEmpty(ledger.dispatch_node) ? String(ledger.dispatch_node) : null;
  // A RECORD WITH NO DISPATCH ID IS NEVER SETTLED AS LOST: its outcome is recovered from its own shape, by the node that
  // wrote it. The writer records goal_dispatched only with the id the goal-host returned (the sent record, or its
  // id-only fallback); the one record it writes before the send (send_pending; before that, a goal_dispatched with no
  // id and no goal text) carries neither. So such a record is a send never confirmed: a non-attempt, not charged,
  // asked again after its shaped wait (a check that lands anyway still arms the row: the ARM step reads non_attempt
  // rows). One that carries the goal text was sent and the goal-host answered no id: a failed send, said so.
  if (!nonEmpty(ledger.dispatch_id)) {
    if (owner !== null && owner !== localNode) return { kind: "wait", why: "owning_node_never_settled", detail: `recorded with no dispatch id by ${owner}; only ${owner} recovers its send` };
    if (nonEmpty(ledger.goal)) return { kind: "failed", reason: "send_without_id: the goal was sent and the goal-host answered no dispatch id, so its outcome cannot be read" };
    return { kind: "non_attempt", reason: "send_unconfirmed: the record carries no dispatch id and no goal text, the shape only the pre-send record has, so no send of it was confirmed; not charged" };
  }
  // A goal this node PLACED on a peer is read through that peer (probe given): it falls through to the reading below.
  // Unread (probe null), its compose (ceiling 15 min) is long over by the dispatch timeout, so it settles by that
  // shaped bound, not by the foreign one meant for another sender's dispatch.
  const placedRead = owner !== null && owner !== localNode && ledger.placed_by === localNode && probe !== null;
  if (owner !== null && owner !== localNode && !placedRead) return ledger.placed_by === localNode
    ? lostOr("owning_node_never_settled", `placed on ${owner} by this node; only ${owner}'s goal-host can read the outcome`, bounds.timeout_ms)
    : lostOr("owning_node_never_settled", `dispatched by ${owner}; only its goal-host can read the outcome`, bounds.foreign_stale_ms);
  const where = owner === null ? `this node's goal-host (the dispatching node was not recorded)` : `${owner}'s goal-host`;
  if (probe === null || probe.http === "unreachable") return lostOr("host_unreachable", `${where} did not answer${probe && probe.http === "unreachable" ? ` (${probe.error.slice(0, 120)})` : ""}`);
  if (probe.http === 404) return lostOr("not_found_on_host", `${where} has no record of dispatch ${ledger.dispatch_id} (pruned, or sent from another node)`);
  if (probe.http !== 200) return lostOr("host_unreachable", `${where} answered HTTP ${probe.http}`);
  const status = String(probe.status ?? "").toLowerCase();
  if (RUNNING_STATUSES.has(status)) return age > bounds.timeout_ms ? { kind: "lost", why: "timed_out", reason: `timed_out: still ${status} ${hours(age)} after dispatch (bound ${hours(bounds.timeout_ms)})` } : { kind: "running" };
  if (TERMINAL_STATUSES.has(status)) {
    const why = typeof probe.reach_reason === "string" && probe.reach_reason.trim() ? `: ${reachReasonText(probe.reach_reason)}` : "";
    if (probe.reached === true) {
      return age > bounds.title_grace_ms
        ? { kind: "failed", reason: `the goal ended ${status} and reached, but no new test title appeared in ${ledger.test_file ?? "the check file"} within ${hours(bounds.title_grace_ms)}` }
        : { kind: "awaiting_titles" };
    }
    const named = outcomeKindOf((probe as { outcome?: unknown }).outcome);
    if (named) return { kind: named.kind, reason: `the goal ended ${status}, not reached, as a ${named.kind === "refused" ? "refusal" : "non-attempt"}${named.refuse_class ? ` (${named.refuse_class})` : ""}${why}`, ...(named.retry_after_s ? { retry_after_s: named.retry_after_s } : {}) };
    return { kind: "failed", reason: `the goal ended ${status}, not reached${why}` };
  }
  return lostOr("unrecognised_status", `${where} reported status ${JSON.stringify(String(probe.status ?? "")).slice(0, 60)}, which this code does not know`);
}

/** Read one dispatch from this node's goal-host. Also the drain observer's outcome reader for a goal-host remedy. */
export async function probeDispatch(dispatchId: string): Promise<DispatchProbe> {
  try {
    const r = await fetch(`${GOAL_HOST_ENDPOINT}/executions/${encodeURIComponent(dispatchId)}`, { headers: METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (r.status !== 200) return { http: r.status };
    const j = (await r.json().catch(() => ({}))) as Row;
    return { http: 200, status: j["status"], reached: j["reached"], reach_reason: j["goalReachReason"], outcome: j["outcome"] };
  } catch (err) {
    return { http: "unreachable", error: String((err as Error)?.message ?? err) };
  }
}

export const posNum = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
