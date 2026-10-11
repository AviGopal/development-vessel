/**
 * GAP ATTEMPT CREDIT (gap-judge-core, closed). How an attempt on a gap is credited, and the inputs of the floors that
 * credit feeds:
 * - landabilityScore: the LANDABILITY_FLOOR input and predictLand's p;
 * - the category calibration (hopeless exclusion, surprise baseline) and predictLand (the bump's surprise weight);
 * - bumpFailedAttempts: THE failed_attempts writer, with the narrowed child it emits (narrowedChildRecord);
 * - the approach-decision ledger every landing and failure joins (recordApproachDecision, joinDecisionOutcome,
 *   landingDecisionRef);
 * - the gap-class posterior;
 * - the causal-ledger attempt records (recordPickIntent, recordAttemptEnd);
 * - the trace-store route's non-attempt classifier (isRetryableDispatchRefusal).
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.4). One change
 * is not a pure move. bumpFailedAttempts used to call gap-to-feature's escalateToDecomposition at the chronic
 * threshold. A closed module may not import the residue, so it now calls `opts.escalate` at the same statement,
 * inside the same try/catch. Every production caller passes escalateToDecomposition (qa ruling, BOUNDARY.md 4.3).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord } from "../resolvers/attempt-ledger.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES, inheritableParentCheck } from "../resolvers/substrate-gap.js";
import { isNonAttemptComposeResult, isTerminalRefusalResult } from "./gap-eligibility.js";
import { vesselsCloneRoot } from "./gap-policy.js";
import { sweepGitOut } from "./gap-check-judge.js";

// LANDABILITY-RANKED SELECTION (2026-06-28). gap_to_feature historically picked gaps[0]
// (arbitrary order), so the autonomous loop kept selecting hard META/ARCHITECTURAL gaps
// (stale-proposal-backlog, decision-without-action, performance-inefficiency) that
// feature_compose cannot author a verifying surgical diff for -> UNFAVORABLE, 0 lands.
// Rank open gaps by a landability prior — prefer a CONCRETE edit-site + surgically-
// authorable categories, deprioritise meta/architectural — so the loop spends its
// authoring budget on gaps it can actually LAND + push. This RAISES the autonomous land
// rate (the residual after the autonomous-commit-on-dev demonstration).
const HARD_CATEGORIES = new Set([
  "architectural_pattern", "performance_inefficiency", "decision_without_action",
  "responsibility_misallocation", "learning_signal_degeneracy", "resolver_distribution",
]);
const SURGICAL_CATEGORIES = new Set([
  "missing_capability", "systematic_failure", "reference_integrity", "service_failure",
  "forward_model_artifact",
  // orphaned_capability lands via author_producer as a DIRECT activity mint (a
  // Thompson-selectable bridge invoking a live-but-unused resolver) — no
  // feature_compose + cutover needed. Its provisionable members mint immediately
  // (e.g. auto-bridge-repairPolicy), so it is genuinely MORE landable than the
  // hard feature classes; scoring it neutral (0.5) made the picker prefer
  // systematic_failure gaps that mostly UNFAVORABLE at the LLM frontier, starving
  // real capability expression. failed_attempts now culls the un-provisionable
  // orphaned members (MINT_FAILED bump, 2026-07-01), so boosting the class is safe:
  // the mintable ones land first, the rest deprioritise. (2026-07-01)
  "orphaned_capability",
  // documentation_drift lands via doc_drift_fix as a DIRECT single-file prose edit
  // with no feature_compose draft and no mitosis cutover — more landable than
  // hard feature classes, not less. (2026-08-26)
  "documentation_drift",
]);
// Decision-log categories are LOGS, not work — hard-zero so even if one leaks
// into the candidate window (belt-and-suspenders to the read-side exclusion) the
// picker can never select it over a real gap.
const NONACTIONABLE_LOG_CATEGORIES = new Set<string>(DECISION_LOG_GAP_CATEGORIES);
export function landabilityScore(gap: Record<string, unknown>): number {
  const cat0 = String(gap.category ?? "");
  if (NONACTIONABLE_LOG_CATEGORIES.has(cat0)) return 0;
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let s = 0.5;
  // A concrete change-site means feature_compose knows exactly where to edit (surgical).
  if (meta.edit_site || meta.suspected_real_location || meta.change_site || meta.failing_capability || meta.file_path || meta.doc_path) s += 0.3;
  if (typeof meta.edit_site === "string" || meta.single_file === true || typeof meta.doc_path === "string") s += 0.1;
  const cat = String(gap.category ?? "");
  if (HARD_CATEGORIES.has(cat)) s -= 0.4;
  if (SURGICAL_CATEGORIES.has(cat)) s += 0.15;
  if (cat === "documentation_drift") s += 0.2;
  // ids that empirically cycle UNFAVORABLE (meta/diagnostic; no surgical diff exists).
  if (/stale-proposal|demand-trace|forward[_-]chain|backlog|unknown/i.test(String(gap.id ?? ""))) s -= 0.3;
  // A RECOMMIT IS A RETRY OF A KNOWN FAILURE, AND THE PRIOR COULD NOT SEE IT.
  // Measured over a matched 3-day window: non-recommit composes convert at 26.9%
  // (76 landings / 283 attempts) while recommit-depth-1 converts at 5.3% (6 / 113)
  // -- five times worse -- yet recommit is ~32% of all compose attempts against a
  // backlog of ~423 open gaps. A recommit gap is filed under a NEW id, so its
  // failed_attempts starts at 0 and the fa penalty below never fires: the selector
  // scored a retry exactly like fresh work. This is a SCORED down-weight, not a
  // gate: recommit still runs when the pool is thin, which preserves the 11.6% of
  // landings it does earn. NOT depth-scaled -- depth-2 measured 22% (4 / 18), no
  // worse than fresh work, so penalising it harder would contradict the evidence.
  if (/(^|-)recommit-/i.test(String(gap.id ?? ""))) s -= 0.15;
  // Deprioritise gaps that keep failing to land: each prior UNFAVORABLE attempt drops
  // the score, so the loop stops re-picking a stuck high-rank gap and moves to landable
  // work. Capped so a transient fail doesn't permanently bury a genuine gap.
  const fa = Number((meta as Record<string, unknown>).failed_attempts ?? 0);
  // Gaps with a concrete edit_site are surgical — each failure is a bad LLM
  // draft, not evidence the gap is unlandable. Cap the per-attempt penalty at
  // 0.1 (vs 0.2) for surgical gaps so the picker keeps revisiting them after
  // a transient UNFAVORABLE rather than burying them behind meta/diagnostic
  // gaps that have no failed attempts only because they were never picked.
  const hasConcreteSite = Boolean(meta.edit_site || meta.change_site || meta.single_file);
  // Per-gap failure lessons capture the exact mistake so the next LLM draft
  // avoids it — a gap with lessons is MORE landable on re-pick, not less.
  const hasLessons = Boolean((meta as Record<string, unknown>).per_gap_failure_lessons);
  const penalty = Math.min(fa * (hasConcreteSite ? 0.1 : 0.2), 0.4) - (hasLessons ? 0.05 : 0);
  s -= penalty;
  // Penalise gaps whose metadata points at the picker/composer itself — selecting
  // them creates a self-referential loop that never lands. blockingWeight > 1
  // means the gap targets core infrastructure; discount proportionally so the
  // picker deprioritises them relative to ordinary capability gaps.
  const bw = blockingWeight(gap);
  if (bw > 1) s -= Math.min(0.3, 0.1 * (bw - 1));
  return Math.max(0, Math.min(1, s));
}
function blockingWeight(gap: Record<string, unknown>): number {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  let w = 1.0;
  const hay = [meta.edit_site, meta.failing_capability, meta.file_path, meta.root_cause]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/gap-to-feature|feature-compose|feature_compose|mitosis|cutover|drafter|fetchposteriorsforsignature|boredom-vessel/.test(hay)) w += 0.6;
  if (String(gap.category ?? "") === "self_development_reliability") w += 0.3;
  return Math.min(2.0, w);
}

/**
 * WHICH APPROACH DECISION A LANDED COMMIT BELONGS TO (credit 1b). The cutover writes an Attempt-Id trailer naming the
 * attempt intent registerAttempt wrote, and that intent records the pick's decision_id (dec-…). This is the one
 * mapping every landing join uses (the sweep, closeLandedGap, a falsified or reverted landing), so a park resumed by
 * a later pick credits the pick that registered the attempt, whichever path joins first. `inScope` is the caller's
 * own pick, used only when the commit names no attempt with a decision (no clone holds the sha yet, no trailer, an
 * intent from before decision_id, or an intent on another node's ledger). The source used is returned.
 */
export async function landingDecisionRef(sha: string, inScope?: string): Promise<{ decision_id?: string; attempt_id?: string; source: "attempt_trailer" | "in_scope" | "none" }> {
  let attemptId = "";
  let fromTrailer = "";
  try {
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
      for (const name of readdirSync(vesselsCloneRoot()).sort()) {
        const dir = join(vesselsCloneRoot(), name);
        if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["cat-file", "-e", `${sha}^{commit}`]) === null) continue;
        attemptId = (sweepGitOut(dir, ["log", "-1", "--format=%(trailers:key=Attempt-Id,valueonly)", sha]) ?? "").split("\n")[0]!.trim();
        break;
      }
    }
    if (attemptId) {
      const { readRecords } = await import("../resolvers/attempt-ledger.js");
      const intent = (await readRecords("attemptIntent", { key: attemptId }))[0]?.record as { decision_id?: unknown } | undefined;
      if (typeof intent?.decision_id === "string" && intent.decision_id) fromTrailer = intent.decision_id;
    }
  } catch { /* unreadable clone root or ledger: fall back to the caller's pick */ }
  if (fromTrailer) {
    if (inScope && inScope !== fromTrailer) console.warn(`[gap-to-feature] landing ${sha.slice(0, 12)} names attempt ${attemptId} of decision ${fromTrailer}; the in-scope pick ${inScope} is not credited for it`);
    return { decision_id: fromTrailer, attempt_id: attemptId, source: "attempt_trailer" };
  }
  if (inScope) return { decision_id: inScope, ...(attemptId ? { attempt_id: attemptId } : {}), source: "in_scope" };
  return { ...(attemptId ? { attempt_id: attemptId } : {}), source: "none" };
}

/** The gap as the store holds it now, or null when it cannot be read (the caller keeps its own copy). */
export async function readGapFresh(id: string): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  try {
    const read = await resolveSubstrateGap({ type: "substrateGap", id } as never);
    const rows = (read as { body?: { gaps?: Array<Record<string, unknown>> } }).body?.gaps;
    return Array.isArray(rows) ? (rows.find((r) => String(r.id) === id) ?? null) : null;
  } catch {
    return null;
  }
}

// Increment a gap's failed_attempts counter when an authoring attempt does NOT land
// (UNFAVORABLE / staged-not-pushed). Feeds landabilityScore so a stuck gap drops in
// priority and the loop stops churning on it instead of reaching landable work. Best-effort.
// EXPECTATION-SETTING (closure primitive, 2026-06-29): commit an explicit prediction of
// whether a gap will LAND, from its features (the landability prior IS the self-model's point
// estimate). The prediction is measured against the actual outcome (surprise = prediction
// error) so the substrate accrues a CALIBRATED self-model instead of acting blind. The
// counterfactual baseline is the 0.5 no-signal prior; p above/below it is the discriminating
// expectation.
// Learned per-category COUNTERFACTUAL baselines (expectation-setting step 2, 2026-06-29):
// persist the empirical {attempts,lands} per gap category in the workspace volume so
// predictLand's baseline is the real land-rate for "a gap like this", not a static 0.5 prior.
// The gap-specific signal (landabilityScore p) is judged AGAINST that learned counterfactual.
const CALIB_PATH = process.env.EXPECTATION_CALIB_PATH ?? "/workspace/expectation-calibration.json";
type CalibRec = Record<string, { attempts: number; lands: number }>;
// HELD, NOT LOCAL (value-per-cost-selection 5.5). The calibration is credited by the node that
// holds the gap store, from the gap writes every compose node sends it (a failed_attempts rise;
// a close with closed_reason landed_verified). A compose node reads that table, refreshed before
// each auto-pick, and uses its own file only when the holder cannot be read (logged). On the
// holder the read resolves locally and returns the same file.
let heldCalibration: CalibRec | null = null;
export async function refreshHeldCalibration(): Promise<void> {
  try {
    const r = await resolveSubstrateGap({ type: "substrateGap", limit: 1, include_calibration: true } as never);
    const cal = (r.body as { expectation_calibration?: unknown } | undefined)?.expectation_calibration;
    if (cal && typeof cal === "object") { heldCalibration = cal as CalibRec; return; }
    console.warn(`[expectation-calibration] gap store returned no calibration (shape=${String(r.shape)}) - using the local file`);
  } catch (err) {
    console.warn(`[expectation-calibration] holder read failed: ${String(err).slice(0, 200)} - using the local file`);
  }
  heldCalibration = null;
}
export function readCalibration(): CalibRec {
  if (heldCalibration) return heldCalibration;
  try { return existsSync(CALIB_PATH) ? (JSON.parse(readFileSync(CALIB_PATH, "utf8")) as CalibRec) : {}; }
  catch { return {}; }
}

// ---- Gap-class Thompson posterior (Option B) + pickDecision emission (Option A) ----
// Same local-JSON pattern as CALIB_PATH / close-oracle-calibration: one row per gap CLASS,
// Beta(alpha, beta) over "a compose attempt on a gap of this class lands".
const CLASS_POSTERIOR_PATH = process.env["GAP_CLASS_POSTERIOR_PATH"] ?? "/workspace/gap-class-posteriors.json";

type ClassPosteriors = Record<string, { alpha: number; beta: number }>;
export function gapClassOf(g: Record<string, unknown>): string {
  // HUMAN-REPORTED CLASS BUCKET SPLIT (2026-09-25):
  // Previously, all operator-filed (human_reported) gaps were grouped into a single
  // class "human", forcing one Beta to represent ~70 unrelated works and letting
  // narrow recommit:* classes win the class re-rank. Key the class by the gap's
  // concrete edit_site stem when present so each operator-filed gap family learns
  // its own posterior and competes fairly.
  {
    const __cat = String((g as Record<string, unknown>).category ?? "");
    if (__cat === "human_reported") {
      const __gm = ((g as { classification_metadata?: unknown; metadata?: unknown }).classification_metadata
        ?? (g as { metadata?: unknown }).metadata
        ?? {}) as Record<string, unknown>;
      const __siteRaw = String((__gm.edit_site ?? __gm.change_site ?? __gm.single_file ?? __gm.file_path ?? "") || "");
      if (__siteRaw) {
        const __file = __siteRaw.split(/[\\\/]/).pop() ?? __siteRaw;
        const __stem = __file.replace(/\.[^.]+$/, "").toLowerCase();
        if (__stem) return `human:${__stem}`;
      }
      // Fallback: derive a light-weight bucket from the id so we still avoid a single monolith.
      const __id = String((g as Record<string, unknown>).id ?? "").toLowerCase();
      const __tok = (__id.match(/[a-z0-9]+/g) ?? ["unsited"]).slice(0, 1).join("-");
      return `human:${__tok || "unsited"}`;
    }
  }
  if (String(g.source ?? "") === "human_reported") return "human";
  let id = String(g.id ?? "");
  let recommit = false;
  while (id.startsWith("recommit-")) { id = id.slice("recommit-".length); recommit = true; }
  // Lineage stem: id up to the first volatile token (colon nonce, hex hash, long number),
  // capped at 3 hyphen tokens so per-artifact ids (docs-drift-<doc>) do not each mint a class.
  const stem = id.split(":")[0]!.replace(/-?[0-9a-f]{6,}.*$/i, "").replace(/-?\d{4,}.*$/, "").replace(/-$/, "").split("-").slice(0, 3).join("-");
  const base = stem.length >= 3 ? stem : String(g.category ?? "unknown");
  return (recommit ? "recommit:" : "") + base;
}
export function readClassPosteriors(): ClassPosteriors {
  try { return existsSync(CLASS_POSTERIOR_PATH) ? (JSON.parse(readFileSync(CLASS_POSTERIOR_PATH, "utf8")) as ClassPosteriors) : backfillClassPosteriors(); }
  catch { return {}; }
}
// BACKFILL: an absent store seeds beta from historical compose failures (compose-lessons.jsonl
// rows carry gap_id; the file holds failures only). sqrt-damped so history cannot drown live evidence.
function backfillClassPosteriors(): ClassPosteriors {
  const out: ClassPosteriors = {};
  try {
    const fails = new Map<string, number>();
    for (const l of readFileSync("/workspace/proposals/compose-lessons.jsonl", "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const gid = String((JSON.parse(l) as Record<string, unknown>)["gap_id"] ?? "");
        if (gid) { const c = gapClassOf({ id: gid, source: "" }); fails.set(c, (fails.get(c) ?? 0) + 1); }
      } catch { /* skip bad line */ }
    }
    for (const [c, n] of fails) out[c] = { alpha: 1, beta: 1 + Math.min(30, Math.round(Math.sqrt(n))) };
    writeFileSync(CLASS_POSTERIOR_PATH, JSON.stringify(out));
  } catch { /* best-effort; an empty store is fine */ }
  return out;
}
export function updateClassPosterior(cls: string, landed: boolean): void {
  try {
    const p = readClassPosteriors();
    const rec = p[cls] ?? { alpha: 1, beta: 1 };
    if (landed) rec.alpha += 1; else rec.beta += 1;
    p[cls] = rec;
    writeFileSync(CLASS_POSTERIOR_PATH, JSON.stringify(p));
  } catch { /* best-effort */ }
}
// Exploration floor: every class samples from at least Beta(1,1) + its counts, never hard-zero mass.
export function sampleClassTheta(cls: string, posteriors?: ClassPosteriors): number {
  const rec = (posteriors ?? readClassPosteriors())[cls] ?? { alpha: 1, beta: 1 };
  const g = (k: number): number => { // Marsaglia-Tsang Gamma(k,1); valid for k >= 1
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = 0, v = 0;
      do { x = Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random()); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const ga = g(Math.max(1, rec.alpha)), gb = g(Math.max(1, rec.beta));
  return ga / (ga + gb);
}

/** Merge `patch` into the STORED row's classification_metadata (bumpFailedAttempts' build-on-the-stored-row rule). */
export async function persistGapMetaPatch(gap: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
  const id = String(gap.id ?? "");
  if (!id) return;
  const fresh = await readGapFresh(id);
  if (!fresh || String(fresh.status ?? "") === "closed") return;
  const freshMeta = fresh.classification_metadata ?? fresh.metadata;
  const meta0 = ((freshMeta && typeof freshMeta === "object" && !Array.isArray(freshMeta)) ? freshMeta : (gap.classification_metadata ?? {})) as Record<string, unknown>;
  await resolveSubstrateGapWrite({
    type: "substrateGap_write",
    expect_status: "open",
    gap: { id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at, classification_metadata: { ...meta0, ...patch }, status: "open" },
  } as never);
}

export function predictLand(gap: Record<string, unknown>): { predicted: boolean; p: number; baseline: number } {
  const p = landabilityScore(gap);
  // Counterfactual baseline = empirical land-rate for this gap's category (>=5 samples),
  // else the 0.5 no-signal prior. Predict land only if the gap's signal beats its class.
  const c = readCalibration();
  const rec = c[String(gap.category ?? "unknown")];
  const baseline = rec && rec.attempts >= 5 ? rec.lands / rec.attempts : 0.5;
  return { predicted: p >= Math.max(0.4, baseline), p, baseline };
}

// A narrowed child is a NEW gap about the same defect. It must not inherit
// fields that assert authorship or closure STATE: `detector` and
// `evidence_resolve` made self_fact_reconcile close two clones it never filed
// (2026-09-23 03:35, 04:00); landing/closed/pending stamps would let the sweep
// grade the child on the parent's evidence. Localisation (edit_site, file_path)
// and an operator-authored predicate (expected_literal / hardcoded_url /
// verify_shape) ARE the defect and stay. A predicate DERIVED from the parent's
// landing commit (predicate_source set) goes with its stamps: the parent already
// landed that literal and still failed, so the child would be born satisfied.
// The store reclassifies `falsifier` on write (substrate-gap.ts), so the class
// label is recomputed from what survives, never carried.
const NARROWED_INHERIT_NEVER = new Set([
  "detector", "evidence_resolve", "falsifier_exercise",
  "pending_outcome_verification", "pending_set_at", "pending_note",
  "predicate_source", "predicate_derived_at", "predicate_commit",
  "closed_reason", "close_basis", "closed_at", "resolution", "landed_sha",
  "operator_hold", "operator_hold_reason", "reopen_note",
]);
// checks:"drop" (a child minted from a landing's semantic dissent, feature-compose settleSemanticDissent):
// the parent's check already passed on the landed tree, so NO predicate of the parent's is carried, nor its
// dissent records, decomposition or own-check bookkeeping; the child's check is derived afresh.
const NARROWED_DROP_CHECK = new Set([
  "expected_literal", "hardcoded_url", "verify_shape", "falsifier", "falsified_at", "semantic_dissent",
  "decomposed_at", "decomposition", "own_check_broken", "own_check_unmeasurable_count", "own_check_last_reason", "own_check_last_at",
  "landed_unverified", "landed_unverified_reason", "disposition", "self_authored_check",
]);
/**
 * THE ONE NARROWED-CHILD BUILDER: chronic-failure narrowing (bumpFailedAttempts, checks:"inherit") and the
 * semantic-dissent child (feature-compose settleSemanticDissent, checks:"drop") both mint through it.
 * "inherit" keeps operator-authored predicates and gives back the parent's trusted class-2 check when the
 * child's scope still covers it; "drop" carries no check at all. Returns the row; the caller writes it.
 */
export function narrowedChildRecord(
  parent: Record<string, unknown>,
  meta: Record<string, unknown>,
  opts: { id: string; checks: "inherit" | "drop"; summaryTail: string; extra: Record<string, unknown> },
): Record<string, unknown> {
  const parentId = String(parent.id ?? "");
  const parentSummary = String(parent.summary ?? parent.title ?? "");
  const derivedPredicate = typeof meta["predicate_source"] === "string";
  const inherited: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (NARROWED_INHERIT_NEVER.has(k)) continue;
    if (derivedPredicate && (k === "expected_literal" || k === "hardcoded_url")) continue;
    if (opts.checks === "drop" && (NARROWED_DROP_CHECK.has(k) || k.startsWith("predicate_"))) continue;
    inherited[k] = v;
  }
  // THE PARENT'S CHECK COMES BACK when the child's scope still covers it (inheritableParentCheck: a
  // trusted class-2 test_suite check on the same edit site). Stripping it with the closure stamps above
  // left every narrowed child of a verifiable parent falsifier=none, so none could ever close verified.
  if (opts.checks === "inherit") Object.assign(inherited, inheritableParentCheck(meta, meta["edit_site"]));
  return {
    id: opts.id,
    category: parent.category,
    source: parent.source,
    summary: "[narrowed from " + parentId + "] " + parentSummary.replace(/^\[narrowed from [\w:.!-]+\]\s*/g, "") + opts.summaryTail,
    detected_at: parent.detected_at,
    classification_metadata: { ...inherited, failed_attempts: 0, parent_gap_id: parentId, narrowed_at: new Date().toISOString(), ...opts.extra },
    status: "open",
  };
}

// Decide whether a chronically-failing gap should be narrowed into a fresh child.
//
// Only narrow a ROOT gap; an already-narrowed child (parent_gap_id set) must not spawn
// grandchildren, else chronic failure produces an unbounded -narrowed-narrowed chain.
// A recommit- gap (feature-compose.ts's own retry-cap mechanism) records its lineage as
// re_commit/source_gap_id, never parent_gap_id, so without this check it looks like a
// root to THIS guard and gets narrowed too — then, if the narrowed result fails compose
// again, feature-compose wraps it in another recommit- layer (which again omits
// parent_gap_id), making it eligible for narrowing all over again. Each narrowing resets
// failed_attempts to 0 (and with it landability back to 1.0), so the two caps alternate
// forever instead of either ever holding — confirmed via the recommit-*-syntax_break-
// -narrowed chain measured on 2026-08-07 (id: route-edit-2206dec0:1's lineage).
export function shouldNarrowForChronicFailure(failedAttempts: number, meta: Record<string, unknown>): boolean {
  return failedAttempts >= 3 && !meta.parent_gap_id && !meta.re_commit && !meta.source_gap_id;
}

// Exported for unit test only (the investigation caller's one-decomposition-per-gap guard). No call-site change.
// `decisionId` is the pick's approach decision (resolveGapToFeature's attempt.id): the failure joins THAT decision.
// Without it the join was positional (newest unjoined entry), so two overlapping picks of one gap swapped outcomes.
export async function bumpFailedAttempts(gap: Record<string, unknown>, opts: { surprise?: boolean; predictedP?: number; decisionId?: string; escalate?: (gap: Record<string, unknown>, why: string) => Promise<unknown> } = {}): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    // The write below is unconditional (status open), so on a gap that CLOSED while its compose was in flight it
    // would REOPEN it with closed_at carried forward. Re-read first; a closed or unreadable row is not bumped.
    const fresh = await readGapFresh(id);
    if (!fresh || String(fresh.status ?? "") === "closed") return;
    // BUILD ON THE STORED ROW, NOT THE CALLER'S SNAPSHOT. The snapshot is the gap as it was PICKED;
    // the compose that just failed wrote its failure lesson to the store in between, and the store
    // replaces classification_metadata (it carries forward only OMITTED keys). Writing the snapshot
    // back wiped that lesson whenever the snapshot already held a failure_lessons key, and the
    // narrowing check below then read the same stale list ("NOT narrowing: no failure_lessons
    // recorded"). Measured 10-01: every compose followed by a bump lost its lesson, on both nodes.
    const freshMeta = fresh.classification_metadata ?? fresh.metadata;
    const meta0 = ((freshMeta && typeof freshMeta === "object" && !Array.isArray(freshMeta)) ? freshMeta : (gap.classification_metadata ?? gap.metadata ?? {})) as Record<string, unknown>;
    // A non-landing attempt the substrate PREDICTED would land is a high-information SURPRISE
    // (over-optimistic self-model) → deprioritise harder (x2) and tally the calibration miss so
    // the self-model is measurable. A correctly-predicted fail bumps normally.
    // Calibration attempt credit is taken by the gap-store holder from the failed_attempts rise below.
    const weight = opts.surprise ? 2 : 1;
    const fa = Number(meta0.failed_attempts ?? 0) + weight;
    const mis = Number(meta0.mispredicted_lands ?? 0) + (opts.surprise ? 1 : 0);
    // SPEND THE HUMAN-AUTHORIZED EXEMPTION (2026-08-28). The exemption granted by
    // escalation_disposition_apply is BOUNDED, and this is the only place the bound can
    // bind: a non-landing attempt consumes one. Without this decrement "bounded" would be
    // a word in a comment — the gap would re-enter selection forever on one human answer
    // and re-open the flood 143212a deliberately closed. At zero the seal applies again
    // and the gap re-escalates, which is the correct end state: the human's answer was
    // tried, it did not land, and the human should be asked again rather than the loop
    // grinding on it.
    const exRem = Number(meta0.human_exemption_attempts_remaining ?? 0);
    const exemptionPatch = exRem > 0
      ? { human_exemption_attempts_remaining: exRem - 1, human_exemption_spent_at: new Date().toISOString() }
      : {};
    const meta = { ...meta0, ...exemptionPatch, failed_attempts: fa, last_failed_at: new Date().toISOString(), mispredicted_lands: mis, last_predicted_p: opts.predictedP ?? meta0.last_predicted_p };
    joinDecisionOutcome(meta, { landed: false }, opts.decisionId ? { decision_id: opts.decisionId } : {});
    const bumpWrite = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      // Conditional: a row closed since the fresh read above stays closed (no reopen, no compose pickup).
      expect_status: "open",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "open",
      },
    } as never);
    // Closed in between: nothing was written, so nothing is narrowed or escalated from the stale copy.
    if ((bumpWrite?.body as { skip_reason?: unknown } | undefined)?.skip_reason === "status_precondition_failed") {
      console.log(`[gap-to-feature] failed-attempt bump for ${id} not written: the row is no longer open`);
      return;
    }
    // Emit narrowed child gap when the gap has now reached the chronic-failure
    // threshold (>= 3 failed_attempts). The child carries a tighter description
    // and resets failed_attempts to 0 so it re-enters the dispatch queue at
    // normal priority rather than being culled by the landabilityScore filter.
    const willExceedThreshold = shouldNarrowForChronicFailure(fa, meta0);
    if (willExceedThreshold) {
      try {
        const parentId: string = id;
        const lessonsForChild = Array.isArray((meta as Record<string, unknown>)["failure_lessons"]) ? ((meta as Record<string, unknown>)["failure_lessons"] as unknown[]) : [];
        if (lessonsForChild.length === 0 || String((lessonsForChild[lessonsForChild.length - 1] as Record<string, unknown>)?.["reason"] ?? "").startsWith("[deterministic] ")) {
          console.log(`[gap-to-feature] NOT narrowing ${parentId}: no failure_lessons recorded — the child would be a verbatim duplicate`);
        } else {
        // Deterministic id so re-narrowing the SAME parent upserts one idempotent child
        // (gapClassKey has no volatile token to strip here) instead of throwing on a
        // missing id or spawning a new row every failure.
        // ONE CHILD, EMITTED ONCE (gap-lane livelock, 2026-10-10): the deterministic id made a re-narrowing an upsert, so
        // every chronic tick rewrote the existing child (node1: "emitted narrowed child" for the same child each tick,
        // each write re-publishing it). A stored child, open or closed, is left as it is.
        const plannedChildId = `${parentId}-narrowed`;
        const storedChild = await readGapFresh(plannedChildId);
        if (storedChild) {
          console.log(`[gap-to-feature] narrowed child ${plannedChildId} already exists (status=${String(storedChild.status ?? "?")}); not emitted again`);
        } else {
        const childRecord = narrowedChildRecord(gap, meta, {
          id: plannedChildId,
          checks: "inherit",
          summaryTail: "\n\nWHY PREVIOUS ATTEMPTS ON THIS GAP FAILED (most recent last):\n" + (lessonsForChild as Array<Record<string, unknown>>).slice(-3).map((l) => "- " + String(l["class"] ?? "?") + ": " + String(l["reason"] ?? "").slice(0, 300)).join("\n") + "\n\nDo not repeat these failures. Address the specific cause named above.",
          extra: {},
        });
        await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: childRecord as never });
        const childId = String((childRecord as Record<string,unknown>).id ?? "");
        console.log(`[gap-to-feature] emitted narrowed child gap for chronically-stuck gap ${parentId}: ${childId}`);
        }
        }
        await opts.escalate?.(gap, "chronic failure");
      } catch (err) {
        // Child gap emission is best-effort; never block the parent update.
        console.warn(`[bumpFailedAttempts] child gap emit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch { /* best-effort */ }
}

/** The node an approach decision and its outcome belong to (as registerAttempt stamps attempt intents). */
const decisionNode = (): string => process.env["SUBSTRATE_NAME"] ?? "substrate";

/** The most recent approach decision that HAS an outcome. The reader at pick time runs after recordApproachDecision
 *  pushed this pick's fresh, unjoined entry, so "the last entry" was always that fresh entry and never a judged one:
 *  high_confidence_miss could not fire (0 lines in 24 h). */
export function lastJudgedDecision(decs: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(decs)) return undefined;
  for (let i = decs.length - 1; i >= 0; i--) {
    const e = decs[i] as Record<string, unknown> | null;
    if (e && typeof e === "object" && e.outcome && typeof e.outcome === "object") return e;
  }
  return undefined;
}
/** The self-model predicted a land (p >= 0.7) on the most recent judged decision, and it did not land. */
export function isHighConfidenceMiss(decs: unknown): boolean {
  const last = lastJudgedDecision(decs);
  const out = last?.outcome as Record<string, unknown> | undefined;
  return !!(last && Number(last.predicted_p ?? 0) >= 0.7 && out && out.landed === false);
}

/** Records the pick's decision and returns its decision_id (null when the write could not be built). */
export async function recordApproachDecision(gap: Record<string, unknown>): Promise<string | null> {
  try {
    const pred = predictLand(gap);
    const meta = (gap.classification_metadata ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(meta.approach_decisions) ? (meta.approach_decisions as unknown[]) : [];
    const decisionId = `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    arr.push({
      decision_id: decisionId,
      node: decisionNode(),
      at: new Date().toISOString(),
      predicted_p: pred.p,
      predicted_land: pred.predicted,
      edit_site: meta.edit_site ? String(meta.edit_site) : "",
      alternatives: ["full-scope-compose"],
    });
    while (arr.length > 5) arr.shift();
    meta.approach_decisions = arr;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: { ...gap, classification_metadata: meta, status: String(gap.status ?? "open") },
    } as never);
    return decisionId;
  } catch { /* best-effort */ return null; }
}

/** How each joinDecisionOutcome call was attributed, since process start. by_id: joined the entry its decision_id
 *  names. by_id_appended: the named entry was gone (shifted out by the 5-entry cap, or already joined), appended
 *  under that id. positional_single: no decision_id, exactly one unjoined entry of this node, joined it.
 *  unattributed_ambiguous: no decision_id and two or more candidates, appended as its own unattributed entry rather
 *  than guessing. appended_no_candidate: no decision_id and nothing unjoined (the bulk-close shape). Every
 *  non-by_id path also logs a [decision-join] line carrying the running count. */
const decisionJoinCounts = { by_id: 0, by_id_appended: 0, positional_single: 0, unattributed_ambiguous: 0, appended_no_candidate: 0 };
export function decisionJoinCounters(): Readonly<typeof decisionJoinCounts> { return { ...decisionJoinCounts }; }

/** OWNED JOIN: an outcome joins the entry with its decision_id. WITHOUT one it is NEVER silently positional: it
 *  joins the only unjoined entry its own node made (or a legacy entry with no node) when there is exactly one, and
 *  with two or more it does not guess (guessing is what swapped the outcomes of two overlapping picks); the outcome
 *  is appended as its own entry marked unattributed. Each path is counted (decisionJoinCounters) and logged. It
 *  never writes onto another node's decision: two nodes picking one gap each keep their own decision/outcome pair. */
export function joinDecisionOutcome(meta: Record<string, unknown>, outcome: Record<string, unknown>, ref: { decision_id?: string; node?: string } = {}): boolean {
  const node = ref.node ?? decisionNode();
  // An absent or fully-joined decision list is not a reason to discard a terminal outcome.
  // recordApproachDecision pushes a fresh unjoined entry on every PICK, so the ordinary
  // compose path always has somewhere to write. The mitosis-cutover sweep closes gaps in
  // BULK with no pick, so it has no unjoined entry and often no decision list at all, and
  // this function used to drop its landed:true write silently every single time.
  // Measured 2026-09-05 on the live store: of 44 gaps closed with a landed reason, 25 of the
  // 32 carrying decisions had EVERY decision reading landed:false, and a further 12 had no
  // approach_decisions key at all. 37 of 44 landings were invisible.
  if (meta.approach_decisions === undefined) meta.approach_decisions = [];
  const arr = meta.approach_decisions;
  if (!Array.isArray(arr)) return false;
  // IDEMPOTENT PER (gap, commit) for a FAVORABLE landing (2026-10-03): a gap re-closed on the landing it was
  // already credited for (19 times in a day for one commit on the trace-list gap) is not a new success.
  // Returns false so the caller does not pay the landing's posterior again either.
  if (outcome.landed === true && outcome.verdict === "FAVORABLE" && typeof outcome.commit === "string" && outcome.commit) {
    const already = arr.some((e) => {
      const o = (e && typeof e === "object" ? (e as Record<string, unknown>).outcome : undefined) as Record<string, unknown> | undefined;
      return !!o && o.landed === true && o.verdict === "FAVORABLE" && o.commit === outcome.commit;
    });
    if (already) return false;
  }
  const unjoined = (arr as Array<Record<string, unknown> | null>).filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !("outcome" in e));
  const what = `landed=${String(outcome.landed)}${outcome.commit ? ` commit=${String(outcome.commit).slice(0, 12)}` : ""}`;
  let extra: Record<string, unknown> = {};
  if (ref.decision_id) {
    const entry = unjoined.find((e) => e.decision_id === ref.decision_id);
    if (entry) {
      decisionJoinCounts.by_id += 1;
      entry.outcome = { ...outcome, joined_at: new Date().toISOString() };
      return true;
    }
    decisionJoinCounts.by_id_appended += 1;
    console.log(`[decision-join] ${what}: decision ${ref.decision_id} is not an unjoined entry (capped out or already joined); appended under its id (by_id_appended=${decisionJoinCounts.by_id_appended})`);
    extra = { decision_id: ref.decision_id };
  } else {
    const candidates = unjoined.filter((e) => e.node === undefined || e.node === node);
    if (candidates.length === 1) {
      decisionJoinCounts.positional_single += 1;
      console.warn(`[decision-join] ${what}: NO decision_id; joined the only unjoined entry of ${node} (${String(candidates[0]!.decision_id ?? "legacy, no id")}) positionally (positional_single=${decisionJoinCounts.positional_single})`);
      candidates[0]!.outcome = { ...outcome, joined_at: new Date().toISOString(), attributed_by: "positional_single" };
      return true;
    }
    if (candidates.length > 1) {
      decisionJoinCounts.unattributed_ambiguous += 1;
      console.warn(`[decision-join] ${what}: NO decision_id and ${candidates.length} unjoined entries of ${node}; not guessing, appended as unattributed (unattributed_ambiguous=${decisionJoinCounts.unattributed_ambiguous})`);
      extra = { unattributed: true, candidates: candidates.length };
    } else {
      decisionJoinCounts.appended_no_candidate += 1;
      console.log(`[decision-join] ${what}: NO decision_id and no unjoined entry of ${node}; appended (appended_no_candidate=${decisionJoinCounts.appended_no_candidate})`);
    }
  }
  arr.push({ at: new Date().toISOString(), appended_by: "joinDecisionOutcome", ...extra, node, outcome: { ...outcome, joined_at: new Date().toISOString() } });
  while (arr.length > 5) arr.shift();
  return true;
}

/**
 * EVERY ADMITTED COMPOSE ATTEMPT ON THE CAUSAL LEDGER. The ledger used to get an attemptIntent only at cutover
 * (feature-compose registerAttempt), so a failed attempt had no record. A pick now writes an attemptIntent keyed
 * by its approach decision_id (route gap_to_feature, no snapshot: pre_snapshot_id null, so the landing sweep,
 * which acts only on intents with landing events, never picks these up), and the attempt's end writes an
 * attemptOutcome under the same key: landed (commit), failed (stage + class) or refused (terminal refusal, a
 * non-attempt, or no compose ran). A killed attempt cannot write its own end, so it stays intent-only.
 * Record, never block: a ledger failure is logged and the compose goes on.
 */
export function recordPickIntent(attemptId: string, gap: Record<string, unknown>): void {
  try {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    appendRecord("attemptIntent", attemptId, {
      attempt_id: attemptId, route: "gap_to_feature", repo: null, touched_files: [], gap_id: String(gap.id ?? ""), proposal_id: null,
      authoring_execution_id: null, dispatch_id: null, directed: typeof meta.directed === "boolean" ? meta.directed : null,
      node: decisionNode(), prediction: { expect_pass: [], expect_change: [] }, pre_snapshot_id: null, stage: "pick", registered_at: new Date().toISOString(),
    });
  } catch (err) { console.warn(`[gap-to-feature] attempt ledger intent for ${attemptId} not written: ${String(err).slice(0, 200)}`); }
}
export function recordAttemptEnd(attemptId: string, gap: Record<string, unknown>, result: { shape?: string; body?: unknown } | null, err?: unknown): void {
  try {
    const body = ((result?.body ?? {}) as Record<string, unknown>);
    const cb = ((body.compose && typeof body.compose === "object" ? body.compose : {}) as Record<string, unknown>);
    const landed = body.landed === true;
    const composed = Object.keys(cb).length > 0;
    const refused = isTerminalRefusalResult(cb) || (composed && isNonAttemptComposeResult(cb));
    const outcome = err !== undefined ? "failed" : landed ? "landed" : refused || !composed ? "refused" : "failed";
    const cls = err !== undefined ? "exception" : String(cb.failure_kind ?? cb.error ?? body.error ?? (composed ? cb.verdict : body.verdict ?? body.route) ?? "") || null;
    appendRecord("attemptOutcome", attemptId, {
      attempt_id: attemptId, route: "gap_to_feature", gap_id: String(gap.id ?? body.gap_id ?? ""), node: decisionNode(), at: new Date().toISOString(),
      outcome, landed, stage: String(cb.stage ?? body.stage ?? (err !== undefined ? "exception" : "")) || null, class: landed ? null : (cls ? cls.slice(0, 200) : null),
      verdict: cb.verdict ?? body.verdict ?? null, commit: typeof body.landed_commit === "string" ? body.landed_commit : null,
      ...(err !== undefined ? { error: String(err).slice(0, 300) } : {}),
    });
  } catch (e) { console.warn(`[gap-to-feature] attempt ledger outcome for ${attemptId} not written: ${String(e).slice(0, 200)}`); }
}

/** A goal-host 503 whose JSON body says it is draining or quiesced ({retryable:true}, {draining:true}, or an
 *  error naming either): the dispatch was refused before it ran, so it is not a failed attempt. Anything else
 *  (another status, a 503 that does not say so, an unparseable body) is a real failure. */
export function isRetryableDispatchRefusal(status: number, text: string): boolean {
  if (status !== 503) return false;
  try {
    const b = JSON.parse(text) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return false;
    return b.retryable === true || b.draining === true || b.quiesced === true || /\b(quiesc|drain)/i.test(String(b.error ?? ""));
  } catch { return false; }
}
