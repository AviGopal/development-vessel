/**
 * LEARNING CREDIT (I4a; closed by the src/judge/ directory entry). A RECORDER, not a judge: it records outcomes the judge
 * core already decided and decides no verdict. No gate reads it except the readers of the tables it writes.
 *
 * The gap-class posterior, the close-oracle calibration and the detector closure credit were written to node-local files
 * by whichever node ran the decision, so each node learned only from its own composes. They are now WRITTEN THROUGH to
 * the node that holds the gap store (qa ruling 2026-10-16: write-through, not inference: the call sites and their
 * decisions are unchanged, only the storage moves), where I4b's read serves them to every node.
 *
 * - creditLearning(credit): the call sites' one entry. Appends to a local WRITE-AHEAD JOURNAL first, then sends
 *   `gapLearningCredit_write` to the holder (GAP_STORE_ENDPOINT), or applies it here when this node is the holder.
 *   An outage leaves the entry pending; replayLearningJournal() re-sends pending entries on the next credit (and on each
 *   held refresh). Nothing is dropped silently.
 * - applyCreditAtHolder(credit): the holder's apply. A REFERENCE CHECK first (G4: a credit moves a posterior, so it must
 *   name a record the holder can see), then idempotency per (table, key, event_id, outcome), then the SAME math the
 *   local writers used.
 *   * applied: the reference resolves and the credit was new; duplicate: already applied (a replay); unresolved: a
 *     sha the holder's clone does not hold YET (its origin/dev has not moved since the event): retried later;
 *     refused: malformed, unknown, or a sha still absent after origin/dev moved past the event: kept for audit.
 *   * Recency is read from git's own reflog of refs/remotes/origin/dev (the times the ref moved), never a file mtime.
 * - A credit with no reference at its call site is journaled `unreferenced` and counted, never invented (qa). A compose
 *   failure without a pick references its own failed_attempts bump (attempt:<gap>#<n>), so failures are never dropped.
 * The write is a `_write` shape, so the resolve route's identity-validated credential gate already applies.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sweepGitOut } from "./gap-check-judge.js";
import { vesselsCloneRoot } from "./gap-policy.js";
import { resolveSubstrateGap, forwardToGapStore, gapStoreIsLocal, baselineEarnedRecordFromStore, BASELINE_ARM, postConsumerTrace } from "../resolvers/substrate-gap.js";
import { resolvePoolImpulse } from "../resolvers/pool-impulse.js";

export type LearningTable = "class_posteriors" | "close_oracle" | "detector_credit" | "priority_weights";
export type LearningOutcome = "landed" | "failed" | "close" | "false_close" | "operator_engaged" | "closure";
export type LearningCredit = { table: LearningTable; key: string; outcome: LearningOutcome; gap_id: string; event_id: string; repo?: string; created_at: string };
export type CreditStatus = "applied" | "duplicate" | "unresolved" | "refused";
type JournalEntry = LearningCredit & { state: "pending" | "acked" | "refused" | "unreferenced"; reason?: string; tries: number };

const OUTCOMES: Record<LearningTable, readonly LearningOutcome[]> = {
  class_posteriors: ["landed", "failed"],
  close_oracle: ["close", "false_close", "operator_engaged"],
  detector_credit: ["closure"],
  // I3 (qa ruling (A) + refinement): the pick ranking's variant arms (variant:baseline, variant:terms) and its term
  // weights (term:impact, …), Beta α/β like the class posterior, credited by the pick's decision.
  priority_weights: ["landed", "failed"],
};
/** The table files, the same paths their former local writers used (read at call time). */
export const tablePath = (t: LearningTable): string =>
  t === "class_posteriors" ? (process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json")
  : t === "close_oracle" ? (process.env["CLOSE_ORACLE_CALIB_PATH"] ?? "/workspace/close-oracle-calibration.json")
  // the priority weights live beside the class posteriors (a new table needs no location of its own)
  : t === "priority_weights" ? join(dirname(process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json"), "gap-priority-weights.json")
  : (process.env["DETECTOR_CLOSURE_LEDGER_PATH"] ?? "/workspace/detector-closure-credit.json");
const appliedPath = (t: LearningTable): string => `${tablePath(t)}.applied.json`;
/** The write-ahead journal lives beside the learned tables (no location of its own: one bootstrap location for the state). */
const journalPath = (): string => join(dirname(tablePath("class_posteriors")), "learning-credit-journal.json");
/** A storage bound on settled journal rows kept for audit (not behaviour: pending rows are never dropped). */
const SETTLED_KEEP = 1000;

const readJson = <T>(p: string, dflt: T): T => { try { return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : dflt; } catch { return dflt; } };
/** This node holds the gap store (the same test substrate-gap's forwarding uses: one definition). */
export const isGapStoreHolder = (): boolean => gapStoreIsLocal();
const isHolder = isGapStoreHolder;
/** The shapes this module serves from the gap-store holder's learning tables: held data, like the gap store's own. */
export const LEARNING_CREDIT_HELD_SHAPES = ["gapLearningCredit_write"] as const;
const creditKey = (c: LearningCredit): string => `${c.key}|${c.event_id}|${c.outcome}`;

// ── the holder's apply ────────────────────────────────────────────────────────────────────────────────────────────

async function gapRow(id: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
    const rows = (r.body as { gaps?: Array<Record<string, unknown>> } | undefined)?.gaps;
    return Array.isArray(rows) ? (rows.find((g) => String(g["id"]) === id) ?? null) : null;
  } catch { return null; }
}
const metaOf = (g: Record<string, unknown> | null): Record<string, unknown> => ((g?.["classification_metadata"] ?? g?.["metadata"] ?? {}) as Record<string, unknown>);
function shasRecordedOn(g: Record<string, unknown> | null): Set<string> {
  const m = metaOf(g);
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v)) out.add(v.toLowerCase()); };
  add(m["landed_sha"]); add((m["falsifier_exercise"] as { commit?: unknown } | undefined)?.commit); add((m["regressed_by"] as { sha?: unknown } | undefined)?.sha);
  return out;
}
/** Where the sha is: present in a holder clone, or the clone's origin/dev moved after the event (so it was fetched since
 *  and still lacks it), or neither yet. Reflog times, never mtime. */
function shaLocation(sha: string, createdAtMs: number, repo?: string): "present" | "absent_after_fetch" | "not_fetched_yet" {
  let clones: string[] = [];
  try { clones = readdirSync(vesselsCloneRoot()).sort().filter((n) => !repo || n === repo); } catch { clones = []; }
  let movedAfter = clones.length > 0;
  for (const name of clones) {
    const dir = join(vesselsCloneRoot(), name);
    if (!existsSync(join(dir, ".git"))) { movedAfter = false; continue; }
    if (sweepGitOut(dir, ["cat-file", "-e", `${sha}^{commit}`]) !== null) return "present";
    const last = Number(sweepGitOut(dir, ["log", "-g", "-1", "--format=%ct", "refs/remotes/origin/dev"]) ?? "");
    if (!Number.isFinite(last) || last * 1000 <= createdAtMs) movedAfter = false;
  }
  return movedAfter ? "absent_after_fetch" : "not_fetched_yet";
}
/** The reference check: does the event_id name a record this holder can see? */
export async function resolveCreditReference(c: LearningCredit): Promise<{ status: "resolved" | "unresolved" | "refused"; reason: string }> {
  const m = /^(sha|decision|attempt|reland|engagement):(.+)$/.exec(c.event_id);
  if (!m || !c.gap_id) return { status: "refused", reason: `malformed event_id ${JSON.stringify(c.event_id).slice(0, 80)}` };
  const [, kind, val] = m as unknown as [string, string, string];
  const g = await gapRow(c.gap_id);
  if (kind === "sha") {
    if (!/^[0-9a-f]{7,40}$/i.test(val)) return { status: "refused", reason: "not a sha" };
    if (shasRecordedOn(g).has(val.toLowerCase())) return { status: "resolved", reason: "sha recorded on the gap" };
    const where = shaLocation(val, Date.parse(c.created_at), c.repo);
    if (where === "present") return { status: "resolved", reason: "sha in a holder clone" };
    return where === "absent_after_fetch" ? { status: "refused", reason: "sha absent after origin/dev moved past the event" } : { status: "unresolved", reason: "sha not fetched yet" };
  }
  if (!g) return { status: "refused", reason: `gap ${c.gap_id} not in the store` };
  if (kind === "decision") {
    const ds = metaOf(g)["approach_decisions"];
    return Array.isArray(ds) && ds.some((d) => (d as { decision_id?: unknown })?.decision_id === val) ? { status: "resolved", reason: "decision in the gap's ledger" } : { status: "refused", reason: "decision not in the gap's approach_decisions" };
  }
  if (kind === "attempt") {
    // attempt:<gap>#<n>: the failure's own failed_attempts bump. Visible once the bump write is: until then unresolved.
    const am = /^(.+)#(\d+)$/.exec(val);
    if (!am || am[1] !== c.gap_id) return { status: "refused", reason: "attempt names another gap or is malformed" };
    return Number(metaOf(g)["failed_attempts"] ?? 0) >= Number(am[2]) ? { status: "resolved", reason: "the gap's failed_attempts reached the attempt" } : { status: "unresolved", reason: "the attempt's bump is not visible yet" };
  }
  if (kind === "reland") return val === c.gap_id ? { status: "resolved", reason: "re-land escalation of the gap" } : { status: "refused", reason: "reland names another gap" };
  return val === `reland-needs-human-${c.gap_id}` ? { status: "resolved", reason: "answered re-land solicitation of the gap" } : { status: "refused", reason: "engagement names another solicitation" };
}
/** The math, unchanged from the former local writers. */
function applyMath(table: LearningTable, key: string, outcome: LearningOutcome, at: string, initial?: { alpha: number; beta: number }): void {
  const p = tablePath(table);
  const t = readJson<Record<string, Record<string, unknown>>>(p, {});
  if (table === "class_posteriors" || table === "priority_weights") {
    const r = (t[key] ?? initial ?? { alpha: 1, beta: 1 }) as { alpha: number; beta: number };
    if (outcome === "landed") r.alpha += 1; else r.beta += 1;
    t[key] = r;
  } else if (table === "close_oracle") {
    const r = (t[key || "unknown"] ?? { closes: 0, false_closes: 0 }) as { closes: number; false_closes: number; operator_engaged?: number };
    if (outcome === "false_close") r.false_closes += 1; else if (outcome === "close") r.closes += 1; else r.operator_engaged = (r.operator_engaged ?? 0) + 1;
    t[key || "unknown"] = r;
  } else {
    const r = (t[key] ?? { closures: 0, last_closed_at: at }) as { closures: number; last_closed_at: string };
    t[key] = { closures: r.closures + 1, last_closed_at: at };
  }
  writeFileSync(p, table === "detector_credit" ? JSON.stringify(t, null, 2) : JSON.stringify(t), "utf8");
}
export async function applyCreditAtHolder(c: LearningCredit): Promise<{ status: CreditStatus; reason: string }> {
  if (!OUTCOMES[c.table]?.includes(c.outcome) || typeof c.key !== "string") return { status: "refused", reason: "unknown table/outcome" };
  if (new Set(readJson<string[]>(appliedPath(c.table), [])).has(creditKey(c))) return { status: "duplicate", reason: "already applied" };
  const ref = await resolveCreditReference(c);
  if (ref.status !== "resolved") return { status: ref.status, reason: ref.reason };
  // CONCURRENT CREDITS: the applied set and the table are re-read AFTER the await and the check-apply-record runs with no
  // await in between (one JS turn), so two credits in flight never both apply, and neither overwrites the other's record.
  const initial = await seedFor(c.table, c.key);
  const applied = new Set(readJson<string[]>(appliedPath(c.table), []));
  if (applied.has(creditKey(c))) return { status: "duplicate", reason: "already applied" };
  applyMath(c.table, c.key, c.outcome, new Date().toISOString(), initial);
  applied.add(creditKey(c));
  writeFileSync(appliedPath(c.table), JSON.stringify([...applied]));
  return { status: "applied", reason: ref.reason };
}

/** I3 cold start (qa ruling (a)): the BASELINE ranking arm starts from its EARNED record, the joined outcomes of the picks
 *  it made before the terms variant existed (substrate-gap.ts baselineEarnedRecord), persisted at its first credit. Every
 *  other arm (the terms variant, each term) starts uninformed, Beta(1,1). No prior constant is declared. */
async function seedFor(table: LearningTable, key: string): Promise<{ alpha: number; beta: number } | undefined> {
  if (table !== "priority_weights" || key !== BASELINE_ARM) return undefined;
  const t = readJson<Record<string, unknown>>(tablePath(table), {});
  if (t[key]) return undefined;
  try { return await baselineEarnedRecordFromStore(); } catch { return undefined; }
}

// ── the caller's side: journal, send, replay ─────────────────────────────────────────────────────────────────────

function readJournal(): JournalEntry[] { return readJson<JournalEntry[]>(journalPath(), []); }
/** A journal row's identity: the credit and the moment it was journaled (one credit, one row). */
const rowId = (r: JournalEntry): string => `${r.table}|${creditKey(r)}|${r.created_at}`;
function writeJournal(rows: JournalEntry[]): void {
  const pending = rows.filter((r) => r.state === "pending");
  const settled = rows.filter((r) => r.state !== "pending").slice(-SETTLED_KEEP);
  try { writeFileSync(journalPath(), JSON.stringify([...settled, ...pending])); } catch (e) { console.warn(`[learning-credit] journal write failed: ${String(e).slice(0, 160)}`); }
}
async function send(c: LearningCredit): Promise<{ status: CreditStatus; reason: string } | null> {
  if (isHolder()) return applyCreditAtHolder(c);
  // The gap store's own forwarder (substrate-gap.ts): its route and its credential, one definition for every gap-store write.
  const r = await forwardToGapStore({ type: "gapLearningCredit_write", ...c });
  const b = (r?.body ?? {}) as { status?: unknown; reason?: unknown };
  const s = b.status;
  return s === "applied" || s === "duplicate" || s === "unresolved" || s === "refused" ? { status: s, reason: String(b.reason ?? "") } : null;
}
const settle = (row: JournalEntry, res: { status: CreditStatus; reason: string } | null): void => {
  row.tries += 1;
  if (!res || res.status === "unresolved") { row.reason = res?.reason ?? "holder unreachable"; return; }
  row.state = res.status === "refused" ? "refused" : "acked";
  row.reason = res.reason;
  if (res.status === "refused") console.warn(`[learning-credit] REFUSED ${row.table} ${row.key} ${row.event_id}: ${res.reason}`);
};
let replaying: Promise<unknown> | null = null;
/** Re-send every pending journal entry. Safe to repeat: the holder is idempotent per credit. A call made while a replay
 *  runs waits for it and then replays again, so a credit journaled meanwhile is never left behind. */
export async function replayLearningJournal(): Promise<{ pending: number; acked: number; refused: number }> {
  // The holder journals nothing (its credits are its own local writes), and a replay with nothing pending writes nothing:
  // a replay is called from READ paths (the held refresh), which must have no write side effect.
  if (isHolder()) return { pending: 0, acked: 0, refused: 0 };
  if (!readJournal().some((r) => r.state === "pending")) return { pending: 0, acked: 0, refused: 0 };
  while (replaying) { try { await replaying; } catch { /* the running replay's failure is its own */ } }
  let done!: () => void;
  replaying = new Promise<void>((r) => { done = r; });
  try {
    // CONCURRENT CREDITS: entries appended while this replay awaits the holder are re-read and kept (merged by identity),
    // never overwritten by this replay's in-memory copy; a credit appended during the replay is sent by the next pass.
    const settled = new Map<string, JournalEntry>();
    let acked = 0, refused = 0;
    for (let pass = 0; pass < 2; pass++) {
      const pendingNow = readJournal().filter((r) => r.state === "pending" && !settled.has(rowId(r)));
      if (pendingNow.length === 0) break;
      for (const row of pendingNow) {
        settle(row, await send(row));
        settled.set(rowId(row), row);
        if (row.state === "acked") acked += 1; else if (row.state === "refused") refused += 1;
      }
    }
    const merged = readJournal().map((r) => settled.get(rowId(r)) ?? r);
    writeJournal(merged);
    return { pending: merged.filter((r) => r.state === "pending").length, acked, refused };
  } finally { const d = done; replaying = null; d(); }
}
/** The call sites' entry. `event_id` null = the call site holds no reference: journaled `unreferenced`, never invented. */
export async function creditLearning(c: Omit<LearningCredit, "created_at" | "event_id"> & { event_id: string | null }): Promise<void> {
  // EVERY node keeps the LOCAL write it always made (the same math, in place, best-effort): on the holder that IS the
  // table; elsewhere it is the fallback copy the held read uses when the holder is unavailable. A NON-holder ALSO writes
  // the credit through to the holder (journaled, referenced, idempotent there). qa ruling 2026-10-17: pinned local writes
  // unchanged on every node. I3: the baseline ranking arm's first write starts from its earned record (seedFor).
  const initial = await seedFor(c.table, c.key);
  try { applyMath(c.table, c.key, c.outcome, new Date().toISOString(), initial); } catch (e) { console.warn(`[learning-credit] local write failed for ${c.table} ${c.key}: ${String(e).slice(0, 160)}`); }
  if (!isHolder()) await writeThroughLearning(c);
}
/** The write-through alone (a non-holder's credit to the holder): journal first, then send and replay. The holder never
 *  calls it (its local write is the table). `event_id` null = the call site holds no reference: journaled
 *  `unreferenced`, never invented. */
export async function writeThroughLearning(c: Omit<LearningCredit, "created_at" | "event_id"> & { event_id: string | null }): Promise<void> {
  if (isHolder()) return;
  try {
    const row: JournalEntry = { ...c, event_id: c.event_id ?? "", created_at: new Date().toISOString(), state: c.event_id ? "pending" : "unreferenced", tries: 0 };
    const rows = readJournal();
    rows.push(row);
    writeJournal(rows);
    if (!c.event_id) { console.warn(`[learning-credit] UNREFERENCED ${c.table} ${c.key} for gap ${c.gap_id}: the call site holds no event reference; not credited at the holder`); return; }
    await replayLearningJournal();
  } catch (e) {
    console.warn(`[learning-credit] write-through failed for ${c.table} ${c.key}: ${String(e).slice(0, 160)}`);
  }
}
/** The `gapLearningCredit_write` resolver (the holder's door; forwarded on a non-holder). */
export async function resolveGapLearningCreditWrite(pointer: Record<string, unknown>): Promise<{ shape: string; body: Record<string, unknown> }> {
  const c = pointer as unknown as LearningCredit;
  if (!isHolder()) {
    const res = await send({ table: c.table, key: c.key, outcome: c.outcome, gap_id: c.gap_id, event_id: c.event_id, repo: c.repo, created_at: c.created_at });
    return { shape: "gapLearningCreditResult", body: res ?? { status: "unresolved", reason: "holder unreachable" } };
  }
  if (typeof c.created_at !== "string" || !Number.isFinite(Date.parse(c.created_at))) return { shape: "gapLearningCreditResult", body: { status: "refused", reason: "created_at required" } };
  return { shape: "gapLearningCreditResult", body: await applyCreditAtHolder(c) };
}

// ── THE ONE REACH POST (REALIGNMENT §2.2 and §7 step 5; research wiring V1 + V2) ───────────────────────────────────────
/**
 * Every development-vessel grade of an execution goes through here: POST activity-api /v2/activities/execution-traces/reach
 * with {execution_id, reached, completion_shapes?, learning_mode?}. A RECORDER like the rest of this module: the caller
 * decided the verdict (a landing verdict, a compose that did not come back ok); this only delivers it. Never throws: a
 * missed grade leaves the execution ungraded, which moves nothing. `updated: 0` (an id the trace store holds no row for,
 * e.g. a gap-lane landing composed under this vessel's own execution id) is a normal answer, reported and not retried.
 */
export type ReachVerdict = { execution_id: string; reached: boolean; completion_shapes?: string[]; learning_mode?: "observe" };
export async function postReach(v: ReachVerdict, why: string): Promise<{ sent: boolean; status: number | null; updated: number | null; idempotent: boolean }> {
  if (!v.execution_id) return { sent: false, status: null, updated: null, idempotent: false };
  const ep = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
  const key = process.env["METABOB_API_KEY"] ?? "";
  try {
    const res = await fetch(`${ep}/v2/activities/execution-traces/reach`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
      body: JSON.stringify({ execution_id: v.execution_id, reached: v.reached, ...(v.completion_shapes ? { completion_shapes: v.completion_shapes } : {}), ...(v.learning_mode ? { learning_mode: v.learning_mode } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await res.json().catch(() => null)) as { updated?: unknown; idempotent?: unknown } | null;
    const updated = typeof j?.updated === "number" ? j.updated : null;
    // `idempotent: true`: the row already held this verdict, so `updated` counts it without the grade moving.
    const idempotent = j?.idempotent === true;
    console.log(`[reach-post] execution=${v.execution_id} reached=${v.reached} status=${res.status} updated=${updated ?? "?"}${idempotent ? " idempotent" : ""} (${why})`);
    return { sent: true, status: res.status, updated, idempotent };
  } catch (err) {
    console.warn(`[reach-post] execution=${v.execution_id} reached=${v.reached} NOT delivered (${why}): ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    return { sent: false, status: null, updated: null, idempotent: false };
  }
}

// ── THE REACH GRADE, AS AN ACTIVITY (development-vessel:reach-grade) ──────────────────────────────────────────────────
/**
 * Every grade above goes through reachGrade, so the delivery of a verdict is itself an activity the loop can grade
 * (seed/reach-grade.ts). It decides no verdict: the caller's verdict is delivered, and what happened to it is recorded.
 *   - variant-0 (control, `development-vessel:reach-grade`): post the id as given (postReach, unchanged).
 *   - variant-1 (`development-vessel:reach-grade-v1`): post the id as given; ONLY when that holds no row (updated 0),
 *     read it as a goal-host dispatch id, map it to the dispatch's trace id (GET /executions/:id executionId) and post
 *     that. An id that maps to nothing stays `unresolved`, never invented.
 * Which variant runs is the `activityVariantMask` pool impulse {activity_id, active_variant, from, until, reason, lift,
 * by}, read FRESH on every grade: a row for this activity is in force while now is in [from, until), the newest such row
 * wins. No row in force: variant-0. A pool that cannot be read: variant-0, logged `mask_unread` (never silent).
 * Delivery is judged from /reach's own reply: delivered = updated >= 1 (an execution row now holds the verdict); moved =
 * delivered && !idempotent (the row did not already hold it). One landing grades each RESOLVED id at most once (the
 * caller's `seen` map, shared across the landing's posts).
 * Each grade emits the variant's own trace (output executionReachResult) and a consumer trace
 * `development-vessel:reach-grade-credit` whose composition_chain is that trace, reached = delivered: the variant's
 * grade is the delivery, not its exit. Both posts are best effort and never block or fail the grade.
 */
export const REACH_GRADE_ACTIVITY = "development-vessel:reach-grade";
export const REACH_GRADE_CREDIT_ACTIVITY = "development-vessel:reach-grade-credit";
/** A variant's activity id: variant-0 is the template itself, variant-n its child template `<id>-v<n>`. */
export const reachGradeVariantId = (variant: number): string => (variant === 0 ? REACH_GRADE_ACTIVITY : `${REACH_GRADE_ACTIVITY}-v${variant}`);
const REACH_GRADE_VARIANTS = [0, 1] as const;
export const VARIANT_MASK_SHAPE = "activityVariantMask";

export type ReachSource = "landing" | "authoring" | "compose_exit";
export type ExecutionReachResult = {
  posted_id: string;
  resolved_id: string | null;
  resolution: "as_given" | "dispatch_mapped" | "unresolved";
  reached: boolean;
  delivered: boolean;
  moved: boolean;
  idempotent: boolean;
  updated: number | null;
  variant: number;
  source: ReachSource;
  why: string;
};
type MaskRow = { id?: string; body?: unknown };
export type ReachGradeDeps = {
  post?: typeof postReach;
  /** goal-host's dispatch record's executionId, or null when it has none or none is read. */
  executionIdOf?: (dispatchId: string) => Promise<string | null>;
  /** The open activityVariantMask rows, newest first. Throws when the pool cannot be read. */
  readMasks?: () => MaskRow[];
  postTrace?: (trace: Record<string, unknown>) => Promise<number | null>;
  nowIso?: string;
};
export type ReachGradeContext = {
  source: ReachSource;
  why: string;
  gap_id?: string;
  sha?: string;
  /** Resolved id -> delivered, shared across one landing's posts (dedupe). */
  seen?: Map<string, boolean>;
};

let reachGradeDeps: ReachGradeDeps = {};
/** Tests only: the seams reachGrade uses when the call passes none. */
export function __setReachGradeDepsForTests(d: ReachGradeDeps | null): void { reachGradeDeps = d ?? {}; }

const defaultReadMasks = (): MaskRow[] => resolvePoolImpulse({ type: "poolImpulse", shape: VARIANT_MASK_SHAPE, status: "open" }).body.impulses;
/** goal-host's dispatch record's executionId (GET /executions/:dispatchId). The same read as own-check-baseline-credit.ts
 *  dispatchExecutionId, which this closed module may not import (its import set is closed). */
async function goalHostDispatchExecutionId(dispatchId: string): Promise<string | null> {
  const ep = process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210";
  const key = process.env["METABOB_API_KEY"] ?? "";
  try {
    const r = await fetch(`${ep}/executions/${encodeURIComponent(dispatchId)}`, { headers: key ? { Authorization: `ApiKey ${key}` } : {}, signal: AbortSignal.timeout(5_000) });
    if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* swallow */ } return null; }
    const j = (await r.json().catch(() => ({}))) as { executionId?: unknown };
    return typeof j.executionId === "string" && j.executionId.length > 0 ? j.executionId : null;
  } catch {
    return null;
  }
}

/** The variant in force for `activityId` at `nowIso`, from the mask rows. Never throws. */
export function reachGradeVariant(activityId: string, nowIso: string, readMasks: () => MaskRow[]): { variant: number; why: string; unread: boolean } {
  let rows: MaskRow[];
  try { rows = readMasks(); } catch (err) {
    const why = `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0`;
    console.warn(`[reach-grade] mask_unread ${activityId}: ${why}`);
    return { variant: 0, why, unread: true };
  }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== activityId) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (typeof v !== "number" || !(REACH_GRADE_VARIANTS as readonly number[]).includes(v)) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0`, unread: false };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}`, unread: false };
  }
  return { variant: 0, why: "no mask in force: variant-0", unread: false };
}

const traceIdPart = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
/** The reach-grade variant's own trace: one deterministic task producing executionReachResult. */
export function reachGradeTrace(r: ExecutionReachResult, meta: { gap_id?: string; sha?: string; verdict: boolean }, nowIso: string): Record<string, unknown> {
  const id = reachGradeVariantId(r.variant);
  const impulse = `executionReachResult:${r.posted_id}`;
  return {
    execution_id: `reach-grade-${r.source}-${traceIdPart(r.posted_id)}-${Date.parse(nowIso) || Date.now()}`,
    template_id: id,
    activity_id: id,
    activity_variant_id: id,
    status: "completed",
    success: true,
    started_at: nowIso,
    duration_ms: 0,
    output_shapes: ["executionReachResult"],
    tasks: [{ id: "post-reach", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [impulse] }],
    tags: [`reach_grade_variant:${r.variant}`, `reach_grade_source:${r.source}`, `reach_grade_resolution:${r.resolution}`],
    metadata: { gap_id: meta.gap_id ?? null, sha: meta.sha ?? null, verdict: meta.verdict, executionReachResult: r },
  };
}
/** The consumer trace that grades a reach-grade execution: reached = the verdict was delivered to a row. */
export function reachGradeCreditTrace(r: ExecutionReachResult, reachGradeExecutionId: string, nowIso: string): Record<string, unknown> {
  const impulse = `executionReachResult:${r.posted_id}`;
  return {
    execution_id: `reach-grade-credit-${r.source}-${traceIdPart(r.posted_id)}-${Date.parse(nowIso) || Date.now()}`,
    template_id: REACH_GRADE_CREDIT_ACTIVITY,
    activity_id: REACH_GRADE_CREDIT_ACTIVITY,
    activity_variant_id: REACH_GRADE_CREDIT_ACTIVITY,
    status: r.delivered ? "completed" : "failed",
    success: r.delivered,
    ...(r.delivered ? {} : { failure_mode: { type: "verifier_negative", reason: `the reach verdict was not delivered to a trace row (${r.resolution}): ${r.why}` } }),
    started_at: nowIso,
    duration_ms: 0,
    composition_chain: [reachGradeExecutionId],
    tasks: [{
      id: "judge-delivery",
      resolver_id: "deterministic",
      resolver_tier: "deterministic",
      success: r.delivered,
      input_impulse_ids: [impulse],
      output_impulse_ids: [],
      consumed_provenance: [{ impulse_id: impulse, producer_execution_id: reachGradeExecutionId, origin: "ancestor" }],
    }],
    tags: [r.delivered ? "reached:true" : "reached:false", `reach_grade_variant:${r.variant}`, `reach_grade_moved:${r.moved}`],
    metadata: { producer_execution_id: reachGradeExecutionId, variant: r.variant, resolution: r.resolution, delivered: r.delivered, moved: r.moved, idempotent: r.idempotent },
  };
}

/**
 * Deliver `v` through the reach-grade variant in force. Returns the executionReachResult (plus `sent`: a post left this
 * node), or null when the landing already graded this id (no post, no trace). Never throws.
 */
export async function reachGrade(v: ReachVerdict, ctx: ReachGradeContext, deps: ReachGradeDeps = reachGradeDeps): Promise<(ExecutionReachResult & { sent: boolean }) | null> {
  if (!v.execution_id) return null;
  const seen = ctx.seen ?? new Map<string, boolean>();
  if (seen.has(v.execution_id)) return null;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const post = deps.post ?? postReach;
  const mask = reachGradeVariant(REACH_GRADE_ACTIVITY, nowIso, deps.readMasks ?? defaultReadMasks);
  const base = { posted_id: v.execution_id, reached: v.reached, variant: mask.variant, source: ctx.source };
  let r: ExecutionReachResult & { sent: boolean };
  try {
    const first = await post(v, ctx.why);
    const hit = (first.updated ?? 0) >= 1;
    seen.set(v.execution_id, hit);
    if (hit) r = { ...base, resolved_id: v.execution_id, resolution: "as_given", delivered: true, moved: !first.idempotent, idempotent: first.idempotent, updated: first.updated, sent: first.sent, why: "the id as given holds a row" };
    else if (mask.variant !== 1) r = { ...base, resolved_id: null, resolution: "unresolved", delivered: false, moved: false, idempotent: false, updated: first.updated, sent: first.sent, why: first.sent ? "the id as given holds no row (control: not mapped)" : "the post was not delivered" };
    else {
      const mapped = await (deps.executionIdOf ?? goalHostDispatchExecutionId)(v.execution_id);
      if (!mapped || mapped === v.execution_id) r = { ...base, resolved_id: null, resolution: "unresolved", delivered: false, moved: false, idempotent: false, updated: first.updated, sent: first.sent, why: mapped ? "the dispatch maps to the id as given, which holds no row" : "the id as given holds no row and maps to no dispatch execution" };
      else if (seen.has(mapped)) r = { ...base, resolved_id: mapped, resolution: "dispatch_mapped", delivered: seen.get(mapped) === true, moved: false, idempotent: false, updated: first.updated, sent: first.sent, why: `mapped to ${mapped}, already graded for this landing (not posted again)` };
      else {
        const second = await post({ ...v, execution_id: mapped }, `${ctx.why}; dispatch ${v.execution_id} mapped`);
        const ok = (second.updated ?? 0) >= 1;
        seen.set(mapped, ok);
        r = ok
          ? { ...base, resolved_id: mapped, resolution: "dispatch_mapped", delivered: true, moved: !second.idempotent, idempotent: second.idempotent, updated: second.updated, sent: second.sent, why: `the id as given holds no row; its dispatch's execution ${mapped} does` }
          : { ...base, resolved_id: null, resolution: "unresolved", delivered: false, moved: false, idempotent: false, updated: second.updated, sent: second.sent, why: `neither the id as given nor its dispatch's execution ${mapped} holds a row` };
      }
    }
  } catch (err) {
    r = { ...base, resolved_id: null, resolution: "unresolved", delivered: false, moved: false, idempotent: false, updated: null, sent: false, why: `not graded: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
  console.log(`[reach-grade] variant=${r.variant} (${mask.why}) source=${r.source} posted=${r.posted_id} resolved=${r.resolved_id ?? "-"} ${r.resolution} delivered=${r.delivered} moved=${r.moved}`);
  await emitReachGradeTraces(r, { gap_id: ctx.gap_id, sha: ctx.sha, verdict: v.reached }, nowIso, deps);
  return r;
}
async function emitReachGradeTraces(r: ExecutionReachResult & { sent?: boolean }, meta: { gap_id?: string; sha?: string; verdict: boolean }, nowIso: string, deps: ReachGradeDeps): Promise<void> {
  const send = deps.postTrace ?? ((t: Record<string, unknown>) => postConsumerTrace(t, "reach-grade"));
  try {
    const { sent: _sent, ...body } = r;
    const own = reachGradeTrace(body, meta, nowIso);
    const s1 = await send(own);
    if (s1 === null || s1 < 200 || s1 >= 300) { console.warn(`[reach-grade] own trace not posted (http=${s1 ?? "none"}); its credit is not posted either`); return; }
    const s2 = await send(reachGradeCreditTrace(body, String(own["execution_id"]), nowIso));
    if (s2 === null || s2 < 200 || s2 >= 300) console.warn(`[reach-grade] credit trace not posted (http=${s2 ?? "none"})`);
  } catch (err) {
    console.warn(`[reach-grade] traces not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }
}

/**
 * A COMPOSE'S EXIT IS NOT ITS GRADE. An ok compose is AWAITING ITS LANDING VERDICT: nothing is posted (activity-api's
 * /reach takes only a boolean, so "ungraded" is the absence of a post: the trace stays ungraded and the one later /reach,
 * the landing verdict's, grades it), and the line says so. A compose that did not come back ok is graded reached:false, as
 * before. An observe compose's verdict is recorded, never graded (learning_mode passes through).
 */
export async function composeExitReach(cb: Record<string, unknown>): Promise<{ posted: boolean; awaiting_landing_verdict: boolean }> {
  const id = typeof cb["execution_id"] === "string" ? (cb["execution_id"] as string) : "";
  if (!id) return { posted: false, awaiting_landing_verdict: false };
  if (cb["ok"] === true) {
    console.log(`[reach-post] execution=${id} awaiting_landing_verdict: an ok compose is graded by its landing verdict, not its exit (no reach posted)`);
    return { posted: false, awaiting_landing_verdict: true };
  }
  const r = await reachGrade({ execution_id: id, reached: false, ...(cb["observe"] === true ? { learning_mode: "observe" as const } : {}) }, { source: "compose_exit", why: "compose did not come back ok" });
  return { posted: r?.sent === true, awaiting_landing_verdict: false };
}
