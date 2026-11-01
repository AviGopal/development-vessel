/**
 * OWN-CHECK BASELINE CREDIT: the CONTENT grade of an own-check baseline (own-check-baseline.ts).
 *
 * A baseline run is graded twice, for two different things:
 *   - its EXECUTION grade is the walk-end reach goal-host delivers like any run's (a valid reading produced; unrunnable
 *     or a crash does not reach). It says the measurement happened, not that it was right;
 *   - its CONTENT grade is AGREEMENT: a consumer used the reading and later evidence agrees or disagrees with it. That
 *     is posted here as ONE consumer trace in the gap-outcome credit's shape (substrate-gap.ts gapOutcomeTrace /
 *     postConsumerTrace): one deterministic task, the baseline's execution as the only composition_chain ancestor and
 *     the consumed producer, reached = the agreement. activity-api's chain credit (propagateCreditAlongChain, declared
 *     data flow) then puts that outcome on the baseline template's posteriors. An UNCONSUMED reading is never posted.
 *
 * Decision sites (each calls creditOwnCheckBaseline with its verdict):
 *   - the compose's own-check decision (feature-compose runVerify), for a red_code_reachable reading the compose used:
 *     agree when the draft passes, or fails by assertion with a CHANGED failing set; disagree when the draft's red is a
 *     refused connection or a timeout (the environment surfaced); a broken or no-effect draft says nothing (no post);
 *   - the re-measure (classify at a new base sha), for a red_environmental reading admission consumed: the new reading
 *     environmental of the same signal class agrees, green_at_parent or red_code_reachable disagrees.
 * Not graded here (debt): a close after a consumed environmental or green reading. The gap store's settle path is in the
 * evaluator's closed import set, which may not reach this lane-editable module.
 * Once per (baseline execution, consumer): the paid keys are kept on the row (own_check_baseline_credit_paid) and in
 * process memory. The baseline's execution id is read from goal-host's dispatch record (GET /executions/:dispatchId,
 * executionId) by the dispatch id the supply tick recorded, and kept on the row once read.
 */
import type { CheckRunVerdict } from "./retry-evidence.js";
import type { OwnCheckBaseline } from "./own-check-baseline.js";
import { postConsumerTrace, resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";

type Row = Record<string, unknown>;
export const OWN_CHECK_BASELINE_CREDIT_ACTIVITY = "development-vessel:own-check-baseline-credit";
export const OWN_CHECK_BASELINE_CREDIT_PAID_FIELD = "own_check_baseline_credit_paid";
export type BaselineConsumer = "compose" | "remeasure";
/** One recorded own-check-baseline dispatch (the supply tick's own_check_baseline_dispatches entries). */
export type BaselineDispatch = { base_sha: string; dispatch_id: string; execution_id?: string; at?: string; node?: string };

// ── the agreement verdicts (pure) ──────────────────────────────────────────────────────────────────────────────────
/** A red_code_reachable reading against the compose's draft run of the check: true agree, false disagree, null none. */
export function codeReachableAgreement(b: Pick<OwnCheckBaseline, "verdict" | "failing">, draft: CheckRunVerdict, noEffectVsParent?: boolean): boolean | null {
  if (b.verdict !== "red_code_reachable" || noEffectVsParent === true) return null;
  if (draft.verdict === "not_red") return true;
  if (draft.verdict === "assertion_red") {
    const before = [...new Set((b.failing ?? []).map((f) => f.name))].sort();
    const after = [...new Set(draft.red)].sort();
    return JSON.stringify(before) !== JSON.stringify(after) ? true : null;
  }
  return draft.cause === "network" || draft.cause === "timeout" ? false : null;
}

const envClass = (s: readonly string[]): string => (s.includes("S_precondition") ? "precondition" : "empty_live_result");
/** A consumed red_environmental reading against its successor at a new base sha: true agree, false disagree, null none. */
export function remeasureAgreement(prev: Pick<OwnCheckBaseline, "verdict" | "env_signals">, next: Pick<OwnCheckBaseline, "verdict" | "env_signals">): boolean | null {
  if (prev.verdict !== "red_environmental") return null;
  if (next.verdict === "red_environmental") return envClass(prev.env_signals ?? []) === envClass(next.env_signals ?? []) ? true : null;
  if (next.verdict === "green_at_parent" || next.verdict === "red_code_reachable") return false;
  return null;
}

/** Whether a reading was used by admission (its exclusion stamps `consumed`). */
export function consumedByAdmission(b: unknown): boolean {
  return !!b && typeof b === "object" && !!(b as { consumed?: { by?: unknown } }).consumed && (b as { consumed: { by?: unknown } }).consumed.by === "admission";
}

// ── the consumer trace ─────────────────────────────────────────────────────────────────────────────────────────────
export function baselineCreditTrace(i: { baseline_execution_id: string; gap_id: string; base_sha: string; consumer: BaselineConsumer; reached: boolean; reason: string; nowIso: string }): Row {
  const impulse = `own_check_baseline:${i.gap_id}@${i.base_sha.slice(0, 12)}`;
  return {
    execution_id: `ocb-credit-${i.gap_id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}-${i.consumer}-${Date.parse(i.nowIso) || Date.now()}`,
    template_id: OWN_CHECK_BASELINE_CREDIT_ACTIVITY,
    activity_id: OWN_CHECK_BASELINE_CREDIT_ACTIVITY,
    activity_variant_id: OWN_CHECK_BASELINE_CREDIT_ACTIVITY,
    status: i.reached ? "completed" : "failed",
    success: i.reached,
    ...(i.reached ? {} : { failure_mode: { type: "verifier_negative", reason: `the own-check baseline's reading was contradicted (${i.consumer}): ${i.reason}` } }),
    started_at: i.nowIso,
    duration_ms: 0,
    composition_chain: [i.baseline_execution_id],
    tasks: [{
      id: "judge-baseline",
      resolver_id: "own_check_baseline_classify",
      resolver_tier: "deterministic",
      success: i.reached,
      input_impulse_ids: [impulse],
      output_impulse_ids: [],
      consumed_provenance: [{ impulse_id: impulse, producer_execution_id: i.baseline_execution_id, origin: "ancestor" }],
    }],
    tags: [i.reached ? "reached:true" : "reached:false", `own_check_baseline_consumer:${i.consumer}`],
    metadata: { gap_id: i.gap_id, base_sha: i.base_sha, consumer: i.consumer, agreement: i.reason, producer_execution_id: i.baseline_execution_id },
  };
}

// ── the baseline's execution id ────────────────────────────────────────────────────────────────────────────────────
const GOAL_HOST_ENDPOINT = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";
/** goal-host's dispatch record's executionId (GET /executions/:dispatchId), or null when it has none or none is read. */
export async function dispatchExecutionId(dispatchId: string): Promise<string | null> {
  try {
    const r = await fetch(`${GOAL_HOST_ENDPOINT}/executions/${encodeURIComponent(dispatchId)}`, { headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* swallow */ } return null; }
    const j = (await r.json().catch(() => ({}))) as { executionId?: unknown };
    return typeof j.executionId === "string" && j.executionId.length > 0 ? j.executionId : null;
  } catch {
    return null;
  }
}
/** The recorded dispatch of the reading at `base_sha` on a row. */
export function baselineDispatchAt(meta: Row, base_sha: string): BaselineDispatch | null {
  const list = Array.isArray(meta["own_check_baseline_dispatches"]) ? (meta["own_check_baseline_dispatches"] as BaselineDispatch[]) : [];
  return [...list].reverse().find((d) => d && d.base_sha === base_sha && typeof d.dispatch_id === "string") ?? null;
}

// ── the post, once ─────────────────────────────────────────────────────────────────────────────────────────────────
export type CreditDeps = {
  post?: (trace: Row) => Promise<number | null>;
  executionIdOf?: (dispatchId: string) => Promise<string | null>;
  markPaid?: (gapId: string, keys: string[]) => Promise<void>;
  nowIso?: string;
};
const paidHere = new Set<string>();
/** Tests only. */
export function __resetBaselineCreditForTests(): void { paidHere.clear(); }

async function markPaidOnRow(gapId: string, keys: string[]): Promise<void> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id: gapId, limit: 1 } as never);
  const row = (((r?.body ?? {}) as { gaps?: Row[] }).gaps ?? [])[0];
  if (!row) return;
  await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id: gapId, category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: { [OWN_CHECK_BASELINE_CREDIT_PAID_FIELD]: keys } } } as never);
}

/**
 * Post the content grade of `baseline` (as read on the row `meta`) for `consumer`, once. `reached` null posts nothing.
 * Never throws. Returns what happened, for the caller's log and tests.
 */
export async function creditOwnCheckBaseline(
  i: { gap_id: string; meta: Row; baseline: Pick<OwnCheckBaseline, "base_sha" | "dispatch_id" | "verdict">; consumer: BaselineConsumer; reached: boolean | null; reason: string },
  deps: CreditDeps = {},
): Promise<{ posted: boolean; why: string }> {
  try {
    if (i.reached === null) return { posted: false, why: "no agreement verdict (ungraded)" };
    const disp = baselineDispatchAt(i.meta, i.baseline.base_sha);
    const dispatchId = disp?.dispatch_id ?? i.baseline.dispatch_id ?? null;
    const exec = disp?.execution_id ?? (dispatchId ? await (deps.executionIdOf ?? dispatchExecutionId)(dispatchId) : null);
    if (!exec) return { posted: false, why: `the baseline's execution id is unknown (dispatch ${dispatchId ?? "none"})` };
    const key = `${exec}:${i.consumer}`;
    const paid = Array.isArray(i.meta[OWN_CHECK_BASELINE_CREDIT_PAID_FIELD]) ? (i.meta[OWN_CHECK_BASELINE_CREDIT_PAID_FIELD] as unknown[]).map(String) : [];
    if (paidHere.has(key) || paid.includes(key)) return { posted: false, why: `already paid (${key})` };
    paidHere.add(key);
    const trace = baselineCreditTrace({ baseline_execution_id: exec, gap_id: i.gap_id, base_sha: i.baseline.base_sha, consumer: i.consumer, reached: i.reached, reason: i.reason, nowIso: deps.nowIso ?? new Date().toISOString() });
    const status = await (deps.post ?? ((t: Row) => postConsumerTrace(t, "own-check-baseline-credit")))(trace);
    console.log(`[own-check-baseline-credit] ${i.gap_id}: ${i.consumer} ${i.reached ? "agrees" : "disagrees"} with ${i.baseline.verdict} at ${i.baseline.base_sha.slice(0, 12)} (${i.reason}) -> baseline ${exec} http=${status ?? "not posted"}`);
    if (status === null || status < 200 || status >= 300) { paidHere.delete(key); return { posted: false, why: `post answered ${status ?? "nothing"}` }; }
    await (deps.markPaid ?? markPaidOnRow)(i.gap_id, [...paid, key].slice(-20)).catch(() => undefined);
    return { posted: true, why: key };
  } catch (err) {
    return { posted: false, why: `not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
}
