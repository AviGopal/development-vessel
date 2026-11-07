/**
 * A PRE-CUTOVER SUITE THAT TIMED OUT UNDER CONTENTION IS DEFERRED, NOT REFUSED (development-vessel:precutover-suite-timeout-defer).
 *
 * The pre-cutover gate (vessel-mitosis-cutover.ts) runs the whole suite under a fixed budget. Killed at that budget,
 * the suite prints no summary, test_suite reads ran:false, and the gate refused an undirected landing as
 * pre_cutover_suite_not_run: a timeout on a contended host was charged to the tree as "nothing verified it", the
 * compose read UNFAVORABLE and the gap's lineage got a recommit child for a draft nothing had judged. pull-sync's test
 * gate, on the same condition, names it ("killed at its wall under contention, not a blind verdict") and defers.
 *   - variant-0 (the control): refused as before; the decision is logged "would defer" or "refused as before".
 *   - variant-1: when the suite TIMED OUT (test_suite timed_out), the host was CONTENDED, and this gap's deferrals are
 *     under the cap, the cutover defers (deferred + preserve_pending, the cutover's existing deferral contract): the
 *     compose reads BUSY, a non-attempt, its verified patch stays parked and the next compose for the gap resumes it.
 *     Anything else refuses exactly as variant-0.
 * Contended: PSI cpu "some", the worse of avg60 and avg300 when the suite ended, at or above the shaped row
 * pull_sync.testgate_psi_defer_pct (the one definition of "contended" both suite gates read); no row, 0, or no PSI:
 * not contended, as pull-sync reads it. The cap is the shaped row cutover.precutover_suite_timeout_defer_max (default
 * 2), counted per gap in a file on the volume (a resume stages under a new mitosis id; a restart keeps the count).
 * A suite that measured resets the gap's count.
 * Each decision logs one line under both variants. Under variant-1 the decision posts its own trace (output
 * precutoverSuiteTimeout), and a deferral is graded by its CONSUMER, the same gap's next pre-cutover suite
 * (settlePrecutoverSuiteTimeoutDefer): it measured -> reached; it did not -> not reached; no such run within 24 h ->
 * ungraded, logged. A variant-1 refusal is ungraded, logged. Variant-0 posts no trace.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOLUME_ROOT } from "../config.js";
import { readTuningNumber } from "../judge/gap-policy.js";
import { resolvePoolImpulse } from "./pool-impulse.js";
import { postConsumerTrace } from "./substrate-gap.js";

export const PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY = "development-vessel:precutover-suite-timeout-defer";
export const PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY = "development-vessel:precutover-suite-timeout-defer-credit";
export const precutoverSuiteTimeoutDeferVariantId = (variant: number): string => (variant === 0 ? PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY : `${PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY}-v${variant}`);
/** The row pull-sync's test gate reads for "the host is contended" (percent). Reused, not minted. */
export const SUITE_CONTENDED_PSI_ROW = "pull_sync.testgate_psi_defer_pct";
export const PRECUTOVER_SUITE_TIMEOUT_DEFER_MAX_ROW = "cutover.precutover_suite_timeout_defer_max";
export const PRECUTOVER_SUITE_TIMEOUT_DEFER_MAX_DEFAULT = 2;
const PSTD_LOG = `[${PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY}]`;
const PSTD_CREDIT_WINDOW_MS = 24 * 3_600_000;

type MaskRow = { id?: string; body?: unknown };
export type PrecutoverSuiteTimeoutDeferDeps = {
  readMasks?: () => MaskRow[];
  postTrace?: (t: Record<string, unknown>) => Promise<number | null>;
  nowMs?: () => number;
  psiCpu?: () => string;
  readTuning?: (name: string) => Promise<number | null>;
  /** The decisions and per-gap counts, in place of VOLUME_ROOT/precutover-suite-timeout-defer.json. */
  stateFile?: string;
};
let deps: PrecutoverSuiteTimeoutDeferDeps = {};
let seq = 0;
/** Tests only: the seams the decision and its credit use. null restores the real ones. */
export function __setPrecutoverSuiteTimeoutDeferDepsForTests(d: PrecutoverSuiteTimeoutDeferDeps | null): void { deps = d ?? {}; }
const nowMs = (): number => deps.nowMs?.() ?? Date.now();
const post = (t: Record<string, unknown>, what: string): void => {
  void (deps.postTrace ?? ((x: Record<string, unknown>) => postConsumerTrace(x, "precutover-suite-timeout-defer")))(t)
    .then((st) => { if (st === null || st < 200 || st >= 300) console.warn(`${PSTD_LOG} ${what} not posted (http=${st ?? "none"})`); })
    .catch((err) => console.warn(`${PSTD_LOG} ${what} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
};

/** Which variant runs: the first open activityVariantMask row for the activity whose [from, until) holds now.
 *  No row in force, an unknown variant or an unreadable pool: variant-0. Never throws. */
export function precutoverSuiteTimeoutDeferVariant(nowIso: string): { variant: number; why: string } {
  let rows: MaskRow[];
  try {
    rows = (deps.readMasks ?? (() => resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask", status: "open" }).body.impulses as MaskRow[]))();
  } catch (err) {
    return { variant: 0, why: `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0` };
  }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== PRECUTOVER_SUITE_TIMEOUT_DEFER_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (v !== 0 && v !== 1) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}

/** PSI "some" avg60 and avg300 (%), or null when the text is not PSI. */
export function parsePsiSome(text: string): { avg60: number; avg300: number } | null {
  const line = /^some\s+(.*)$/m.exec(text)?.[1] ?? "";
  const a60 = /\bavg60=([0-9]+(?:\.[0-9]+)?)/.exec(line), a300 = /\bavg300=([0-9]+(?:\.[0-9]+)?)/.exec(line);
  if (!a60 || !a300) return null;
  const avg60 = parseFloat(a60[1]!), avg300 = parseFloat(a300[1]!);
  return Number.isFinite(avg60) && Number.isFinite(avg300) ? { avg60, avg300 } : null;
}

type Pending = { traceId: string; gapId: string; vessel: string; variant: number; decidedAtMs: number };
type State = { pending: Pending[]; counts: Record<string, { n: number; lastMs: number }> };
const stateFile = (): string => deps.stateFile ?? join(VOLUME_ROOT, "precutover-suite-timeout-defer.json");
function load(): State {
  try {
    const j = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<State>;
    const pending = Array.isArray(j.pending) ? j.pending.filter((p): p is Pending => !!p && typeof p.traceId === "string" && typeof p.gapId === "string" && Number.isFinite(p.decidedAtMs)) : [];
    const counts: State["counts"] = {};
    for (const [k, v] of Object.entries(j.counts ?? {})) if (v && Number.isFinite(v.n) && Number.isFinite(v.lastMs)) counts[k] = { n: v.n, lastMs: v.lastMs };
    return { pending, counts };
  } catch { return { pending: [], counts: {} }; }
}
function save(s: State): void {
  try {
    const file = stateFile();
    writeFileSync(`${file}.tmp`, JSON.stringify(s));
    renameSync(`${file}.tmp`, file);
  } catch (err) { console.warn(`${PSTD_LOG} state not saved: ${String((err as Error)?.message ?? err).slice(0, 160)}`); }
}
/** Pending decisions past the credit window are ungraded (logged); counts idle that long are dropped. True when
 *  anything was dropped (the state is written only when it changed). */
function expire(s: State, now: number): boolean {
  const before = s.pending.length + Object.keys(s.counts).length;
  s.pending = s.pending.filter((p) => {
    if (now - p.decidedAtMs < PSTD_CREDIT_WINDOW_MS) return true;
    console.log(`${PSTD_LOG} ungraded ${p.traceId}: no pre-cutover suite for gap ${p.gapId} within 24 h`);
    return false;
  });
  for (const [k, v] of Object.entries(s.counts)) if (now - v.lastMs >= PSTD_CREDIT_WINDOW_MS) delete s.counts[k];
  return s.pending.length + Object.keys(s.counts).length !== before;
}

export type PrecutoverSuiteTimeoutDecision = { traceId: string; variant: number; defer: boolean; outcome: string };

/**
 * THE DECISION, taken only where the gate refuses today: an undirected landing whose pre-cutover suite did not run.
 * Never throws (a failure is variant-0: refused as before).
 */
export async function precutoverSuiteTimeoutDecision(a: { vessel: string; gapId: string; mitosisVersionId: string; timedOut: boolean }): Promise<PrecutoverSuiteTimeoutDecision> {
  const now = nowMs();
  const nowIso = new Date(now).toISOString();
  const traceId = `precutover-suite-timeout-defer-${String(a.vessel).replace(/[^a-zA-Z0-9]+/g, "-")}-${now}-${process.pid}-${++seq}`;
  try {
    const m = precutoverSuiteTimeoutDeferVariant(nowIso);
    // A run that did not time out is refused whatever the host and the rows say, so they are read only for a timeout.
    const read = deps.readTuning ?? readTuningNumber;
    const pctRow = a.timedOut ? await read(SUITE_CONTENDED_PSI_ROW).catch(() => null) : null;
    const pct = pctRow !== null && pctRow > 0 ? pctRow : 0;
    let psi: { avg60: number; avg300: number } | null = null;
    if (a.timedOut) try { psi = parsePsiSome((deps.psiCpu ?? (() => readFileSync("/proc/pressure/cpu", "utf-8")))()); } catch { psi = null; }
    const contended = pct > 0 && psi !== null && Math.max(psi.avg60, psi.avg300) >= pct;
    const maxRow = a.timedOut ? await read(PRECUTOVER_SUITE_TIMEOUT_DEFER_MAX_ROW).catch(() => null) : null;
    const max = maxRow !== null && maxRow >= 0 ? Math.floor(maxRow) : PRECUTOVER_SUITE_TIMEOUT_DEFER_MAX_DEFAULT;
    const s = load();
    const expired = expire(s, now);
    const count = s.counts[a.gapId]?.n ?? 0;
    const why = !a.timedOut ? "did not run, not a timeout" : !contended ? "timed out without contention" : count >= max ? `deferral cap reached (${count}/${max})` : "";
    const wouldDefer = why === "";
    const defer = m.variant === 1 && wouldDefer;
    const outcome = defer ? "deferred: tree kept, retried by the next compose for the gap"
      : m.variant === 1 ? `refused: ${why}`
      : wouldDefer ? "would defer (variant-0: refused as before)" : `refused as before (${why})`;
    if (defer) {
      s.counts[a.gapId] = { n: count + 1, lastMs: now };
      s.pending.push({ traceId, gapId: a.gapId, vessel: a.vessel, variant: m.variant, decidedAtMs: now });
    }
    if (defer || expired) save(s);
    const hostText = !a.timedOut ? "psi=not_read threshold=not_read" : `${psi ? `psi_avg60=${psi.avg60} psi_avg300=${psi.avg300}` : "psi=unread"} threshold=${pct}${pctRow === null ? " (row absent)" : ""}`;
    console.log(`${PSTD_LOG} decision=${traceId} variant=${m.variant} (${m.why}) vessel=${a.vessel} gap=${a.gapId} mitosis=${a.mitosisVersionId} timed_out=${a.timedOut} ${hostText} contended=${contended} deferrals=${count}/${max} -> ${outcome}`);
    if (m.variant !== 0) {
      const id = precutoverSuiteTimeoutDeferVariantId(m.variant);
      post({
        execution_id: traceId, template_id: id, activity_id: id, activity_variant_id: id, status: "completed", success: true, started_at: nowIso, duration_ms: 0,
        input_shapes: ["test_suite"], output_shapes: ["precutoverSuiteTimeout"],
        tasks: [{ id: "defer-or-refuse", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`precutoverSuiteTimeout:${traceId}`] }],
        tags: [`precutover_suite_timeout_defer_variant:${m.variant}`, `deferred:${defer}`],
        metadata: { precutoverSuiteTimeout: { variant: m.variant, vessel: a.vessel, gap_id: a.gapId, mitosis_version_id: a.mitosisVersionId, timed_out: a.timedOut, psi_avg60: psi?.avg60 ?? null, psi_avg300: psi?.avg300 ?? null, threshold: pct, contended, deferrals: count, max, deferred: defer, decided_at: nowIso } },
      }, `own trace of ${traceId}`);
      if (!defer) console.log(`${PSTD_LOG} ungraded ${traceId}: refused, nothing deferred`);
    }
    return { traceId, variant: m.variant, defer, outcome };
  } catch (err) {
    console.warn(`${PSTD_LOG} decision failed (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0, refused as before`);
    return { traceId, variant: 0, defer: false, outcome: "refused as before (decision failed)" };
  }
}

/**
 * THE CONSUMER: the same gap's next pre-cutover suite settles every deferral pending for it. It measured (ran, with
 * tests counted) -> reached, and the gap's count resets; it did not -> not reached. Never throws.
 */
export function settlePrecutoverSuiteTimeoutDefer(gapId: string, run: { ran: boolean; timedOut?: boolean; pass: number; fail: number }): void {
  try {
    const now = nowMs();
    const s = load();
    const expired = expire(s, now);
    const measured = run.ran && run.pass + run.fail > 0;
    const mine = s.pending.filter((p) => p.gapId === gapId);
    if (mine.length === 0 && !(measured && s.counts[gapId])) { if (expired) save(s); return; }
    s.pending = s.pending.filter((p) => p.gapId !== gapId);
    if (measured) delete s.counts[gapId];
    save(s);
    const next = measured ? "measured" : run.timedOut ? "timed_out" : "did_not_run";
    for (const p of mine) {
      const impulse = `precutoverSuiteTimeout:${p.traceId}`;
      if (p.variant !== 0) post({
        execution_id: p.traceId.replace(/^precutover-suite-timeout-defer-/, "precutover-suite-timeout-defer-credit-"),
        template_id: PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY, activity_id: PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY, activity_variant_id: PRECUTOVER_SUITE_TIMEOUT_DEFER_CREDIT_ACTIVITY,
        status: measured ? "completed" : "failed", success: measured,
        ...(measured ? {} : { failure_mode: { type: "verifier_negative", reason: `the gap's next pre-cutover suite ${next === "timed_out" ? "timed out again" : "did not run"}` } }),
        started_at: new Date(now).toISOString(), duration_ms: 0, composition_chain: [p.traceId],
        tasks: [{ id: "next-precutover-suite", resolver_id: "deterministic", resolver_tier: "deterministic", success: measured, input_impulse_ids: [impulse], output_impulse_ids: [],
          consumed_provenance: [{ impulse_id: impulse, producer_execution_id: p.traceId, origin: "ancestor" }] }],
        tags: [measured ? "reached:true" : "reached:false", `precutover_suite_timeout_defer_variant:${p.variant}`],
        metadata: { producer_execution_id: p.traceId, variant: p.variant, gap_id: gapId, next_run: next, pass: run.pass, fail: run.fail },
      }, `credit of ${p.traceId}`);
      console.log(`${PSTD_LOG} settled ${p.traceId} reached=${measured} next_run=${next} gap=${gapId}`);
    }
  } catch { /* the credit never changes a cutover */ }
}
