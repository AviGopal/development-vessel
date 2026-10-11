/**
 * GAP LANDING VERDICT (gap-judge-core, closed). How a landing is judged and settled:
 * - genuineLandSignal and closeLandedGap;
 * - the pending-land sweep (sweepPendingLandVerifications), with its stale / self-authored / non-discriminating
 *   refusals;
 * - the independent and registered landing verdicts (the pinned parent/landed re-run, the three verifier trust
 *   rules);
 * - the falsified-landing and operator-regression settlements;
 * - the auto-revert of a regressed lane landing (build 3);
 * - ancestor and descendant closes on the same predicate;
 * - the close-oracle's earned trust;
 * - the apply-failure grader with its patch_with_tools escalation;
 * - markTerminalRefusal's fixed_elsewhere close.
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.5).
 *
 * Two per-call callbacks replace residue calls that a closed module may not import:
 * - `ask`: the human-question channel (ui-write-passthrough), injected per qa ruling 10.2. It is used where
 *   resolveUiWritePassthrough was called.
 * - `escalate`: the chronic-failure escalation, handed to the bump as in gap-attempt-credit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolverResult } from "../resolvers/types.js";
import { resolveDissentOutcome, landedCloseReason, landingLabelHere, LANDING_LABELER } from "../resolvers/feature-compose.js";
import type { GoalVerificationLabel } from "../resolvers/feature-compose.js";
import { appendRecord } from "../resolvers/attempt-ledger.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite, DECISION_LOG_GAP_CATEGORIES, predicateSuspect, class2PredicateKey, reevaluateBirthVerdicts, birthCheckRepo } from "../resolvers/substrate-gap.js";
import { METABOB_API_KEY, METABOB_ENDPOINT, GOAL_HOST_VESSEL_ENDPOINT } from "../config.js";
import { readOperatorHold } from "../lib/operator-hold.js";
import { gapEditSite, isInfraRefusalBody, isParkingDisposition, liftLandVerificationHold, landVerdictIsMeasured } from "./gap-eligibility.js";
import { vesselsCloneRoot, discoverOwnResolveUrls, postEnvelopeRead, autonomyScope, autonomyScopeExcludes, type AutonomyScope } from "./gap-policy.js";
import { isLiteralOnlyStepClose, verifyGapCondition, type GapCheckVerdict, evaluateGapCheck, shaWasRevertedInAnyClone, landedCommitVerdict, sweepGitOut } from "./gap-check-judge.js";
/** The human-question channel (ui-write-passthrough), handed in per call: an effect the lane keeps open (qa 10.2). */
export type Ask = (pointer: Record<string, unknown>) => Promise<unknown>;
/** The chronic-failure escalation (gap-to-feature escalateToDecomposition), handed in per call as in gap-attempt-credit. */
export type Escalate = (gap: Record<string, unknown>, why: string) => Promise<unknown>;
import { landingDecisionRef, readGapFresh, gapClassOf, updateClassPosterior, joinDecisionOutcome, persistGapMetaPatch, bumpFailedAttempts } from "./gap-attempt-credit.js";

export const solicitedHumanGaps = new Set<string>();

// CLOSE-ON-LAND (2026-06-29). A landed gap previously stayed status:open, so the
// landability-ranked picker could re-select the SAME (now-fixed) gap each tick — its
// staged fix re-applies as a no-op / fails to anchor (the change is already in source),
// wasting cycles and starving the OTHER open gaps. The fix: when a gap's fix GENUINELY
// LANDS on origin/dev, mark it status:"closed" so the open-filtered picker advances
// through the backlog. Genuine land is a HIGH bar — closing too eagerly would lose a
// real gap. We require ALL of:
//   - verdict === "FAVORABLE" (typecheck-clean, semantic-gate-passed), AND
//   - land was requested (pointer.land, i.e. NOT dry_run), AND
//   - at least one cutover whose result is a cutoverApplied shape with
//     push_status === "pushed" (a REAL push to origin/dev with a new commit sha).
// A merely-staged FAVORABLE (no push clone), a soft-refuse (applied:false), a
// local_only / host_sync_pending / skipped push (incl. skip_push test mode), or an
// UNFAVORABLE result is NOT a genuine land → the gap stays open. dry_run never closes.
export interface LandSignal {
  landed: boolean;
  commit_sha: string | null;
  vessel: string | null;
  push_status: string | null;
}
export function genuineLandSignal(composeBody: Record<string, unknown>, landRequested: boolean): LandSignal {
  const none: LandSignal = { landed: false, commit_sha: null, vessel: null, push_status: null };
  if (!landRequested) return none;
  if (composeBody?.verdict !== "FAVORABLE") return none;
  const cutovers = Array.isArray(composeBody.cutovers) ? composeBody.cutovers : [];
  for (const c of cutovers) {
    const co = (c ?? {}) as Record<string, unknown>;
    const result = (co.result ?? {}) as Record<string, unknown>;
    // A successful cutover returns the cutoverApplied body (push_status + new_git_sha).
    // The soft-refuse / no-op paths also carry shape:"cutoverApplied" but with
    // applied:false and push_status not "pushed" — so gate strictly on "pushed".
    if (result.push_status === "pushed") {
      const sha = typeof result.new_git_sha === "string" && result.new_git_sha.trim() ? result.new_git_sha.trim() : null;
      return {
        landed: true,
        commit_sha: sha,
        vessel: typeof co.vessel === "string" ? co.vessel : (typeof result.vessel_name === "string" ? result.vessel_name : null),
        push_status: "pushed",
      };
    }
  }
  return none;
}

/** Mark a gap closed once its fix genuinely landed on origin/dev. Best-effort, guarded. */
// Exported for unit test only (the predicate_suspect guard, qa C2). No call-site change.
// `ref.decision_id` is the in-scope pick's decision; the landed commit's Attempt-Id → intent mapping wins over it
// (landingDecisionRef), so this path and the sweep credit the same decision for one landing.
export async function closeLandedGap(gap: Record<string, unknown>, land: LandSignal, ref: { decision_id?: string; ask?: Ask } = {}): Promise<{ closed: boolean; error?: string }> {
  try {
    // Re-read the gap: the caller's copy was captured at pick time, before the cutover's pending-land
    // stamp and before any hold written since. Closing from it overwrote newer fields (the f705b61 close
    // kept a reverted pending sha) and could not see a hold written after the pick (09-30).
    const fresh = await readGapFresh(String(gap.id ?? ""));
    if (fresh) gap = fresh;
    if (((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>).operator_hold === true) {
      return { closed: false, error: "operator_hold: not closed on landing" };
    }
    // A decision made while the landing was in flight (withdrawn, verified_by_operator_review, superseded)
    // is not overwritten by a machine landed_verified: the sig-count gap was withdrawn on 09-29 with two
    // landings on it in flight.
    if (fresh && String(gap.status ?? "open") !== "open") {
      return { closed: false, error: `already ${String(gap.status)}: not re-closed on landing` };
    }
    // Outcome-verification (increment 2): use the async verifier which covers both
    // the surgical-class (file+literal) AND the resolver-behaviour class
    // (evidence_resolve / verify_shape). Fall back to the sync verifier result
    // only when the async path itself throws (belt-and-suspenders).
    let verifyResult: 'present' | 'absent' | 'pending' | 'unknown';
    try {
      verifyResult = await evaluateGapCheck(gap);
    } catch {
      verifyResult = verifyGapCondition(gap);
    }
    const gidV = String(gap.id ?? "");
    // A check that never read 'present' before the fix cannot say the fix worked (8.5): not closed on it.
    const suspectAtClose = verifyResult === 'absent' ? predicateSuspect((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) : null;
    if (suspectAtClose) {
      console.log(`[gap-to-feature] gap ${gidV} reads absent but is NOT closed: predicate_suspect (${suspectAtClose})`);
      return { closed: false, error: `predicate_suspect: ${suspectAtClose}` };
    }
    if (verifyResult === 'present') {
      // Defect still present — refuse close. If this 'present' is a RE-LAND (>=2 non-reverted
      // landings, none of which resolved it), the close-oracle is out of coverage: abstain ->
      // escalate to the human (§12.6 step 1) rather than leave it to re-compose inertly forever.
      const editSitePresent = gapEditSite(gap, (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>) ?? "";
      if (landedCommitVerdict(gidV, editSitePresent) === 'present') {
        escalateRelandToHuman(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""), ref.ask!);
      }
      return { closed: false, error: 'outcome_verification_failure: gap condition still present at close time' };
    }
    if (verifyResult === 'pending') {
      // SINGLE landing, unverified — provenance, not measurement. This is the inert-diff (bafd83d)
      // hole: a no-op diff typechecks, lands, and used to close green here. Abstain: hold PENDING
      // (do not close, do not re-compose) and ask the human. No false-close label — pending is not
      // yet a failure. If a measurement predicate later becomes available the sweep closes/refuses it.
      await markPendingVerification(gap, land.commit_sha ?? undefined, "landed once; awaiting outcome verification (no measurement predicate)");
      escalatePendingVerification(gidV, String(gap.category ?? "?"), String(gap.summary ?? ""), ref.ask!, land.commit_sha ?? undefined);
      return { closed: false, error: 'close-oracle abstains: single landing is provenance, not measured resolution — held pending verification' };
    }
    if (verifyResult === 'unknown' && !closeOracleEarnedTrust('landed_commit')) {
      // Unmeasured, and the landed-commit class has NOT earned fail-open trust (Beta(1,1) or a
      // poor track record never earns — trust is held closes, not assumed). Abstain: leave open for
      // the next tick rather than close on no evidence. No escalation — 'unknown' here is transient/
      // unmeasurable (e.g. clone not converged), distinct from 'pending' (which HAS a landing to verify).
      await markPendingVerification(gap, land.commit_sha ?? undefined, "unmeasured at close; landed-commit class has not earned fail-open trust");
      return { closed: false, error: 'close-oracle abstains: unmeasured close on a class without earned trust' };
    }
    // verifyResult === 'absent' (measured resolved) OR 'unknown' with EARNED trust: allow close.
    const id = gidV;
    if (!id) return { closed: false, error: "gap missing id" };
  if (typeof land.vessel==="string" && land.vessel.includes("development-vessel")) { await resolveSubstrateGapWrite({type:"substrateGap_write",gap:{id,category:gap.category,source:gap.source,summary:gap.summary,detected_at:gap.detected_at,classification_metadata:{...((gap['classification_metadata'] as Record<string,unknown>)??{}),pending_outcome_verification:land.commit_sha,pending_set_at:new Date().toISOString()},status:"open"}} as never); return {closed:false,error:"self-cutover: closure deferred to next-tick verification"}; }

  // Self-cutover guard: when a landed change targets development-vessel itself,
  // close-time outcome verification runs in the pre-cutover process and cannot
  // observe the post-cutover state — producing hollow gap closures (observed on
  // gap-obsidian-vessel-count at commit bbad5c4). Defer closure to next-tick
  // pick-time outcome verification instead.
  if (typeof land.vessel === "string" && land.vessel.includes("development-vessel")) {
    const pendingOutcomeVerification = land.commit_sha ?? "unknown";
    const pendingSetAt = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        status: "open",
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: {
          ...(gap.classification_metadata ?? {}),
          pending_outcome_verification: pendingOutcomeVerification,
          pending_set_at: pendingSetAt,
        },
      },
    } as never);
    return { closed: false, error: "self-cutover: closure deferred to next-tick pick-time outcome verification" };
  }
    const selfAuthored = land.commit_sha ? selfAuthoredCheckInputs(gap, land.commit_sha) : [];
    if (selfAuthored.length > 0) {
      await markAwaitingOperatorReview(gap, land.commit_sha ?? "", selfAuthored);
      return { closed: false, error: `self-authored check: the landing edited its own check input(s) ${selfAuthored.join(", ")}` };
    }
    const resolution = `landed via mitosis cutover${land.commit_sha ? ` ${land.commit_sha}` : ""}${land.vessel ? ` (${land.vessel})` : ""}`;
    // Outcome verification: only close when the condition is observed gone.
    // Refuse on 'present' (still broken) AND 'pending' (single landing, unmeasured — provenance,
    // not resolution; the top-of-function gate already abstained on it, this is belt-and-suspenders).
    const conditionCheck = verifyGapCondition(gap);
    if (conditionCheck === 'present' || conditionCheck === 'pending') {
      const failureMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), outcome_verification_failure: `condition still present at close time after land ${land.commit_sha ?? 'unknown'}`, outcome_checked_at: new Date().toISOString() };
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id,
            category: gap.category,
            source: gap.source,
            summary: gap.summary,
            detected_at: gap.detected_at,
            classification_metadata: failureMeta,
            status: "open",
          },
        } as never);
      } catch { /* best-effort */ }
      return { closed: false, error: `outcome verification failed: hardcoded literal still present in edit_site after landing` };
    }
    // closed_reason + landed_sha (value-per-cost-selection 5.1): this close is a landing whose outcome
    // was verified above, the same fact the sweep records as `landed_verified`. Without the reason
    // the terminal measure (gaps closed by a verified landing) could not count this path at all.
    const literalOnlyClose = isLiteralOnlyStepClose((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>);
    // THE LANDER DOES NOT GRADE ITSELF (independent landing verdict): a verified close needs a grounded label the
    // sweep computed in its own pass (independentLandingVerdict); this path never has one and never reads the stored
    // label, so it never closes landed_verified. Hold it pending; the sweep re-runs the gap's own check at the
    // landing's parent and at the landed sha and closes it there.
    if (landedCloseReason((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>, land.commit_sha, literalOnlyClose) === "awaiting_independent_verdict") {
      await markPendingVerification(gap, land.commit_sha ?? undefined, "landed; awaiting the sweep's independent verdict (own check red at parent, green at the landed sha)");
      return { closed: false, error: "awaiting independent verdict: closed only by the sweep's parent/child re-run of the gap's own check" };
    }
    const closedMeta = { ...((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>), resolution, closed_reason: landedCloseReason((gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>, land.commit_sha, literalOnlyClose), ...(land.commit_sha ? { landed_sha: land.commit_sha } : {}), closed_at: new Date().toISOString(),
      falsifier_exercise: { detector: "closeLandedGap", verdict: literalOnlyClose ? "literal_present" : verifyResult, passed: !literalOnlyClose && verifyResult === "absent", ran_at: new Date().toISOString(), commit: land.commit_sha ?? null } };
    const meta = closedMeta;
    const landRef = await landingDecisionRef(land.commit_sha ?? "", ref.decision_id);
    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: land.commit_sha ?? null }, landRef.decision_id ? { decision_id: landRef.decision_id } : {});
    const landedCloseWrite = await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id,
        category: gap.category,
        source: gap.source,
        summary: gap.summary,
        detected_at: gap.detected_at,
        classification_metadata: meta,
        status: "closed",
      },
    } as never);
    if (landedCloseWrite?.shape !== "structuredError") await closeAncestorsOnSamePredicate(id, meta);
    if (landedCloseWrite?.shape !== "structuredError") await closeDescendantsOnSamePredicate(id, meta);
    // Calibration land credit is taken by the gap-store holder from the close written above.
    updateClassPosterior(gapClassOf(gap), true);
    // CLOSURE-CREDIT: reward the filing detector for gap closure (not just filing).
    // Best-effort — never throw; wrapped in its own try/catch.
    try {
      const detectorName: unknown = (gap as Record<string, unknown>).classification_metadata &&
        typeof (gap as Record<string, unknown>).classification_metadata === "object"
        ? ((gap as Record<string, unknown>).classification_metadata as Record<string, unknown>).detector
        : undefined;
      if (typeof detectorName === "string" && detectorName.length > 0) {
        const ledgerPath: string = process.env.DETECTOR_CLOSURE_LEDGER_PATH ?? "/workspace/detector-closure-credit.json";
        type LedgerEntry = { closures: number; last_closed_at: string };
        type Ledger = Record<string, LedgerEntry>;
        let ledger: Ledger = {};
        if (existsSync(ledgerPath)) {
          try {
            ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
          } catch {
            ledger = {};
          }
        }
        const existing: LedgerEntry | undefined = ledger[detectorName];
        ledger[detectorName] = {
          closures: (existing?.closures ?? 0) + 1,
          last_closed_at: new Date().toISOString(),
        };
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
      }
    } catch {
      // best-effort ledger write — never propagate
    }
    return { closed: true };
  } catch (e) {
    return { closed: false, error: (e as Error).message };
  }
}

// ── Pending-land verification sweep (land→close continuity) ──────────────────
// Self-cutover lands defer closure: closeLandedGap stamps
// classification_metadata.pending_outcome_verification = <landed SHA> and leaves the
// gap open, expecting a "next-tick verification" that never existed — so gaps with
// genuinely-landed commits stayed open and were picked and re-landed (observed on
// gap-transport-health-observer-reads-lying-signals-2026-07-29 and the
// service-failure-model-reality-audit duplicate re-lands). This sweep completes the
// deferred path: at gap_to_feature tick start (an EXISTING rhythm — no new timer),
// every open gap carrying a pending SHA is checked deterministically against the same
// in-container clones this file already reads; when the SHA is an ancestor of a
// clone's HEAD, the land is observable post-cutover and the gap flips to closed via
// substrateGap_write (shape-flow preserved) with closed_reason=landed_verified.
// Bounded like gap-lifecycle; best-effort; a still-'present' condition refuses close.
const PENDING_VERIFY_SWEEP_LIMIT = 25;
/** The gaps the pending-land sweep may verify: stamped with a landed sha (pending_outcome_verification) and NOT
 *  under operator_hold. An operator hold is a statement that the falsifier cannot yet be exercised; the sweep never
 *  closes over it (it is lifted by an exercised falsifier, not by a landing), so a held gap is dropped BEFORE the
 *  PENDING_VERIFY_SWEEP_LIMIT slice. Taken after it, held gaps sorted first and spent the slots: 158 of 350 checks
 *  in a day went to held gaps that were skipped on arrival (diag-s1, 2026-10-10). `held` counts the stamped gaps
 *  dropped for a hold, for the sweep's tally line. Exported for tests. */
export function pendingSweepCandidates(gaps: Record<string, unknown>[]): { unheld: Record<string, unknown>[]; held: number } {
  const unheld: Record<string, unknown>[] = [];
  let held = 0;
  for (const g of gaps) {
    const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
    if (!(typeof m.pending_outcome_verification === "string" && m.pending_outcome_verification.length >= 7)) continue;
    if (m.operator_hold === true) { held += 1; continue; }
    unheld.push(g);
  }
  return { unheld, held };
}
// When this process last examined each pending gap, whatever the verdict. Only a 'pending' verdict
// persists pending_last_checked_at, so without this a gap stuck at present/unknown/not_in_clone sorted
// first every tick and held a slot forever. In-process on purpose: no extra store write per checked gap.
const sweepLastCheckedAt = new Map<string, string>();
// PERSISTED, because a process lives only 1-3 sweeps (every landing restarts it) and rotating the
// pending set needs ~7: an in-process map emptied before the rotation finished (qa, 09-29). One small
// state file, no gap-store write. Resolved at call time; no WORKSPACE_ROOT means no persistence, so a
// test run can never write a live path.
function sweepLastCheckedPath(): string | null {
  const root = process.env["WORKSPACE_ROOT"];
  return root ? join(root, "state", "sweep-last-checked.json") : null;
}
function loadSweepLastChecked(): void {
  const p = sweepLastCheckedPath();
  if (!p || !existsSync(p)) return;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && v > (sweepLastCheckedAt.get(k) ?? "")) sweepLastCheckedAt.set(k, v);
    }
  } catch (err) {
    console.warn(`[gap-sweep] sweep-last-checked state unreadable at ${p}: ${String(err)}`);
  }
}
function saveSweepLastChecked(): void {
  const p = sweepLastCheckedPath();
  if (!p) return;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    // Atomic: a restart lands mid-sweep, and a kill during a plain write leaves truncated JSON.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sweepLastCheckedAt)));
    renameSync(tmp, p);
  } catch (err) {
    console.warn(`[gap-sweep] sweep-last-checked state not written at ${p}: ${String(err)}`);
  }
}
// SINGLE-FLIGHT: two sweeps started in the same second several times on 09-29, computing the same slice
// and escalating twice. A call while one runs gets the running one.
let sweepInFlight: Promise<{ checked: number; closed: number }> | null = null;

/**
 * Finds commits that fixed this gap via lineage (parent/child relationship) when 
 * no direct mention is found in commit messages. Returns SHA if found, null otherwise.
 * Bounds lineage walk at depth 8 to prevent unbounded search.
 */
async function landedCommitViaLineage(gap: Record<string, unknown> & { id?: string }): Promise<string | null> {
  if (!gap.id) return null;
  
  // 1. Get metadata to find lineage
  const meta = gap.classification_metadata as Record<string, unknown> | undefined ?? {};
  const editSite = gapEditSite(gap, meta);
  
  // 2. Check direct commits first as fast path
  const directSha = await landedCommitVerdict(gap.id, editSite ?? "");
  if (directSha !== null) return directSha;
  
  // 3. Build lineage IDs set from parent/source chain
  const lineageIds = new Set<string>();
  let parentId = String(meta.parent_gap_id ?? meta.source_gap_id ?? "");
  let depth = 0;
  const seen = new Set<string>();  
  
  while (parentId && depth < 8 && !seen.has(parentId)) {
    seen.add(parentId);
    lineageIds.add(parentId);
    
    // Walk up lineage via stored metadata - requires access to gap store
    const parentGap = gap as Record<string, unknown>; // Simplified - real impl needs gap store access
    const parentMeta = parentGap.classification_metadata as Record<string, unknown> | undefined;
    parentId = String(parentMeta?.parent_gap_id ?? parentMeta?.source_gap_id ?? "");
    depth++;
  }
  
  if (lineageIds.size === 0) return null;
  
  // 4. Search clones for commits touching editSite and mentioning lineage IDs
  const cloneRoot = vesselsCloneRoot();
  let clones: string[] = [];
  try { clones = readdirSync(cloneRoot); } catch { return null; }
  
  for (const cloneName of clones) {
    const cloneDir = join(cloneRoot, cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    
    try {
      // Search for commits touching editSite and mentioning any lineage ID
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "log", "--grep", Array.from(lineageIds).join("\\\|"), "--fixed-strings", "--since=14.days", "--", String(editSite)], 
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      
      if (proc.exitCode === 0) {
        const commits = new TextDecoder().decode(proc.stdout).split("\n");
        for (const commitLine of commits) {
          const [sha, ...messageParts] = commitLine.split(" ");
          if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
            if (!shaWasRevertedInAnyClone(sha)) return sha;
          }
        }
      }
    } catch { /* per-repo failure — continue */ }
  }
  
  return null;
}
/** Deterministic land evidence: is `sha` an ancestor of HEAD in ANY vessel clone? */
// SWEEP ONLY ON NEW EVIDENCE. sweepPendingLandVerifications ran before EVERY auto-pick and
// did a lineage git search per predicate-carrying gap plus serial gap writes and
// escalations (~60-75 network writes per pass, measured 2026-09-26: selection took over
// 5 s and re-asked the same human questions). The only new evidence it can use is a new
// commit in a clone (a landing or a pull-sync convergence), so it runs when the clone
// HEADs changed since the last sweep. Condition-driven, not a timer; an unreadable
// fingerprint falls back to sweeping as before.
let lastSweepHeads: string | null = null;
function cloneHeadsFingerprint(): string | null {
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()).sort(); } catch { return null; }
  const heads: string[] = [];
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      if (proc.exitCode !== 0) return null;
      heads.push(`${cloneName}@${new TextDecoder().decode(proc.stdout).trim()}`);
    } catch { return null; }
  }
  return heads.join(",");
}

function shaIsAncestorOfAnyClone(sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  let entries: string[] = [];
  try { entries = readdirSync(vesselsCloneRoot()); } catch { return false; }
  for (const cloneName of entries) {
    const cloneDir = join(vesselsCloneRoot(), cloneName);
    if (!existsSync(join(cloneDir, ".git"))) continue;
    try {
      const proc = Bun.spawnSync(["git", "-C", cloneDir, "merge-base", "--is-ancestor", sha, "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      if (proc.exitCode === 0) return true;
    } catch { /* per-repo failure — continue */ }
  }
  return false;
}

// ── Close-oracle EARNED-TRUST gate (§12.6 step 1, 2026-08-14) ────────────────────────────────
// The fail-open direction — closing a gap on an UNMEASURED verdict ('unknown') — is permitted ONLY
// when the close-oracle has EARNED that trust for the evidence class: enough samples AND a
// reliability floor. This is the inverse of satisfierProvenBad (satisfier-pick.ts) and reuses its
// constants. CRITICAL: a fresh class at Beta(1,1) (zero evidence) must NOT earn fail-open — "trust
// assumed" is exactly what the program forbids; trust is earned by holding closes. landed_commit at
// {closes:0,false_closes:8} => 8 samples < floor and reliability 0.1 < 0.3 => never earns => abstains.
const CLOSE_ORACLE_TRUST_FLOOR = 0.7;   // a class must hold >=70% of its closes to fail-open on unknown
const CLOSE_ORACLE_MIN_SAMPLES = 10;    // and have >=10 graded closes; below this it has no earned trust
export function closeOracleEarnedTrust(evidenceClass: string): boolean {
  const r = closeOracleReliability(evidenceClass);
  const samples = r.closes + r.false_closes;
  return samples >= CLOSE_ORACLE_MIN_SAMPLES && r.reliability >= CLOSE_ORACLE_TRUST_FLOOR;
}

/**
 * Abstain -> escalate (§12.6 step 1, 2026-08-14). The close-oracle refuses to close a gap on a
 * RE-LAND (>=2 non-reverted landings, none of which resolved the condition) — it is OUT OF
 * COVERAGE: repeated landing without closure means the automated fix is inert or wrong. Unlike
 * the category-hopeless escalation (which keys on lands===0 and therefore never fires for a gap
 * that DOES land), this fires per-gap at the close-refusal point and asks the human. The
 * uiQuestion_write is the durable escalation record and, once answered, an operator-verdict
 * corpus entry that calibrates the oracle. Deduped via solicitedHumanGaps; fire-and-forget.
 */
function escalateRelandToHuman(gapId: string, category: string, summary: string, ask: Ask): void {
  if (!gapId || solicitedHumanGaps.has(gapId)) return;
  solicitedHumanGaps.add(gapId);
  // A re-land is the retrospective FALSE-CLOSE label for the landed-commit class: grade the oracle.
  recordCloseVerdict("landed_commit", true);
  const rel = closeOracleReliability("landed_commit");
  const relNote = ` [close-oracle landed-commit reliability so far: ${(rel.reliability * 100).toFixed(0)}% (${rel.closes} closes, ${rel.false_closes} re-lands)]`;
  void ask({ type: "uiQuestion_write", id: "reland-needs-human-" + gapId, title: "Gap re-lands without closing — needs a human decision", body: "Gap " + gapId + " (" + category + ") has had multiple substrate-authored landings, none of which resolved its condition (the close-oracle abstains — out of coverage). The automated fix keeps landing an inert or wrong change. It likely needs a human: redefine the goal, supply the missing fact, grant access, or drop it. Summary: " + summary.slice(0, 300) + relNote, kind: "gap_reland_needs_human", importance: "high" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] reland uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] reland uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] reland uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

// Dedup for pending-verification escalations, separate from re-land dedup: a gap can escalate as
// 'pending' (one landing, unverified) and LATER as 're-land' (>=2 landings) — distinct signals.
const pendingVerificationEscalated = new Set<string>();

/**
 * Abstain on a SINGLE landing (§12.6 step 1, 2026-08-14). A single non-reverted commit naming the
 * gap is PROVENANCE (a change landed), not MEASUREMENT (the condition resolved) — the inert-diff
 * (bafd83d) hole. The close-oracle abstains: it neither closes (an inert diff would close green)
 * nor labels a false-close (pending is not yet a failure — the landing may be genuine). It asks the
 * human to confirm the landed change actually did the thing. Deduped; fire-and-forget. NOTE: unlike
 * escalateRelandToHuman this records NO close-verdict — a pending gap has not failed, so labelling it
 * would poison the posterior with a verdict reality has not yet delivered.
 */
function escalatePendingVerification(gapId: string, category: string, summary: string, ask: Ask, sha?: string): void {
  if (!gapId || pendingVerificationEscalated.has(gapId)) return;
  pendingVerificationEscalated.add(gapId);
  const shaNote = sha ? ` (landed ${String(sha).slice(0, 12)})` : "";
  void ask({ type: "uiQuestion_write", id: "pending-verify-" + gapId, title: "Gap landed but is unverified — did the change actually fix it?", body: "Gap " + gapId + " (" + category + ") had a single substrate-authored landing" + shaNote + ", but the close-oracle has no way to MEASURE whether the change resolved the condition (no literal/resolver predicate — provenance only). Rather than close it green on the commit alone (the inert-diff hole), it is held PENDING. Please confirm: did the landed change actually fix this, or is it inert/wrong? Summary: " + summary.slice(0, 300), kind: "gap_pending_verification", importance: "medium" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] pending-verify uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] pending-verify uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] pending-verify uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

/**
 * Mark a gap PENDING-VERIFICATION: keep it open, stamp pending_outcome_verification (so the
 * sweep re-checks it) and disposition:'pending_verification' (so ADMISSION skips re-composing it —
 * a second landing would read as a re-land and manufacture the false-close the oracle is calibrated
 * against). Best-effort; never throws into the caller.
 */
/** pending_last_checked_at for a pending mark. A NEW landing (a sha different from the one already pending) has
 *  never been examined by the sweep, so it gets "" and sorts FIRST in the least-recently-checked slice; stamping it
 *  "now" at landing time made every fresh landing look just-checked and wait behind the whole pending set (three
 *  verified landings sat 60+ min unexamined behind 103 pending gaps, 2026-09-30). A re-mark of the same landing
 *  keeps the current behaviour. */
export function pendingCheckedStamp(prevSha: unknown, sha: string | undefined, nowIso: string): string {
  // Never examined yet (no pending sha before this mark, whatever this one is) or a NEW sha: sort first.
  return !prevSha || (sha !== undefined && sha !== prevSha) ? "" : nowIso;
}

export async function markPendingVerification(gap: Record<string, unknown>, sha: string | undefined, note: string): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at,
        classification_metadata: {
          ...meta0,
          pending_outcome_verification: sha ?? meta0['pending_outcome_verification'] ?? "unknown",
          // Keep the ORIGINAL stamp while the landing is the same one. Re-stamping on every check made
          // the gaps just checked the newest, so the newest-first sweep slice re-selected the same 24
          // every tick and 59 measurable pending gaps were never examined (09-29). The check time is
          // recorded separately and orders the sweep.
          pending_set_at: (sha === undefined || sha === meta0['pending_outcome_verification']) && typeof meta0['pending_set_at'] === "string"
            ? meta0['pending_set_at']
            : new Date().toISOString(),
          pending_last_checked_at: pendingCheckedStamp(meta0['pending_outcome_verification'], sha, new Date().toISOString()),
          // Never downgrade a parking disposition: it is what keeps the gap out of admission until a human acts.
          disposition: isParkingDisposition(meta0["disposition"]) ? meta0["disposition"] : "pending_verification",
          pending_note: note,
        },
        status: "open",
      },
    } as never);
  } catch { /* best-effort */ }
}

/** The row that releases a pending_verification hold, built from the gap as the store holds it NOW, or null when
 *  there is nothing to release: the row is gone, no longer open (a reopen would undo a close), or no longer held
 *  pending_verification (a human hold set meanwhile is not the sweep's to lift). The whole fresh row is returned so
 *  top-level keys (reopen_count, first_detected_at, ...) survive the write. A REVERTED landing also clears its
 *  pending_outcome_verification stamp ("" is the cleared convention) and records it as reverted_landing: the stamp
 *  would keep the picker skipping the gap and the sweep re-selecting it every tick. */
export function releasedRow(fresh: Record<string, unknown> | null, why: string, revertedSha?: string): Record<string, unknown> | null {
  if (!fresh || String(fresh.status ?? "") !== "open") return null;
  const lifted = liftLandVerificationHold((fresh.classification_metadata ?? {}) as Record<string, unknown>);
  if (!lifted) return null;
  const meta: Record<string, unknown> = { ...lifted, pending_note: `released: ${why}` };
  if (revertedSha) { meta.pending_outcome_verification = ""; meta.reverted_landing = revertedSha; }
  return { ...fresh, classification_metadata: meta };
}

/** The sweep judged a landing NOT to have resolved its gap: lift the pending_verification hold so admission takes
 *  the gap for another attempt. Decided on a FRESH read, not the sweep's snapshot (releasedRow). */
async function releaseUnresolvedLanding(gap: Record<string, unknown>, why: string, revertedSha?: string): Promise<void> {
  const id = String(gap.id ?? "");
  try {
    const row = releasedRow(await readGapFresh(id), why, revertedSha);
    if (!row) return;
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: row } as never);
    console.warn(`[gap-sweep] released pending_verification on ${id}: ${why}; admitted for another attempt`);
  } catch (e) {
    console.warn(`[gap-sweep] could not release pending_verification on ${id}: ${(e as Error).message}`);
  }
}

// FALSIFIED AUTONOMOUS LANDING (contained-self-development 8.4a). The sweep measured a
// single landing 'present' and did nothing: three autonomous landings on 09-27 left their
// gap's defect in place, two passed the prose judge, and the system recorded none of it — the
// only verdict was the operator's. This records the system's own verdict, without reverting:
// the gap's predicate still reports the defect AFTER the edited vessel restarted onto the
// commit, so the landing did not fix it. Applies only to an attempt intent that says
// directed:false (an intent from before that field, or no Attempt-Id trailer, is not judged).
// The clone holding the commit names the vessel it edited, and its unit start time — not this
// vessel's — says whether the change is running.
let sweepAwaitingRestart = false;
/**
 * A RE-DETECTED GAP IS NOT CLOSED ON A LANDING OLDER THAN THE RE-DETECTION (2026-10-03).
 * performance-inefficiency-execution_traces_list was reopened by the efficiency probe every ~20 min while the
 * list route stayed slow, and the pending-land sweep re-closed it each time landed_verified on the class2
 * source-text check of a 09-30 commit: true since 09-30, blind to the latency the detector had just measured.
 * Every cycle appended another FAVORABLE outcome for that same commit (posterior inflation, 19 in a day).
 * qa's rule: a close of a reopened row counts only if the commit it credits landed AFTER the re-detection
 * (the closer's own evidence run is always after it), or the row's check is a standing row that measures the
 * symptom itself. Otherwise the commit is the fix that did not hold, and nothing closes on it.
 */
export const STALE_EVIDENCE_REASON = "stale_evidence_predates_redetection";
export interface StaleCloseEvidence { reason: typeof STALE_EVIDENCE_REASON; sha: string; committed_at: string | null; redetected_at: string }

/** When the row was last re-detected: the store's reopened_at stamp; for a row reopened before that stamp
 *  existed (reopen_count > 0, no stamp), its detected_at. null for a row that was never reopened. */
export function redetectedAtOf(g: Record<string, unknown>): string | null {
  const ok = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  if (ok(g.reopened_at)) return g.reopened_at;
  if (Number(g.reopen_count ?? 0) > 0 && ok(g.detected_at)) return g.detected_at;
  return null;
}

/** A standing row: the check measures the symptom itself on every run (a self_fact_reconcile row,
 *  REALIGNMENT §2.1), not the source a landing changed, so a clean reading after a reopen is fresh evidence. */
export function checkIsStandingRow(meta: Record<string, unknown>): boolean {
  const er = meta.evidence_resolve as { shape?: unknown } | undefined;
  if (er && typeof er === "object" && er.shape === "self_fact_reconcile") return true;
  return meta.verify_shape === "self_fact_reconcile";
}

/** The committer time (when it landed on the branch) of a commit in any vessel clone, ISO; null when unknown. */
function commitTimeInAnyClone(sha: string): string | null {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git"))) continue;
      const ct = Number(sweepGitOut(dir, ["log", "-1", "--format=%ct", sha]) ?? "");
      if (Number.isFinite(ct) && ct > 0) return new Date(ct * 1000).toISOString();
    }
  } catch { /* no clone tree */ }
  return null;
}

/** Why closing this row on `sha` would be stale, or null when it may close: the row was re-detected, its check
 *  is not a standing row, and the commit did not land after the re-detection (an unknown landing time counts as
 *  not after: nothing proves it). Exported for tests. */
export function staleCloseEvidence(g: Record<string, unknown>, sha: string): StaleCloseEvidence | null {
  const redetectedAt = redetectedAtOf(g);
  if (!redetectedAt) return null;
  if (checkIsStandingRow((g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>)) return null;
  const committedAt = commitTimeInAnyClone(sha);
  if (committedAt !== null && Date.parse(committedAt) > Date.parse(redetectedAt)) return null;
  return { reason: STALE_EVIDENCE_REASON, sha, committed_at: committedAt, redetected_at: redetectedAt };
}

/** The sweep found the stamped landing stale for a reopened row: record why, and stop holding the row on it
 *  (pending_outcome_verification cleared, a pending_verification hold lifted) so the sweep does not re-take it
 *  and the gap is admitted for a landing that can close it. Decided on a FRESH read; open rows only. */
async function releaseStaleLanding(gap: Record<string, unknown>, stale: StaleCloseEvidence): Promise<void> {
  const id = String(gap.id ?? "");
  try {
    const fresh = await readGapFresh(id);
    if (!fresh || String(fresh.status ?? "") !== "open") return;
    const m0 = (fresh.classification_metadata ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {
      ...(liftLandVerificationHold(m0) ?? m0),
      pending_outcome_verification: "",
      stale_landing: stale.sha,
      stale_close_evidence: { ...stale, at: new Date().toISOString() },
      pending_note: `released: ${stale.reason} (landed ${stale.committed_at ?? "at an unknown time"}, re-detected ${stale.redetected_at})`,
    };
    await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...fresh, classification_metadata: meta } } as never);
  } catch (e) {
    console.warn(`[gap-sweep] could not record stale landing on ${id}: ${(e as Error).message}`);
  }
}

/**
 * THE NON-DISCRIMINATING CHECK (diag-s1, 2026-10-10). The independent landing verdict re-runs the gap's own check
 * at the landing's parent and at the landed sha. "parent green, landed green" means the check passed on the tree
 * the landing started from: it never saw the defect, so no re-run of it can ground this landing. The sweep stored
 * that label and, on every later tick, re-read the check at HEAD, skipped the re-run (a stored ungrounded label) and
 * logged "is NOT closed: no grounded independent verdict" for the same landing (the gap that landed c1a1ed7fc986:
 * 48 times in 72 h), holding a sweep slot each time. Only a non-shadow label counts: a shadow label is calibration
 * evidence from a registered verifier, never a verdict. Exported for tests.
 */
export const NON_DISCRIMINATING_CHECK = "non_discriminating_check";
export function nonDiscriminatingLandingLabel(label: GoalVerificationLabel | null | undefined): boolean {
  return !!label && label.grounded === false && label.shadow !== true && typeof label.reason === "string" && label.reason.startsWith("parent green, landed green");
}
/** Whether the row's pending hold was released (pending_released) on this landing. */
export function pendingReleasedFor(meta: Record<string, unknown>, sha: string): boolean {
  const rel = meta.pending_released as { landed?: unknown } | null | undefined;
  const landed = rel && typeof rel === "object" && typeof rel.landed === "string" ? rel.landed.trim() : "";
  const s = String(sha ?? "").trim();
  return landed.length >= 7 && s.length >= 7 && (landed.startsWith(s) || s.startsWith(landed));
}

const nonDiscriminatingEscalated = new Set<string>();
/** Ask a human about a released non-discriminating check, on the needs-human-<gap> panel: the id the answer path
 *  reads (solicitation_outcome_scan, escalation_disposition_apply gapIdFromPanelId), whose non-drop answer clears
 *  needs_information and whose labelled lines (VERIFY_SHAPE:, EDIT_SITE:, EXPECTED_LITERAL:) re-arm the gap. */
function escalateNonDiscriminatingCheck(gapId: string, category: string, summary: string, sha: string, parent: string, checkName: string, ask: Ask): void {
  if (!gapId || nonDiscriminatingEscalated.has(gapId)) return;
  nonDiscriminatingEscalated.add(gapId);
  void ask({ type: "uiQuestion_write", id: "needs-human-" + gapId, title: "Gap's own check does not discriminate — needs a human decision", body: "Gap " + gapId + " (" + category + ") landed " + sha.slice(0, 12) + ", but its own check (" + checkName + ") is GREEN at the landing's parent " + parent.slice(0, 12) + " as well as at the landed sha: it never saw the defect, so it cannot say whether the landing fixed anything. The gap is released from pending verification (not closed) and parked needs_information. Please answer: redefine the goal, provide missing information (a line VERIFY_SHAPE: <shape>, EDIT_SITE: repos/<vessel>/src/... or EXPECTED_LITERAL: <text> re-arms it with a check that sees the defect), grant access, or drop it. Summary: " + summary.slice(0, 300), kind: "gap_needs_human", importance: "medium" } as never)
    .then((r) => {
      const shape = (r as { shape?: unknown } | undefined)?.shape;
      if (shape === "structuredError") console.warn(`[gap-escalation] non-discriminating-check uiQuestion_write REJECTED for ${gapId} — no human was asked`);
      else console.log(`[gap-escalation] non-discriminating-check uiQuestion_write accepted for ${gapId} (shape=${String(shape)})`);
    })
    .catch((e: unknown) => console.warn(`[gap-escalation] non-discriminating-check uiQuestion_write THREW for ${gapId}: ${String(e)} — no human was asked`));
}

/** Release the pending hold of a landing whose check does not discriminate (nonDiscriminatingLandingLabel), on a
 *  FRESH read, open rows only. NOT a close and no outcome is appended: pending_outcome_verification is cleared ("",
 *  the store's cleared convention) so the sweep stops re-selecting the gap; pending_released names the check and the
 *  landing; the disposition parks it needs_information (admission holds it, a human answer clears it), never ""
 *  (re-admitted, compose would refuse it green-on-parent every cooldown). A landing held for operator review stays
 *  as it is. true when the release was written. */
async function releaseNonDiscriminatingCheck(gap: Record<string, unknown>, sha: string, label: GoalVerificationLabel, ask: Ask): Promise<boolean> {
  const id = String(gap.id ?? "");
  try {
    const fresh = await readGapFresh(id);
    if (!fresh || String(fresh.status ?? "") !== "open") return false;
    const m0 = (fresh.classification_metadata ?? {}) as Record<string, unknown>;
    if (m0.disposition === "awaiting_operator_review") return false;
    const er = (m0.evidence_resolve ?? null) as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown } } | null;
    const check = {
      shape: typeof er?.shape === "string" ? er.shape : null,
      vessel: typeof er?.input?.vessel === "string" ? er.input.vessel : null,
      test_file: typeof er?.input?.test_file === "string" ? er.input.test_file : null,
      tests: Array.isArray(label.tests) ? label.tests : [],
    };
    const checkName = [check.vessel, check.test_file].filter(Boolean).join("/") || check.shape || "its check";
    const at = new Date().toISOString();
    const meta: Record<string, unknown> = {
      ...m0,
      goal_verification_label: label,
      pending_outcome_verification: "",
      disposition: isParkingDisposition(m0.disposition) ? m0.disposition : "needs_information",
      pending_released: { reason: NON_DISCRIMINATING_CHECK, check, landed: sha, parent: label.parent, label_reason: label.reason ?? null, at },
      pending_note: `released: ${NON_DISCRIMINATING_CHECK}: ${checkName} is green at parent ${String(label.parent ?? "").slice(0, 12)} and at landed ${sha.slice(0, 12)}`,
    };
    const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...fresh, classification_metadata: meta } } as never);
    if (w?.shape === "structuredError" || (w?.body as { action?: unknown } | undefined)?.action === "skipped") {
      console.warn(`[gap-sweep] could not release pending_verification on ${id} (${NON_DISCRIMINATING_CHECK}): write ${w?.shape === "structuredError" ? "refused" : "skipped"}`);
      return false;
    }
    console.warn(`[gap-sweep] released pending_verification on ${id}: ${NON_DISCRIMINATING_CHECK} (${checkName} green at parent ${String(label.parent ?? "").slice(0, 12)} and at landed ${sha.slice(0, 12)}); not closed, parked ${String(meta.disposition)}, a human is asked`);
    escalateNonDiscriminatingCheck(id, String(fresh.category ?? "?"), String(fresh.summary ?? ""), sha, String(label.parent ?? ""), checkName, ask);
    return true;
  } catch (e) {
    console.warn(`[gap-sweep] could not release pending_verification on ${id} (${NON_DISCRIMINATING_CHECK}): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Did the landing edit its own check? When a class2 test_suite check's test file, or any path recorded in
 * check_inputs, is in the landed commit's diff, a passing verdict certifies nothing: the landing wrote the
 * thing that judges it. Observed 09-29/30: concept-db f705b61 and activity-api 0f96c62 were closed
 * landed_verified by the tests they had just edited. Returns the offending repos/<vessel>/ paths, or []
 * when the gap names no check input or the commit is in no clone.
 */
function selfAuthoredCheckInputs(gap: Record<string, unknown>, sha: string): string[] {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const inputs = new Set<string>();
  if (Array.isArray(meta.check_inputs)) for (const p of meta.check_inputs) if (typeof p === "string" && p) inputs.add(p.replace(/^\/+/, ""));
  const subject = checkInstrumentSubject(meta);
  if (subject && subject.vessel) inputs.add(`repos/${subject.vessel}/${subject.testFile}`);
  if (inputs.size === 0 || !sha) return [];
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) continue;
      const touched = (sweepGitOut(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? "").split("\n").filter(Boolean);
      return touched.map((f) => `repos/${name}/${f}`).filter((f) => inputs.has(f));
    }
    console.warn(`[gap-verify] cannot judge self-authorship for ${String(gap.id ?? "?")}: ${sha.slice(0, 12)} is in no vessel clone`);
  } catch (e) {
    console.warn(`[gap-verify] cannot judge self-authorship for ${String(gap.id ?? "?")}: ${(e as Error).message}`);
  }
  return [];
}

/**
 * A landing whose check it edited itself leaves the gap open with disposition awaiting_operator_review and
 * the landed sha still pending, so the picker does not re-compose it and the sweep skips it cheaply. The
 * resolution is an operator's recorded verdict (verified_by_operator_review, or a regression).
 */
async function markAwaitingOperatorReview(gap: Record<string, unknown>, sha: string, files: string[]): Promise<void> {
  try {
    const id = String(gap.id ?? "");
    if (!id) return;
    const meta0 = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    await resolveSubstrateGapWrite({
      type: "substrateGap_write",
      gap: {
        id, category: gap.category, source: gap.source, summary: gap.summary, detected_at: gap.detected_at,
        classification_metadata: {
          ...meta0,
          pending_outcome_verification: sha || meta0["pending_outcome_verification"] || "unknown",
          pending_set_at: sha === meta0["pending_outcome_verification"] && typeof meta0["pending_set_at"] === "string" ? meta0["pending_set_at"] : now,
          disposition: "awaiting_operator_review",
          self_authored_check: { sha, files, at: now },
        },
        status: "open",
      },
    } as never);
  } catch (e) {
    console.warn(`[gap-verify] could not mark ${String(gap.id ?? "?")} awaiting operator review: ${(e as Error).message}`);
  }
}

/**
 * THE PINNED RE-RUN behind the independent landing verdict: the landing's parent (from the vessel clone holding
 * it) and the gap's own check judged by THE ONE JUDGE (evaluateGapCheck) with test_suite's base_ref, which runs
 * it in a detached worktree of that commit (test-suite.ts BASE-TREE RUN). Injectable for tests only.
 */
export type PinnedCheckDeps = {
  parentOf: (sha: string) => string | null;
  runAt: (gap: Record<string, unknown>, ref: string) => Promise<GapCheckVerdict>;
  /** A registered producer of pinnedCheckVerdict for a non-test_suite check kind (default: discovery). */
  verifierFor?: (kind: string) => Promise<RegisteredVerifier | null>;
  /** The files the landing changed (parent..sha), or null when they cannot be read (default: the vessel clone). */
  changedFiles?: (sha: string, parent: string) => string[] | null;
  /** A vessel-relative file's content at a commit, or null when absent (default: `git show` in the vessel clone). */
  readAt?: (ref: string, path: string) => string | null;
};
/**
 * A REGISTERED VERIFIER: a producer of shape `pinnedCheckVerdict` for one check kind (the gap's
 * evidence_resolve.shape). Its descriptor is what it says about itself; the three trust rules below decide whether
 * the evaluator believes its answers. `run` judges the check at a commit-pinned ref.
 */
export type VerifierDescriptor = {
  id: string; version: string; kind: string;
  /** Repo-relative paths of the verifier's own source (independence: the landing must not touch them). */
  source_paths: string[];
  lineage?: { authored_sha?: string; registered_by_gap?: string };
  /** A check and ref on which the verifier MUST read red (present): run in every verdict pass. */
  must_fail?: { check: Record<string, unknown>; ref: string };
};
export type RegisteredVerifier = {
  descriptor: VerifierDescriptor;
  run: (check: Record<string, unknown>, ref: string) => Promise<{ verdict: GapCheckVerdict; verifier: { id: string; version: string } }>;
};
const defaultPinnedCheckDeps: PinnedCheckDeps = {
  parentOf: (sha) => {
    try {
      for (const name of readdirSync(vesselsCloneRoot()).sort()) {
        const dir = join(vesselsCloneRoot(), name);
        if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) continue;
        const p = sweepGitOut(dir, ["rev-parse", "--verify", "--quiet", `${sha}^`]);
        return p && /^[0-9a-f]{40}$/.test(p) ? p : null;
      }
    } catch { /* unreadable clone root: no parent */ }
    return null;
  },
  runAt: (gap, ref) => {
    const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
    const er = meta.evidence_resolve as { input?: Record<string, unknown> } & Record<string, unknown>;
    // Only the pinned check: a class-1 literal on the same row would be read from the runtime file at HEAD for both refs.
    const { hardcoded_url: _u, expected_literal: _l, ...pinnedMeta } = meta;
    return evaluateGapCheck({ ...gap, classification_metadata: { ...pinnedMeta, evidence_resolve: { ...er, input: { ...(er.input ?? {}), base_ref: ref } } } });
  },
  verifierFor: (kind) => defaultVerifierFor(kind),
  changedFiles: (sha, parent) => defaultChangedFiles(sha, parent),
  readAt: (ref, path) => defaultReadAt(ref, path),
};
// The default registry read: own-substrate producers of pinnedCheckVerdict, asked to describe the kind; the first
// that answers with a descriptor for it is used. Answers travel as {body:{...}} resolve envelopes.
const PINNED_VERDICT_SHAPE = "pinnedCheckVerdict";
async function defaultVerifierFor(kind: string): Promise<RegisteredVerifier | null> {
  const own = await discoverOwnResolveUrls(PINNED_VERDICT_SHAPE);
  if (!own.ok) return null;
  for (const url of own.urls) {
    const res = await postEnvelopeRead(url, { impulse: { type: PINNED_VERDICT_SHAPE, op: "describe", kind } });
    const d = ((res?.["body"] ?? res) as { verifier?: VerifierDescriptor } | null)?.verifier;
    if (!d || d.kind !== kind || typeof d.id !== "string" || typeof d.version !== "string") continue;
    return {
      descriptor: d,
      run: async (check, ref) => {
        const r = await postEnvelopeRead(url, { impulse: { type: PINNED_VERDICT_SHAPE, kind, check, ref } });
        const b = (r?.["body"] ?? r) as { verdict?: unknown; verifier?: { id?: unknown; version?: unknown } } | null;
        const v = b?.verdict;
        return {
          verdict: v === "present" || v === "absent" || v === "pending" ? v : "unknown",
          verifier: { id: String(b?.verifier?.id ?? ""), version: String(b?.verifier?.version ?? "") },
        };
      },
    };
  }
  return null;
}
function defaultChangedFiles(sha: string, parent: string): string[] | null {
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) continue;
      const out = sweepGitOut(dir, ["diff", "--name-only", parent, sha]);
      if (out === null) return null;
      // Repo-relative to the vessel; verifier source paths are named super-repo style (repos/<vessel>/...).
      return out.split("\n").map((f) => f.trim()).filter((f) => f.length > 0).flatMap((f) => [f, `repos/${name}/${f}`]);
    }
  } catch { /* unreadable clone root */ }
  return null;
}
function defaultReadAt(ref: string, path: string): string | null {
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (!existsSync(join(dir, ".git")) || sweepGitOut(dir, ["merge-base", "--is-ancestor", ref, "HEAD"]) === null) continue;
      return sweepGitOut(dir, ["show", `${ref}:${path}`]);
    }
  } catch { /* unreadable clone root */ }
  return null;
}

const CLOSURE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const CLOSURE_MAX_FILES = 200;
/**
 * THE CHECK'S OWN SURROUNDINGS: the check file plus every NON-src file it reaches through relative imports, read at
 * `ref` (the parent: what the armed check depended on). src/ is excluded because that is where a fix belongs; a
 * helper, fixture, mock or other test the check imports is part of the instrument. Resolution follows TS ESM
 * conventions (an import of ./x.js is ./x.ts). Bounded; a file that cannot be read is simply not followed.
 */
export function checkInstrumentClosure(testFile: string, ref: string, readAt: (ref: string, path: string) => string | null): string[] {
  const norm = (p: string): string => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop(); else out.push(seg);
    }
    return out.join("/");
  };
  const candidates = (spec: string): string[] => {
    const bare = spec.replace(/\.(?:[cm]?js|jsx)$/, "");
    return [spec, `${bare}.ts`, `${bare}.tsx`, `${bare}.js`, `${bare}.mjs`, `${bare}.json`, `${bare}/index.ts`, `${bare}/index.js`];
  };
  const seen = new Set<string>([testFile]);
  const queue = [testFile];
  while (queue.length > 0 && seen.size < CLOSURE_MAX_FILES) {
    const file = queue.shift()!;
    const src = readAt(ref, file);
    if (src === null) continue;
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    for (const m of src.matchAll(CLOSURE_IMPORT_RE)) {
      for (const cand of candidates(norm(`${dir}/${m[1]}`))) {
        if (cand.startsWith("src/")) break; // the fix's territory, never part of the instrument
        if (seen.has(cand)) break;
        if (readAt(ref, cand) === null) continue;
        seen.add(cand);
        queue.push(cand);
        break;
      }
    }
  }
  return [...seen];
}

/** The gap's test_suite check as one normalized subject, for every reader of its instrument: the bare vessel name
 *  (gap-check-supply writes "repos/<v>") and the vessel-relative test_file (no leading '/', no "repos/<v>/").
 *  null when the check is not a test_suite naming a test_file. */
function checkInstrumentSubject(meta: Record<string, unknown>): { vessel: string; testFile: string } | null {
  const er = meta.evidence_resolve as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown } } | null | undefined;
  if (!er || er.shape !== "test_suite" || typeof er.input?.test_file !== "string") return null;
  const testFile = er.input.test_file.replace(/^\/+/, "").replace(/^repos\/[^/]+\//, "");
  if (!testFile) return null;
  return { vessel: typeof er.input.vessel === "string" ? er.input.vessel.replace(/^repos\//, "") : "", testFile };
}
/** THE CHECK'S INSTRUMENT at `ref` (vessel-relative): its test_file plus its non-src import closure. [] when the gap's
 *  check is not a test_suite with a test_file. The one definition the independent verdict's guard and
 *  fixingCommitSinceBirth share: a change to any of these files changes the judge, not the judged. */
function checkInstrumentSet(meta: Record<string, unknown>, ref: string, readAt: (ref: string, path: string) => string | null): string[] {
  const subject = checkInstrumentSubject(meta);
  return subject ? checkInstrumentClosure(subject.testFile, ref, readAt) : [];
}
/** Tests only. */
export const __selfAuthoredCheckInputsForTests = (gap: Record<string, unknown>, sha: string): string[] => selfAuthoredCheckInputs(gap, sha);

let pinnedCheckDeps: PinnedCheckDeps | null = null;
/** Tests only: replace the pinned re-run (null restores the default). */
export function __setPinnedCheckForTests(d: PinnedCheckDeps | null): void { pinnedCheckDeps = d; }

/**
 * Re-run the gap's OWN check (classification_metadata.evidence_resolve, shape test_suite) at the landing's parent
 * and at the landed sha. Red at parent AND green at sha => a grounded label; a deterministic other outcome => an
 * ungrounded label (recorded, so it is not re-run every tick); FAIL CLOSED otherwise: no test_suite check, no
 * parent, a run that throws or cannot judge => no label. The lander's own evidence on the row is never read.
 */
export async function independentLandingVerdict(gap: Record<string, unknown>, sha: string, deps: PinnedCheckDeps = pinnedCheckDeps ?? defaultPinnedCheckDeps): Promise<{ label: GoalVerificationLabel | null; reason: string }> {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const er = meta.evidence_resolve as { shape?: unknown; input?: unknown } | null | undefined;
  if (er && typeof er === "object" && typeof er.shape === "string" && er.shape.length > 0 && er.shape !== "test_suite" && er.input && typeof er.input === "object") {
    return registeredLandingVerdict(gap, er.shape, er.input as Record<string, unknown>, sha, deps);
  }
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || !er.input || typeof er.input !== "object") {
    return { label: null, reason: "the gap's check is not a test_suite evidence_resolve, so it cannot be re-run on a commit-pinned tree" };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { label: null, reason: "the landed sha is not a commit id" };
  const input = er.input as { test_file?: unknown; only_tests?: unknown };
  const named = Array.isArray(input.only_tests) ? input.only_tests.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  const tests = named.length > 0 ? named : typeof input.test_file === "string" ? [input.test_file] : [];
  let parent: string | null = null;
  try { parent = deps.parentOf(sha); } catch { parent = null; }
  if (!parent) return { label: null, reason: `no parent found for ${sha.slice(0, 12)} in any vessel clone` };
  // THE LANDING MUST NOT TOUCH ITS OWN INSTRUMENT. The landed-sha run below uses the LANDED copy of the check, so a
  // landing that weakens the check file, or a helper, fixture or mock it imports, would ground itself. Read the
  // landing's changed files and the check's non-src import closure at the parent; if they meet, the label is
  // ungrounded (recorded, so it is not re-run). Changed files that cannot be read: no label, fail closed. Injected
  // deps without changedFiles (tests of the run seam alone) are not judged here; the default deps always are.
  if (deps.changedFiles) {
    let changed: string[] | null = null;
    try { changed = deps.changedFiles(sha, parent); } catch { changed = null; }
    if (changed === null) return { label: null, reason: `the landing's changed files cannot be read (${parent.slice(0, 12)}..${sha.slice(0, 12)}), so a landing that edits its own check cannot be ruled out` };
    const instrument = checkInstrumentSet(meta, parent, deps.readAt ?? ((ref, path) => defaultReadAt(ref, path)));
    const changedSet = new Set(changed.map((f) => f.replace(/^repos\/[^/]+\//, "")));
    const touched = instrument.filter((f) => changedSet.has(f));
    if (touched.length > 0) {
      const reason = `the landing modified its own check: ${touched.slice(0, 5).join(", ")} (the check's file or what it imports outside src/), so its red->green cannot certify the landing`;
      return { label: { grounded: false, labeler: LANDING_LABELER, sha, parent, tests, ran_at: new Date().toISOString(), reason }, reason };
    }
  }
  let atParent: GapCheckVerdict;
  let atSha: GapCheckVerdict;
  try {
    atParent = await deps.runAt(gap, parent);
    atSha = await deps.runAt(gap, sha);
  } catch (err) {
    return { label: null, reason: `the pinned re-run failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
  }
  const judged = (v: GapCheckVerdict) => v === "present" || v === "absent";
  if (!judged(atParent) || !judged(atSha)) return { label: null, reason: `the pinned re-run could not judge (parent ${atParent}, landed ${atSha})` };
  const grounded = atParent === "present" && atSha === "absent";
  const reason = grounded ? "red at parent, green at the landed sha" : `parent ${atParent === "present" ? "red" : "green"}, landed ${atSha === "present" ? "red" : "green"}: the landing did not flip its own check`;
  return { label: { grounded, labeler: LANDING_LABELER, sha, parent, tests, ran_at: new Date().toISOString(), ...(grounded ? {} : { reason }) }, reason };
}

/**
 * THE SHAPE-OPEN VERDICT: a non-test_suite check is judged by a REGISTERED producer of pinnedCheckVerdict for its
 * kind, at the landing's parent and at the landed sha. The evaluator keeps exactly three trust rules over whatever
 * verifier it finds, and any refusal is NO label (the close waits; never a pass):
 *   1. INDEPENDENCE: not from the lander's lineage. The landing's changed files must not include the verifier's
 *      source, the verifier must not be authored in the landed commit, and it must not be registered for this gap or
 *      its parent/root. Changed files that cannot be read fail closed.
 *   2. CAN-FAIL: the verifier declares a must-fail control, and the control, RUN IN THIS PASS, reads red (present).
 *      A declared control is never taken on the verifier's word.
 *   3. SAME INSTRUMENT: the described verifier id+version answered at the control, the parent and the landing.
 */
export async function registeredLandingVerdict(gap: Record<string, unknown>, kind: string, check: Record<string, unknown>, sha: string, deps: PinnedCheckDeps): Promise<{ label: GoalVerificationLabel | null; reason: string }> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { label: null, reason: "the landed sha is not a commit id" };
  let reg: RegisteredVerifier | null = null;
  try { reg = deps.verifierFor ? await deps.verifierFor(kind) : null; } catch { reg = null; }
  if (!reg) return { label: null, reason: `no registered pinnedCheckVerdict producer for check kind '${kind}': awaiting an independent verifier` };
  const d = reg.descriptor;
  let parent: string | null = null;
  try { parent = deps.parentOf(sha); } catch { parent = null; }
  if (!parent) return { label: null, reason: `no parent found for ${sha.slice(0, 12)} in any vessel clone` };
  // 1. independence
  const lineageRefusal = verifierLineageRefusal(gap, d, sha, (() => { try { return deps.changedFiles ? deps.changedFiles(sha, parent!) : null; } catch { return null; } })());
  if (lineageRefusal) return { label: null, reason: `verifier ${d.id}@${d.version} refused (lineage): ${lineageRefusal}` };
  // 2. can-fail
  if (!d.must_fail || typeof d.must_fail !== "object" || !d.must_fail.check || typeof d.must_fail.ref !== "string" || d.must_fail.ref.length === 0) {
    return { label: null, reason: `verifier ${d.id}@${d.version} refused: it declares no must-fail control, so it cannot be shown to fail` };
  }
  const same = (v: { id: string; version: string }) => v.id === d.id && v.version === d.version;
  let control: Awaited<ReturnType<RegisteredVerifier["run"]>>;
  let atParent: Awaited<ReturnType<RegisteredVerifier["run"]>>;
  let atSha: Awaited<ReturnType<RegisteredVerifier["run"]>>;
  try {
    control = await reg.run(d.must_fail.check, d.must_fail.ref);
    if (control.verdict !== "present") return { label: null, reason: `verifier ${d.id}@${d.version} refused: its must-fail control read ${control.verdict} in this pass (must read red)` };
    atParent = await reg.run(check, parent);
    atSha = await reg.run(check, sha);
  } catch (err) {
    return { label: null, reason: `the registered verifier failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
  }
  // 3. same instrument
  if (!same(control.verifier) || !same(atParent.verifier) || !same(atSha.verifier)) {
    return { label: null, reason: `verifier ${d.id}@${d.version} refused: not the same instrument at every ref (control ${control.verifier.id}@${control.verifier.version}, parent ${atParent.verifier.id}@${atParent.verifier.version}, landed ${atSha.verifier.id}@${atSha.verifier.version})` };
  }
  const judged = (v: GapCheckVerdict) => v === "present" || v === "absent";
  if (!judged(atParent.verdict) || !judged(atSha.verdict)) return { label: null, reason: `the registered verifier could not judge (parent ${atParent.verdict}, landed ${atSha.verdict})` };
  const wouldGround = atParent.verdict === "present" && atSha.verdict === "absent";
  // SHADOW (qa 10-05): the three rules above rest on the verifier's self-report (source paths, lineage, id/version)
  // and on a control it chose, so a lane-authored verifier could satisfy them all. Until the evaluator derives the
  // verifier's identity and lineage itself and picks the control blind, a registered verifier's verdict is
  // CALIBRATION EVIDENCE only: recorded with grounded forced false and shadow:true, never a close.
  const flipped = wouldGround ? `red at parent, green at the landed sha (verifier ${d.id}@${d.version})` : `parent ${atParent.verdict === "present" ? "red" : "green"}, landed ${atSha.verdict === "present" ? "red" : "green"}: the landing did not flip its own check`;
  const reason = `shadow verdict, never a close: ${flipped}`;
  return {
    label: {
      grounded: false, shadow: true, labeler: LANDING_LABELER, sha, parent, tests: [],
      ran_at: new Date().toISOString(),
      verifier: { id: d.id, version: d.version, kind, control: { ref: d.must_fail.ref, verdict: control.verdict }, observed: { parent: atParent.verdict, landed: atSha.verdict, would_ground: wouldGround } },
      reason,
    },
    reason,
  };
}
/** Rule 1 (independence): a reason the verifier is from the lander's lineage, or null when it is not. */
export function verifierLineageRefusal(gap: Record<string, unknown>, d: VerifierDescriptor, sha: string, changed: string[] | null): string | null {
  if (!Array.isArray(d.source_paths) || d.source_paths.length === 0) return "it names no source paths, so the landing's reach into it cannot be judged";
  if (changed === null) return "the landing's changed files could not be read, so independence cannot be judged";
  const touched = d.source_paths.filter((p) => changed.includes(p));
  if (touched.length > 0) return `the landing changed its source (${touched.join(", ")})`;
  const authored = String(d.lineage?.authored_sha ?? "").trim();
  if (authored.length >= 7 && (sha.startsWith(authored) || authored.startsWith(sha))) return `it was authored in the landed commit ${authored.slice(0, 12)}`;
  const by = String(d.lineage?.registered_by_gap ?? "").trim();
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const lineageIds = [gap.id, gap.parent_gap_id, gap.root_gap_id, gap.same_root_as, meta.parent_gap_id, meta.root_gap_id, meta.same_root_as].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (by.length > 0 && lineageIds.includes(by)) return `it was registered for this gap's lineage (${by})`;
  return null;
}

/**
 * Is the landed commit RUNNING on this node? A measured 'absent' read from this node's runtime file is
 * evidence only if this node actually serves the vessel on that code: on 2026-09-29 node 2 closed a gap
 * landed_verified for activity-api, which node 2 does not run, while node 1 still served the old code.
 * 'running' also covers a commit in no vessel clone (e.g. the super-repo), where this cannot be judged.
 */
async function landedCommitRunningHere(sha: string): Promise<"running" | "not served here" | "awaiting restart"> {
  let vessel: string | null = null;
  let cloneDir = "";
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (existsSync(join(dir, ".git")) && sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null) { vessel = name; cloneDir = dir; break; }
    }
  } catch { return "running"; }
  if (!vessel) return "running";
  // A commit that touches only test files never reaches the runtime (pull-sync mirrors src/ sql/
  // scripts/ and does not restart for it), so waiting for a restart would hold its gap open
  // forever. Its check (a test_suite run) reads the clone, which the loop above proved contains it.
  const touched = (sweepGitOut(cloneDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? "").split("\n").filter(Boolean);
  if (touched.length > 0 && touched.every((f) => /^tests?\//.test(f))) return "running";
  let active = "";
  let startedAt = 0;
  try {
    active = new TextDecoder().decode(Bun.spawnSync(["systemctl", "is-active", vessel], { stdout: "pipe", stderr: "pipe", timeout: 5_000 }).stdout).trim();
    const p = Bun.spawnSync(["systemctl", "show", vessel, "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const m = new TextDecoder().decode(p.stdout).trim().match(/^@(\d+)$/);
    startedAt = m ? Number(m[1]) : 0;
  } catch { return "awaiting restart"; }
  if (active !== "active") return "not served here";
  const committedAt = Number(sweepGitOut(cloneDir, ["log", "-1", "--format=%ct", sha]) ?? "0");
  if (!startedAt || !committedAt || startedAt <= committedAt) return "awaiting restart";
  const { selfRestartAlreadyOwed } = await import("../resolvers/vessel-mitosis-cutover.js");
  if (selfRestartAlreadyOwed(vessel)) return "awaiting restart";
  return "running";
}

/** The catch for a dissent-outcome write: logged, never fatal to the sweep (calibration loses one sample). */
function dissentOutcomeUnwritten(gapId: string, result: "passed" | "failed"): (err: unknown) => number {
  return (err) => {
    console.warn(`[gap-sweep] gap ${gapId}: semantic-dissent outcome '${result}' NOT written (${(err as Error)?.message ?? String(err)})`);
    return 0;
  };
}

async function recordFalsifiedAutonomousLanding(g: Record<string, unknown>, meta: Record<string, unknown>, sha: string): Promise<"recorded" | "awaiting_restart" | "not_applicable"> {
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return "not_applicable";
  if (meta.predicate_source === "removed_line_of_landing_commit") return "not_applicable";
  let vessel: string | null = null;
  let cloneDir = "";
  try {
    for (const name of readdirSync(vesselsCloneRoot()).sort()) {
      const dir = join(vesselsCloneRoot(), name);
      if (existsSync(join(dir, ".git")) && sweepGitOut(dir, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null) { vessel = name; cloneDir = dir; break; }
    }
  } catch { return "not_applicable"; }
  if (!vessel) return "not_applicable";
  const attemptId = sweepGitOut(cloneDir, ["log", "-1", "--format=%(trailers:key=Attempt-Id,valueonly)", sha]) ?? "";
  if (!attemptId) return "not_applicable";
  const { readRecords, appendRecord } = await import("../resolvers/attempt-ledger.js");
  const intent = ((await readRecords("attemptIntent", { key: attemptId }))[0]?.record ?? null) as { directed?: unknown; decision_id?: unknown } | null;
  if (!intent || intent.directed !== false) return "not_applicable";
  const committedAt = Number(sweepGitOut(cloneDir, ["log", "-1", "--format=%ct", sha]) ?? "0");
  // Through the auto-revert seam (systemctl show in production), so a fixture can say when the unit restarted.
  const startedAt = autoRevertDeps.unitStartedAt(vessel);
  if (!startedAt || !committedAt) return "not_applicable";
  const { selfRestartAlreadyOwed } = await import("../resolvers/vessel-mitosis-cutover.js");
  if (startedAt <= committedAt || selfRestartAlreadyOwed(vessel)) return "awaiting_restart";
  const at = new Date().toISOString();
  await autoRevertDeps.writeGap({
    id: String(g.id), category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: "open",
    classification_metadata: { ...meta, regressed_by: { sha, at, verdict: "present", attempt_id: attemptId, vessel, revert_sha: null, by: "gap-sweep:falsified_after_restart" } },
  });
  // The gap store can drop the stamp above (lost-update race, filed), so the next sweep may land here
  // again for the same landing. The local ledger is durable: its #2 settlement is the once-only marker.
  const alreadySettled = (await readRecords("attemptSettlement", { key: `${attemptId}#2` })).length > 0;
  if (!alreadySettled) {
    joinDecisionOutcome(meta, { landed: true, verdict: "UNFAVORABLE", commit: sha, falsified_after_restart: true }, typeof intent.decision_id === "string" && intent.decision_id ? { decision_id: intent.decision_id } : {});
    updateClassPosterior(gapClassOf(g), false);
    await appendRecord("attemptSettlement", `${attemptId}#2`, { attempt_id: attemptId, settlement_seq: 2, verdict: "regressed", credit_eligible: false, shas: [sha], gap_id: String(g.id), source: "falsified_after_restart", at });
  }
  console.warn(`[gap-sweep] FALSIFIED autonomous landing gap=${String(g.id)} sha=${sha.slice(0, 12)} vessel=${vessel} attempt=${attemptId} — its predicate still reports the defect after ${vessel} restarted onto it; recorded regressed_by, held from re-pick until reverted`);
  return "recorded";
}

// OPERATOR REGRESSIONS REACH THE LEARNING PATH (contained-self-development 8.20). On 09-28 four
// autonomous landings passed their own check (three were even closed landed_verified) and were reverted
// by the operator. The only trace was regressed_by on the gap, read by the picker hold alone: the
// settlement stayed `held`, the posterior counted a success and no lesson reached the drafter. This
// feeds that verdict, once, into the same records a falsified landing writes. Acts only on the node
// that registered the attempt (the ledger is node-local).
async function recordOperatorRegression(g: Record<string, unknown>): Promise<boolean> {
  const meta = { ...((g.classification_metadata ?? {}) as Record<string, unknown>) };
  const rb = meta.regressed_by as { sha?: unknown; attempt_id?: unknown; revert_sha?: unknown; by?: unknown; reason?: unknown; learned_at?: unknown } | null | undefined;
  if (!rb || typeof rb !== "object" || !rb.revert_sha || !rb.attempt_id || rb.learned_at) return false;
  if (String(rb.by ?? "").startsWith("gap-sweep")) return false;
  const attemptId = String(rb.attempt_id);
  const { readRecords, appendRecord } = await import("../resolvers/attempt-ledger.js");
  const regIntent = (await readRecords("attemptIntent", { key: attemptId }))[0]?.record as { decision_id?: unknown } | undefined;
  if (!regIntent) return false;
  const at = new Date().toISOString();
  const sha = String(rb.sha ?? "");
  if ((await readRecords("attemptSettlement", { key: `${attemptId}#2` })).length === 0) {
    joinDecisionOutcome(meta, { landed: true, verdict: "UNFAVORABLE", commit: sha, reverted_by: String(rb.revert_sha), operator_regression: true }, typeof regIntent.decision_id === "string" && regIntent.decision_id ? { decision_id: regIntent.decision_id } : {});
    updateClassPosterior(gapClassOf(g), false);
    await appendRecord("attemptSettlement", `${attemptId}#2`, { attempt_id: attemptId, settlement_seq: 2, verdict: "regressed", credit_eligible: false, shas: [sha], gap_id: String(g.id), source: "operator_revert", reverted_by: String(rb.revert_sha), at });
  }
  const lessons = Array.isArray(meta.failure_lessons) ? [...(meta.failure_lessons as unknown[])] : [];
  if (!lessons.some((l) => (l as { attempt_id?: unknown; class?: unknown }).attempt_id === attemptId && (l as { class?: unknown }).class === "attempt_consequence")) {
    lessons.push({ class: "attempt_consequence", reason: `<${attemptId}> landed <${sha.slice(0, 12)}> and was reverted by <${String(rb.revert_sha).slice(0, 12)}>: ${String(rb.reason ?? "judged a regression by the operator").slice(0, 400)}`, at, attempt_id: attemptId });
  }
  await resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id: String(g.id), category: g.category, source: g.source, summary: g.summary, detected_at: g.detected_at, status: g.status ?? "open", classification_metadata: { ...meta, failure_lessons: lessons, regressed_by: { ...rb, learned_at: at } } },
  } as never);
  console.warn(`[gap-sweep] OPERATOR REGRESSION learned gap=${String(g.id)} sha=${sha.slice(0, 12)} attempt=${attemptId} reverted_by=${String(rb.revert_sha).slice(0, 12)} — settlement regressed, posterior miss, lesson written`);
  return true;
}

// ── AUTO-REVERT (contained-self-development 8.3 / 8.4 / 8.6) ─────────────────────────────────────────────
/**
 * A REGRESSED LANE LANDING IS REVERTED, ONCE, BY THE LANE (REALIGNMENT §7 step 5). A falsified landing was
 * recorded (regressed_by on the gap, a #2 regressed settlement) and held from re-pick "until reverted", and nothing
 * reverted it: 0 auto-reverts ever, four falsified shas still ancestors of origin/dev 11-12 days on.
 *
 * The trigger is the LOCAL LEDGER's regressed settlement (#1 from the attempt sweep, #2 falsified_after_restart from
 * the pending-land sweep), never the gap stamp: the store drops writes (8.4b) and the ledger does not. The ledger is
 * node-local, so a node reverts only landings whose attempt it registered, and two nodes never revert one sha. A
 * settlement of an attempt the operator already reverted (an operator_revert #2) is not a candidate.
 *
 * Guards, in order; each refusal is one `[auto-revert]` line and a counter, never a throw and never a row change:
 *   1. well-formed: sha hex, attempt id in the ledger's form, the sha a commit in HEAD of a vessel clone, and the gap
 *      row's regressed_by stamp, when there is one, naming this sha, attempt and an existing clone, written by the
 *      falsified sweep and not yet reverted. A literal-template row (the leaked `g.id` / "sha" / "attemptId" /
 *      "vessel") reads skipped=malformed and is left as it is.
 *   2. owned and autonomous: a local attemptIntent with directed === false exactly (absent or unknown is not
 *      autonomous) and a route that is not auto_revert. Author identity cannot separate the two: operator
 *      exact-edits are committed as Substrate Autonomous too.
 *   3. the commit is a lane landing (substrate-authored:, the same Attempt-Id trailer) and not itself a revert.
 *   4. fresh: the settlement is younger than AUTO_REVERT_MAX_AGE_MS.
 *   5. not already reverted: a live clone check (shaWasRevertedInAnyClone), which also completes the gap's
 *      revert_sha and turns a pending marker done (a self-revert of development-vessel that landed and restarted
 *      before writing done).
 *   6. one revert per landing: the ledger's attemptRevert marker, written pending BEFORE the cutover. A pending
 *      older than the cutover lease TTL with no revert in any clone is escalated once (stuck), never re-attempted.
 *   7. strike limit (8.6): AUTO_REVERT_STRIKE_LIMIT done reverts on one gap put it under operator_hold, a hold
 *      record with a lift condition and a review_by (AUTO_REVERT_HOLD_REVIEW_MS), and nothing more is reverted.
 *   8. scope: no reverted file is inside the autonomy scope's exclusions; one that is is escalated, not reverted.
 *      (The cutover's own autonomy-scope chokepoint refuses it too: a revert is undirected.)
 * Thresholds are tuning rows read through activity-api; an absent or unreadable row refuses (skipped=no_tuning_row).
 * The revert itself is vessel-mitosis-cutover.ts REVERT_OF: the same chokepoint, lease and precutover suite as
 * any landing. After it lands the gap's regressed_by carries revert_sha, which lifts the picker hold and lets the
 * pending-land sweep release the gap for another attempt.
 */
export type AutoRevertDeps = {
  /** The revert cutover (vessel-mitosis-cutover.ts REVERT_OF). */
  cutover: (pointer: Record<string, unknown>) => Promise<unknown>;
  /** When the vessel's unit last entered active, unix seconds; 0 when unknown. */
  unitStartedAt: (vessel: string) => number;
  /** A tuning row's value (activity-api /v2/tuning-params/:name); null when absent or unreadable. */
  tuning: (name: string) => Promise<number | null>;
  /** The gap row, null when the store holds none; throws when the store cannot be read. */
  readGap: (id: string) => Promise<Record<string, unknown> | null>;
  writeGap: (gap: Record<string, unknown>) => Promise<unknown>;
  scope: () => Promise<AutonomyScope>;
  now: () => number;
};
function systemdUnitStartedAt(vessel: string): number {
  try {
    const p = Bun.spawnSync(["systemctl", "show", vessel, "-p", "ActiveEnterTimestamp", "--value", "--timestamp=unix"], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const m = new TextDecoder().decode(p.stdout).trim().match(/^@(\d+)$/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; } // unit unreadable: cannot tell what is running here
}
async function readTuningRow(name: string): Promise<number | null> {
  try {
    const res = await fetch(`${METABOB_ENDPOINT}/v2/tuning-params/${encodeURIComponent(name)}`, { method: "GET", headers: { Authorization: `ApiKey ${METABOB_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: unknown };
    return typeof data.value === "number" && Number.isFinite(data.value) ? data.value : null;
  } catch { return null; }
}
const realAutoRevertDeps: AutoRevertDeps = {
  cutover: async (p) => (await import("../resolvers/vessel-mitosis-cutover.js")).resolveVesselMitosisCutover(p as never),
  unitStartedAt: systemdUnitStartedAt,
  tuning: readTuningRow,
  readGap: async (id) => {
    const r = (await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never)) as { shape?: string; body?: { gaps?: unknown } };
    if (r?.shape !== "substrateGap" || !Array.isArray(r.body?.gaps)) throw new Error(`gap store answered ${r?.shape ?? "nothing"}`);
    return ((r.body!.gaps as Array<Record<string, unknown>>).find((g) => String(g?.["id"]) === id)) ?? null;
  },
  writeGap: (gap) => resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never),
  scope: () => autonomyScope(),
  now: () => Date.now(),
};
let autoRevertDeps: AutoRevertDeps = realAutoRevertDeps;
const autoRevertSeen = new Set<string>();
const autoRevertSettled = new Set<string>();
const autoRevertCounts: Record<string, number> = {};
/** Tests only: replace any of the reader's dependencies (null restores the real ones); also clears its log de-dup
 *  and counters, so each fixture starts from a fresh process's state. */
export function __setAutoRevertDepsForTests(d: Partial<AutoRevertDeps> | null): void {
  autoRevertDeps = d ? { ...realAutoRevertDeps, ...d } : realAutoRevertDeps;
  autoRevertSeen.clear();
  autoRevertSettled.clear();
  for (const k of Object.keys(autoRevertCounts)) delete autoRevertCounts[k];
}
export function getAutoRevertCounters(): Record<string, number> { return { ...autoRevertCounts }; }
/** Tests only: the function the pending-land sweep's present branch calls (contained-self-development 8.4a). */
export const __recordFalsifiedAutonomousLandingForTests = (g: Record<string, unknown>, meta: Record<string, unknown>, sha: string) => recordFalsifiedAutonomousLanding(g, meta, sha);

const AUTO_REVERT_ATTEMPT_RE = /^att-[a-z0-9]+-[a-z0-9]+$/;
const FALSIFIED_STAMP_BY = "gap-sweep:falsified_after_restart";
type RevertCandidate = { key: string; attempt_id: string; sha: string; gap_id: string; at: number; source: "falsified_after_restart" | "settle_regressed" };
type RevertMark = { status: string; at: string; gap_id: string; revert_sha?: string };
type AutoRevertTuning = { maxAgeMs: number; strikeLimit: number; reviewMs: number } | { missing: string };

async function readAutoRevertTuning(deps: AutoRevertDeps): Promise<AutoRevertTuning> {
  const maxAgeMs = await deps.tuning("AUTO_REVERT_MAX_AGE_MS");
  if (maxAgeMs === null || !(maxAgeMs > 0)) return { missing: "AUTO_REVERT_MAX_AGE_MS" };
  const strikeLimit = await deps.tuning("AUTO_REVERT_STRIKE_LIMIT");
  if (strikeLimit === null || !(strikeLimit >= 1)) return { missing: "AUTO_REVERT_STRIKE_LIMIT" };
  const reviewMs = await deps.tuning("AUTO_REVERT_HOLD_REVIEW_MS");
  if (reviewMs === null || !(reviewMs > 0)) return { missing: "AUTO_REVERT_HOLD_REVIEW_MS" };
  return { maxAgeMs, strikeLimit: Math.floor(strikeLimit), reviewMs };
}

/** The vessel clone whose HEAD contains `sha`, and its full sha. */
function locateLandingClone(sha: string): { vessel: string; cloneDir: string; fullSha: string } | null {
  let names: string[] = [];
  try { names = readdirSync(vesselsCloneRoot()).sort(); } catch { return null; }
  for (const name of names) {
    const dir = join(vesselsCloneRoot(), name);
    if (!existsSync(join(dir, ".git"))) continue;
    const full = sweepGitOut(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (!full || sweepGitOut(dir, ["merge-base", "--is-ancestor", full, "HEAD"]) === null) continue;
    return { vessel: name, cloneDir: dir, fullSha: full };
  }
  return null;
}
/** The newest commit in `cloneDir` that says it reverts `fullSha`, the same pattern shaWasRevertedInAnyClone reads. */
function revertShaIn(cloneDir: string, fullSha: string): string | null {
  const out = sweepGitOut(cloneDir, ["log", "-E", "-i", "--grep", `reverts (\\w+ ){0,4}(commit )?(${fullSha}|${fullSha.slice(0, 12)})`, "--format=%H", "-1", `${fullSha}..HEAD`]);
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

export async function autoRevertRegressedLandings(): Promise<{ decisions: Array<{ settlement: string; gap_id: string; sha: string; result: string }> }> {
  const deps = autoRevertDeps;
  const { readRecords, appendRecord: append } = await import("../resolvers/attempt-ledger.js");
  const { CUTOVER_LEASE_TTL_MS } = await import("../resolvers/vessel-mitosis-cutover.js");
  const decisions: Array<{ settlement: string; gap_id: string; sha: string; result: string }> = [];
  const now = deps.now();

  // Candidates: one per attempt, its newest regressed settlement. An attempt the operator reverted is not one.
  const rows = readRecords("attemptSettlement");
  const operatorReverted = new Set(rows.filter((r) => (r.record as { source?: unknown }).source === "operator_revert").map((r) => String((r.record as { attempt_id?: unknown }).attempt_id ?? "")));
  const byAttempt = new Map<string, RevertCandidate>();
  for (const r of rows) {
    const rec = r.record as { verdict?: unknown; attempt_id?: unknown; shas?: unknown; gap_id?: unknown; at?: unknown; source?: unknown };
    if (rec.verdict !== "regressed") continue;
    const att = String(rec.attempt_id ?? "");
    if (operatorReverted.has(att)) continue;
    const shas = Array.isArray(rec.shas) ? (rec.shas as unknown[]).map(String) : [];
    const c: RevertCandidate = {
      key: r.key, attempt_id: att, sha: shas[shas.length - 1] ?? "", gap_id: typeof rec.gap_id === "string" ? rec.gap_id : "",
      at: Date.parse(String(rec.at ?? r.at)), source: rec.source === "falsified_after_restart" ? "falsified_after_restart" : "settle_regressed",
    };
    const prev = byAttempt.get(att);
    if (!prev || !(c.at < prev.at)) byAttempt.set(att, c);
  }
  // The marker: one record per transition, keyed `<attempt>#revert:<seq>:<status>`, latest by file order.
  const marks = (att: string): RevertMark[] => readRecords("attemptRevert").filter((r) => (r.record as { reverted_attempt_id?: unknown }).reverted_attempt_id === att).map((r) => r.record as unknown as RevertMark);
  const mark = (att: string, status: string, rec: Record<string, unknown>): void => {
    append("attemptRevert", `${att}#revert:${marks(att).length}:${status}`, { reverted_attempt_id: att, status, at: new Date(deps.now()).toISOString(), ...rec });
  };
  const latestMarkByAttempt = (): Map<string, RevertMark> => {
    const m = new Map<string, RevertMark>();
    for (const r of readRecords("attemptRevert")) m.set(String((r.record as { reverted_attempt_id?: unknown }).reverted_attempt_id ?? ""), r.record as unknown as RevertMark);
    return m;
  };
  let tuning: Promise<AutoRevertTuning> | null = null;

  for (const c of [...byAttempt.values()].sort((a, b) => (a.at || 0) - (b.at || 0))) {
    if (autoRevertSettled.has(c.key)) continue;
    let vessel = "";
    let gapId = c.gap_id;
    const ageS = Number.isFinite(c.at) ? Math.max(0, Math.round((now - c.at) / 1000)) : -1;
    const decide = (result: string, counter: string, settled = false): string => {
      autoRevertCounts[counter] = (autoRevertCounts[counter] ?? 0) + 1;
      if (settled) autoRevertSettled.add(c.key);
      const seenKey = `${c.key}|${result}`;
      if (!autoRevertSeen.has(seenKey)) {
        autoRevertSeen.add(seenKey);
        console.warn(`[auto-revert] gap=${gapId || "?"} reverted_sha=${c.sha.slice(0, 12) || "?"} settlement=${c.key} source=${c.source} result=${result} vessel=${vessel || "?"} age_s=${ageS}`);
      }
      decisions.push({ settlement: c.key, gap_id: gapId, sha: c.sha, result });
      return result;
    };
    try {
      // 1. Well-formed (the ledger row).
      if (!/^[0-9a-f]{7,40}$/.test(c.sha) || !AUTO_REVERT_ATTEMPT_RE.test(c.attempt_id) || !Number.isFinite(c.at)) { decide("skipped=malformed", "malformed_regressed_by", true); continue; }
      // 2. Owned and autonomous.
      const intent = (readRecords("attemptIntent", { key: c.attempt_id })[0]?.record ?? null) as { directed?: unknown; route?: unknown; gap_id?: unknown } | null;
      if (!intent) { decide("skipped=not_owned", "not_owned", true); continue; }
      if (intent.directed !== false) { decide("skipped=directed", "directed", true); continue; }
      if (intent.route === "auto_revert") { decide("skipped=is_revert", "is_revert", true); continue; }
      if (!gapId && typeof intent.gap_id === "string") gapId = intent.gap_id;
      const loc = locateLandingClone(c.sha);
      if (!loc || !gapId || gapId.startsWith("unknown")) { decide("skipped=malformed", "malformed_regressed_by", true); continue; }
      vessel = loc.vessel;
      // 1, continued. The gap row's stamp, when it carries one, must name this landing (qa F10).
      let row: Record<string, unknown> | null;
      try { row = await deps.readGap(gapId); } catch { decide("skipped=gap_store_unavailable", "gap_store_unavailable"); continue; }
      const meta = ((row?.["classification_metadata"] ?? {}) as Record<string, unknown>);
      const rb = meta["regressed_by"] as Record<string, unknown> | null | undefined;
      if (rb !== undefined && rb !== null) {
        if (typeof rb !== "object" || Array.isArray(rb)) { decide("skipped=malformed", "malformed_regressed_by", true); continue; }
        if (rb["revert_sha"]) { decide("skipped=already_reverted", "already_reverted"); continue; }
        const stampSha = typeof rb["sha"] === "string" ? rb["sha"] : "";
        const stampVessel = typeof rb["vessel"] === "string" ? rb["vessel"] : "";
        const stampOk = /^[0-9a-f]{7,40}$/.test(stampSha) && loc.fullSha.startsWith(stampSha)
          && stampVessel === loc.vessel && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stampVessel) && existsSync(join(vesselsCloneRoot(), stampVessel, ".git"))
          && rb["attempt_id"] === c.attempt_id && rb["by"] === FALSIFIED_STAMP_BY;
        if (!stampOk) { decide("skipped=malformed", "malformed_regressed_by", true); continue; }
      }
      // 3. A lane landing, not a revert.
      const body = sweepGitOut(loc.cloneDir, ["log", "-1", "--format=%B", loc.fullSha]) ?? "";
      if (/^Auto-Revert:\s*true\s*$/mi.test(body) || /^Revert "/.test(body) || /This reverts commit/i.test(body)) { decide("skipped=is_revert", "is_revert", true); continue; }
      const trailerAtt = (sweepGitOut(loc.cloneDir, ["log", "-1", "--format=%(trailers:key=Attempt-Id,valueonly)", loc.fullSha]) ?? "").trim();
      if (!body.startsWith("substrate-authored:") || trailerAtt !== c.attempt_id) { decide("skipped=not_lane_landing", "not_lane_landing", true); continue; }
      // 4. Fresh, against the tuning rows (fail closed).
      const t = await (tuning ??= readAutoRevertTuning(deps));
      if ("missing" in t) { decide(`skipped=no_tuning_row name=${t.missing}`, "no_tuning_row"); continue; }
      if (!(now - c.at <= t.maxAgeMs)) { decide("skipped=stale", "stale", true); continue; }
      const gapWrite = async (cm: Record<string, unknown>): Promise<void> => {
        if (!row) return;
        try {
          await deps.writeGap({ id: gapId, category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: cm });
        } catch (err) { console.warn(`[auto-revert] gap=${gapId} write failed (the ledger marker holds): ${String(err).slice(0, 200)}`); }
      };
      const completeRevertSha = async (revertSha: string): Promise<void> => {
        const base = rb && typeof rb === "object" ? rb : { sha: loc.fullSha, at: new Date(c.at).toISOString(), verdict: "regressed", attempt_id: c.attempt_id, vessel: loc.vessel, by: `auto-revert:${c.source}` };
        await gapWrite({ regressed_by: { ...base, revert_sha: revertSha, revert_status: "done", reverted_by: "auto-revert", reverted_at: new Date(deps.now()).toISOString(), learned_at: (base as { learned_at?: unknown }).learned_at ?? new Date(deps.now()).toISOString() } });
      };
      const escalate = async (kind: string, detail: string): Promise<void> => {
        await gapWrite({ disposition: "needs_information", auto_revert_escalation: { kind, detail: detail.slice(0, 400), settlement: c.key, sha: loc.fullSha, at: new Date(deps.now()).toISOString() } });
      };
      // 5. Already reverted (live).
      if (shaWasRevertedInAnyClone(loc.fullSha)) {
        const revertSha = revertShaIn(loc.cloneDir, loc.fullSha);
        if (revertSha) {
          await completeRevertSha(revertSha);
          if (marks(c.attempt_id).at(-1)?.status === "pending") mark(c.attempt_id, "done", { gap_id: gapId, sha: loc.fullSha, revert_sha: revertSha, reconciled: true });
        }
        decide("skipped=already_reverted", "already_reverted");
        continue;
      }
      // 6. One revert per landing.
      const latest = marks(c.attempt_id).at(-1);
      if (latest) {
        if (latest.status === "pending") {
          if (now - Date.parse(latest.at) > CUTOVER_LEASE_TTL_MS) {
            mark(c.attempt_id, "stuck", { gap_id: gapId, sha: loc.fullSha });
            await escalate("stuck", `a revert of ${loc.fullSha.slice(0, 12)} was started at ${latest.at} and never finished; no revert is in any clone`);
            decide("stuck", "stuck");
          } else decide("skipped=in_flight", "in_flight");
          continue;
        }
        if (latest.status !== "deferred") { decide(`skipped=already_attempted status=${latest.status}`, "already_attempted"); continue; }
      }
      // 7. Strike limit (8.6): done reverts only; a retry, a conflict or a refusal is not a strike.
      const latestAll = latestMarkByAttempt();
      const done = [...latestAll.values()].filter((m) => m.status === "done" && m.gap_id === gapId);
      if (done.length >= t.strikeLimit) {
        const atMs = deps.now(); // one clock read: review_by is exactly at + the review interval
        const at = new Date(atMs).toISOString();
        const hold = {
          hold_id: `auto-revert-strike-${gapId}`, scope: `gap:${gapId}`, active: true, by: "auto-revert:strike_limit", at,
          reason: `${done.length} auto-revert(s) of this gap's landings (limit ${t.strikeLimit}); another regressed landing of it is not reverted automatically`,
          evidence: done.map((m) => m.revert_sha ?? "").filter(Boolean).length > 0 ? done.map((m) => m.revert_sha ?? "").filter(Boolean) : [c.key],
          lift: "an operator reviews the reverts and either clears operator_hold (the lane may land and auto-revert again) or re-scopes or closes the gap",
          review_by: new Date(atMs + t.reviewMs).toISOString(), harm: false,
        };
        mark(c.attempt_id, "strike_hold", { gap_id: gapId, sha: loc.fullSha, hold });
        await gapWrite({ operator_hold: true, operator_hold_reason: hold.reason, disposition: "needs_information", auto_revert_hold: hold });
        decide("strike_hold", "strike_hold");
        continue;
      }
      // 8. Scope.
      const files = (sweepGitOut(loc.cloneDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", loc.fullSha]) ?? "").split("\n").map((f) => f.trim()).filter(Boolean);
      const scope = await deps.scope();
      if (!scope.readable) { decide("skipped=scope_unreadable", "scope_unreadable"); continue; }
      const hits = files.map((f) => autonomyScopeExcludes(scope, `repos/${loc.vessel}/${f}`)).filter((h): h is string => !!h);
      if (files.length === 0 || hits.length > 0) {
        mark(c.attempt_id, "refused", { gap_id: gapId, sha: loc.fullSha, reason: files.length === 0 ? "no_files" : "out_of_scope", hits });
        await escalate("out_of_scope", files.length === 0 ? "the landing changed no file" : `the landing touched autonomy-scope excluded path(s) ${[...new Set(hits)].join(", ")}; an autonomous commit there is an anomaly to look at, not to revert automatically`);
        decide("skipped=out_of_scope", "out_of_scope");
        continue;
      }
      // The marker BEFORE the cutover: a revert of development-vessel restarts this process.
      mark(c.attempt_id, "pending", { gap_id: gapId, sha: loc.fullSha, vessel: loc.vessel, settlement: c.key });
      const res = (await deps.cutover({
        type: "vessel_mitosis_cutover", vessel_name: loc.vessel, base_version_id: "auto-revert", mitosis_version_id: `revert-${c.attempt_id}`,
        evaluation_evidence: { verdict: "AUTO_REVERT", base_success_rate: 0, mitosis_success_rate: 0, cited_trace_ids: [], cited_check_names: [`settlement:${c.key}`] },
        gap_id: gapId,
        revert_of: { sha: loc.fullSha, attempt_id: c.attempt_id, settlement_key: c.key, gap_id: gapId, files, source: c.source },
      })) as { shape?: string; body?: Record<string, unknown> } | null;
      const rbody = (res?.body ?? {}) as Record<string, unknown>;
      const newSha = typeof rbody["new_git_sha"] === "string" ? (rbody["new_git_sha"] as string) : "";
      if (res?.shape === "cutoverApplied" && rbody["push_status"] === "pushed" && /^[0-9a-f]{7,40}$/.test(newSha)) {
        mark(c.attempt_id, "done", { gap_id: gapId, sha: loc.fullSha, revert_sha: newSha });
        await completeRevertSha(newSha);
        decide(`reverted revert_sha=${newSha.slice(0, 12)}`, "reverted");
      } else if (rbody["skip_reason"] === "already_reverted") {
        mark(c.attempt_id, "refused", { gap_id: gapId, sha: loc.fullSha, reason: "already_reverted" });
        decide("skipped=already_reverted", "already_reverted");
      } else if (rbody["kind"] === "revert_conflict") {
        mark(c.attempt_id, "conflict", { gap_id: gapId, sha: loc.fullSha });
        await escalate("conflict", String(rbody["refusal_reason"] ?? rbody["detail"] ?? "revert conflicts with later edits"));
        decide("conflict", "conflict");
      } else if (res?.shape === "cutoverDeferred" || rbody["deferred"] === true || ["env_change_window_held", "proposal_lease_held", "push_kill_switch"].includes(String(rbody["kind"] ?? ""))) {
        // An environment condition, not a verdict on the revert: retried on a later tick while it is fresh.
        mark(c.attempt_id, "deferred", { gap_id: gapId, sha: loc.fullSha, reason: String(rbody["kind"] ?? rbody["reason"] ?? res?.shape ?? "deferred") });
        decide("skipped=deferred", "deferred");
      } else {
        const reason = res?.shape === "cutoverApplied" ? `push_${String(rbody["push_status"] ?? "unknown")}` : String(rbody["kind"] ?? rbody["skip_reason"] ?? res?.shape ?? "no_result");
        mark(c.attempt_id, "refused", { gap_id: gapId, sha: loc.fullSha, reason });
        await escalate("refused", `the revert cutover refused: ${reason}`);
        decide(`refused reason=${reason}`, "refused");
      }
    } catch (err) {
      // A throw mid-revert (the process may be dying with it): the pending marker stays, and decides the next run.
      autoRevertCounts["error"] = (autoRevertCounts["error"] ?? 0) + 1;
      console.error(`[auto-revert] gap=${gapId || "?"} reverted_sha=${c.sha.slice(0, 12) || "?"} settlement=${c.key} source=${c.source} result=error vessel=${vessel || "?"} age_s=${ageS} — ${String(err).slice(0, 200)}`);
      decisions.push({ settlement: c.key, gap_id: gapId, sha: c.sha, result: "error" });
    }
  }
  // A strike hold is reviewed by its date: past review_by while still the latest record, it is said again (once).
  for (const [att, m] of latestMarkByAttempt()) {
    const review = (m as unknown as { hold?: { review_by?: unknown } }).hold?.review_by;
    if (m.status !== "strike_hold" || typeof review !== "string" || !(Date.parse(review) < now)) continue;
    const k = `${att}|hold_review_due`;
    if (autoRevertSeen.has(k)) continue;
    autoRevertSeen.add(k);
    autoRevertCounts["hold_review_due"] = (autoRevertCounts["hold_review_due"] ?? 0) + 1;
    console.warn(`[auto-revert] hold_review_due gap=${m.gap_id} attempt=${att} review_by=${review} — the strike hold is past its review date`);
  }
  return { decisions };
}
let autoRevertInFlight = false;
/** Starts the reader unless one is running (the sweep's inline call and the tick's catch-up share it). Not awaited:
 *  a revert runs the precutover suite. */
export function kickAutoRevert(from: "inline" | "tick"): void {
  if (autoRevertInFlight) return;
  autoRevertInFlight = true;
  void autoRevertRegressedLandings()
    .catch((e) => console.error(`[auto-revert] reader failed (${from}): ${(e as Error).message}`))
    .finally(() => { autoRevertInFlight = false; });
}

/**
 * A CHILD'S VERIFIED CLOSE IS ITS ANCESTORS' MEASUREMENT when they hold the same predicate (qa F2, 10-02).
 * A narrowed or recommit child carries its parent's check byte-identically (inheritableParentCheck), and while
 * it is open the parent is held from auto-pick (inheritedPredicateHolds). When the child closes landed_verified
 * on its own exercised check (passed, verdict absent), that very check now reads absent for the parent too:
 * the ancestor is closed on that measurement, with the child's falsifier_exercise (verdict, commit) carried
 * and a resolution naming the child. Not a stamp by id: an ancestor whose evidence_resolve differs in any
 * byte is never closed, and the walk stops there. Operator-held ancestors are left alone. Ancestors are
 * closed as `closed_via_child`, not landed_verified, so no landing is credited twice.
 * Each close is conditional (expect_status "open", checked under the store lock): an ancestor closed or
 * otherwise changed state since it was read is not overwritten, and the walk stops there, since whatever
 * settled that ancestor also owns what lies above it.
 */
let __ancestorCloseRaceHook: ((ancestorId: string) => Promise<void>) | null = null;
/** Tests only: runs between an ancestor's read and its close write, to stage a concurrent writer. */
export function __setAncestorCloseRaceHookForTests(h: ((ancestorId: string) => Promise<void>) | null): void { __ancestorCloseRaceHook = h; }
export async function closeAncestorsOnSamePredicate(childId: string, childClosedMeta: Record<string, unknown>): Promise<string[]> {
  const closed: string[] = [];
  try {
    const ex = childClosedMeta.falsifier_exercise as { passed?: unknown; verdict?: unknown } | undefined;
    if (childClosedMeta.closed_reason !== "landed_verified" || !ex || ex.passed !== true || ex.verdict !== "absent") return closed;
    const er = childClosedMeta.evidence_resolve;
    if (!er || typeof er !== "object" || typeof (er as { shape?: unknown }).shape !== "string") return closed;
    const key = class2PredicateKey({ evidence_resolve: er });
    let up = String(childClosedMeta.parent_gap_id ?? childClosedMeta.source_gap_id ?? "");
    const seen = new Set<string>([childId]);
    for (let depth = 0; up && !seen.has(up) && depth < 8; depth++) {
      seen.add(up);
      const read = await resolveSubstrateGap({ type: "substrateGap", id: up, limit: 1 } as never);
      const row = (((read?.body as { gaps?: Record<string, unknown>[] } | undefined)?.gaps) ?? [])[0];
      if (!row || String(row.id ?? "") !== up) break;
      const am = (row.classification_metadata ?? row.metadata ?? {}) as Record<string, unknown>;
      const aer = am.evidence_resolve;
      if (!aer || typeof aer !== "object" || class2PredicateKey({ evidence_resolve: aer }) !== key) break;
      const staleAnc = String(row.status ?? "") === "open" ? staleCloseEvidence(row, String((ex as { commit?: unknown }).commit ?? "")) : null;
      if (staleAnc) {
        console.log(`[gap-sweep] ${up}: not closed via child ${childId}: ${staleAnc.reason} (commit ${staleAnc.sha.slice(0, 12) || "none"} landed ${staleAnc.committed_at ?? "unknown"}, re-detected ${staleAnc.redetected_at}); lineage walk stops`);
        break;
      }
      if (String(row.status ?? "") === "open" && am.operator_hold !== true) {
        const resolution = `closed via child ${childId}: same predicate exercised`;
        if (__ancestorCloseRaceHook) await __ancestorCloseRaceHook(up);
        const w = await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          expect_status: "open",
          gap: {
            id: up,
            category: row.category,
            source: row.source,
            summary: row.summary,
            detected_at: row.detected_at,
            classification_metadata: { ...am, closed_reason: "closed_via_child", close_basis: "absent", closed_via_child: childId, resolution, falsifier_exercise: { ...(ex as Record<string, unknown>), via_child: childId }, closed_at: new Date().toISOString() },
            status: "closed",
          },
        } as never);
        const wb = (w?.body ?? {}) as { action?: unknown; skip_reason?: unknown; stored_status?: unknown };
        if (w?.shape === "structuredError" || wb.action === "skipped") {
          console.log(`[gap-sweep] ${up}: not closed via child ${childId} (${w?.shape === "structuredError" ? "write refused" : `${String(wb.skip_reason)}, stored ${String(wb.stored_status)}`}); lineage walk stops`);
          break;
        }
        closed.push(up);
        console.log(`[gap-sweep] ${up}: ${resolution}`);
      }
      up = String(am.parent_gap_id ?? am.source_gap_id ?? "");
    }
  } catch (err) {
    console.warn(`[gap-sweep] closing ancestors of ${childId} on its predicate failed: ${String(err).slice(0, 200)}`);
  }
  return closed;
}

/**
 * A VERIFIED CLOSE IS ITS OPEN DESCENDANTS' MEASUREMENT TOO, when they hold the same predicate. The mirror of
 * closeAncestorsOnSamePredicate: a recommit-<id>-<cls> child (source_gap_id) or a -narrowed child (parent_gap_id)
 * carries its parent's check byte-identically on the same edit_site, so once the parent closes landed_verified
 * on that exercised check (passed, verdict absent) the child's defect reads absent as well. Left open, auto-pick
 * kept composing it. Each open descendant (grandchildren included) with the identical evidence_resolve and
 * edit_site closes as `closed_via_parent` with the parent's falsifier_exercise; a child on a different check or
 * edit_site, and an operator-held child, stay open. Conditional writes (expect_status "open").
 */
export async function closeDescendantsOnSamePredicate(parentId: string, parentClosedMeta: Record<string, unknown>): Promise<string[]> {
  const closed: string[] = [];
  try {
    const ex = parentClosedMeta.falsifier_exercise as { passed?: unknown; verdict?: unknown } | undefined;
    if (parentClosedMeta.closed_reason !== "landed_verified" || !ex || ex.passed !== true || ex.verdict !== "absent") return closed;
    const er = parentClosedMeta.evidence_resolve;
    if (!er || typeof er !== "object" || typeof (er as { shape?: unknown }).shape !== "string") return closed;
    const key = class2PredicateKey({ evidence_resolve: er });
    const site = String(parentClosedMeta.edit_site ?? "");
    const read = await resolveSubstrateGap({ type: "substrateGap", status: "open", limit: Number.MAX_SAFE_INTEGER, exclude_categories: [...DECISION_LOG_GAP_CATEGORIES] } as never);
    const open = (((read?.body as { gaps?: Record<string, unknown>[] } | undefined)?.gaps) ?? []);
    const metaOf = (r: Record<string, unknown>) => (r.classification_metadata ?? r.metadata ?? {}) as Record<string, unknown>;
    const queue = [parentId];
    const seen = new Set<string>([parentId]);
    while (queue.length > 0 && seen.size < 64) {
      const up = queue.shift()!;
      for (const row of open) {
        const id = String(row.id ?? "");
        const am = metaOf(row);
        if (!id || seen.has(id) || String(am.parent_gap_id ?? am.source_gap_id ?? "") !== up) continue;
        const aer = am.evidence_resolve;
        if (!aer || typeof aer !== "object" || class2PredicateKey({ evidence_resolve: aer }) !== key || String(am.edit_site ?? "") !== site) continue;
        seen.add(id);
        if (String(row.status ?? "") !== "open" || am.operator_hold === true) continue;
        const staleDesc = staleCloseEvidence(row, String((ex as { commit?: unknown }).commit ?? ""));
        if (staleDesc) { console.log(`[gap-sweep] ${id}: not closed via parent ${parentId}: ${staleDesc.reason} (commit ${staleDesc.sha.slice(0, 12) || "none"} landed ${staleDesc.committed_at ?? "unknown"}, re-detected ${staleDesc.redetected_at})`); continue; }
        const resolution = `closed via parent ${parentId}: same predicate exercised`;
        const w = await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          expect_status: "open",
          gap: { id, category: row.category, source: row.source, summary: row.summary, detected_at: row.detected_at, status: "closed",
            classification_metadata: { ...am, closed_reason: "closed_via_parent", close_basis: "absent", closed_via_parent: parentId, resolution, falsifier_exercise: { ...(ex as Record<string, unknown>), via_parent: parentId }, closed_at: new Date().toISOString() } },
        } as never);
        const wb = (w?.body ?? {}) as { action?: unknown };
        if (w?.shape === "structuredError" || wb.action === "skipped") { console.log(`[gap-sweep] ${id}: not closed via parent ${parentId} (write refused or skipped)`); continue; }
        closed.push(id);
        queue.push(id);
        console.log(`[gap-sweep] ${id}: ${resolution}`);
      }
    }
  } catch (err) {
    console.warn(`[gap-sweep] closing descendants of ${parentId} on its predicate failed: ${String(err).slice(0, 200)}`);
  }
  return closed;
}

export async function sweepPendingLandVerifications(deps: { ask: Ask }): Promise<{ checked: number; closed: number }> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = sweepPendingLandVerificationsOnce(deps).finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}

/**
 * THE SWEEP TRIGGER, extracted verbatim from resolveGapToFeatureOnce (BOUNDARY.md 1.5): the pending-land sweep runs
 * when a clone HEAD moved since the last sweep (or the fingerprint is unreadable), and a landing awaiting its
 * vessel's restart leaves the fingerprint unset so the next tick sweeps again. It owns lastSweepHeads and
 * sweepAwaitingRestart. Never throws (it never blocks the tick).
 */
export async function sweepIfCloneHeadsMoved(deps: { ask: Ask }): Promise<void> {
  try {
    const heads = cloneHeadsFingerprint();
    if (heads === null || heads !== lastSweepHeads) {
      sweepAwaitingRestart = false;
      await sweepPendingLandVerifications(deps);
      // A landing awaiting its vessel's restart is re-examined after the restart, which moves no
      // clone HEAD — so leave the fingerprint unset and sweep again next tick.
      lastSweepHeads = sweepAwaitingRestart ? null : heads;
    }
  } catch { /* never block the tick */ }
}

async function sweepPendingLandVerificationsOnce(deps: { ask: Ask }): Promise<{ checked: number; closed: number }> {
  const out = { checked: 0, closed: 0 };
  loadSweepLastChecked();
  // OBSERVABILITY, because this sweep has been silent since it was written.
  //
  // It returns {checked, closed} and logs NOTHING, so from outside there is no way to tell
  // whether it ran, what it examined, or why nothing closed. Measured 2026-08-31: 1606 gaps,
  // 1025 of them closed, and ZERO carrying closed_reason=landed_verified — the lane this
  // function exists to drive has never once produced a surviving row. Whether that was a
  // broken sweep, an empty input, or correct abstention was indistinguishable from the
  // journal, and that ambiguity is the entire reason it went unexamined.
  //
  // Live at the time of writing: 13 gaps carry pending_outcome_verification, 11 of them
  // have no predicate at all — so the honest answer is "correctly abstaining on an input
  // that cannot be measured", not "broken". A counter per verdict says that out loud.
  const tally = { absent: 0, present: 0, pending: 0, unknown: 0, not_in_clone: 0, reverted: 0, awaiting_restart: 0, falsified: 0, self_authored: 0, birth_retaken: 0, stale: 0, unlabelled: 0, held: 0, non_discriminating: 0 };
  try {
    const read = await resolveSubstrateGap({
      type: "substrateGap",
      status: "open",
      // NO CONSTANT CAP (2026-09-29, sibling of the auto-pick read in 355d6de): at 1844 open gaps a
      // 1000 window hid 5 pending landings and 50 predicate-bearing gaps from verification.
      limit: Number.MAX_SAFE_INTEGER,
      exclude_categories: [...DECISION_LOG_GAP_CATEGORIES],
      // Bookkeeping, not supply: held gaps are read so the lineage stamp, operator regressions and birth re-takes
      // below see them. They never take a verification slot (pendingSweepCandidates); the tally counts them.
      include_held: true,
    } as never);
    const gaps = ((read?.body as { gaps?: Record<string, unknown>[] })?.gaps) ?? [];
    // First, stamp lineage-linked commits as pending verification for gaps with predicates but no stamp
for (const g of gaps) {
  const m = (g.classification_metadata ?? {}) as Record<string, unknown>;
  const hasPredicate = !!m.expected_literal || !!m.hardcoded_url || !!m.verify_shape;
  if (hasPredicate && !m.pending_outcome_verification) {
    const lineageSha = await landedCommitViaLineage(g);
    // A reopened row is not re-stamped with a landing older than its re-detection: that is the fix that did
    // not hold, and stamping it would hand the sweep the stale close it refuses below.
    const staleLineage = lineageSha ? staleCloseEvidence(g, lineageSha) : null;
    if (staleLineage) console.log(`[gap-sweep] gap ${String(g.id)}: lineage landing ${lineageSha!.slice(0, 12)} not stamped: ${staleLineage.reason} (landed ${staleLineage.committed_at ?? "unknown"}, re-detected ${staleLineage.redetected_at})`);
    // A landing released for a non-discriminating check is not re-stamped: that would restart the loop it ended.
    const releasedLineage = !!lineageSha && pendingReleasedFor(m, lineageSha);
    if (releasedLineage) console.log(`[gap-sweep] gap ${String(g.id)}: lineage landing ${lineageSha!.slice(0, 12)} not stamped: released (${NON_DISCRIMINATING_CHECK})`);
    if (lineageSha && !staleLineage && !releasedLineage) {
      await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: g.id,
          classification_metadata: {...m, pending_outcome_verification: lineageSha},
          status: "open"
        }
      });
    }
  }
}

// Operator reverts reach the learning path before anything else reads these gaps.
for (const g of gaps) { try { await recordOperatorRegression(g); } catch { /* best-effort; retried next tick */ } }

// BIRTH RE-EVALUATION (qa R1): unknown, or pending past the hour, re-taken BIRTH_REEVAL_PER_TICK per tick,
// oldest first, on the same birth chain and judge as a write's (substrate-gap reevaluateBirthVerdicts).
try { tally.birth_retaken = (await reevaluateBirthVerdicts(gaps)).length; } catch (err) { console.warn(`[gap-sweep] birth re-evaluation skipped: ${String(err).slice(0, 200)}`); }

// Then process existing pending verifications as before
const candidates = pendingSweepCandidates(gaps);
tally.held = candidates.held;
const pending = candidates.unheld
      // Measurable gaps first: predicate-less stamped gaps can never resolve, and taking the first N in
      // store order let them hold every slot. Then LEAST RECENTLY CHECKED first (never-checked, i.e. new
      // landings, sort first), so every pending gap rotates through the slice. Newest pending_set_at first
      // was a fixed set, because checking a gap re-stamped it (09-29).
      .sort((a, b) => {
        const ma = (a.classification_metadata ?? {}) as Record<string, unknown>;
        const mb = (b.classification_metadata ?? {}) as Record<string, unknown>;
        const pa = ma.expected_literal || ma.hardcoded_url || ma.verify_shape || ma.evidence_resolve ? 0 : 1;
        const pb = mb.expected_literal || mb.hardcoded_url || mb.verify_shape || mb.evidence_resolve ? 0 : 1;
        const lastChecked = (g: Record<string, unknown>, m: Record<string, unknown>): string => {
          const persisted = String(m.pending_last_checked_at ?? "");
          const seen = sweepLastCheckedAt.get(String(g.id ?? "")) ?? "";
          return seen > persisted ? seen : persisted;
        };
        return pa - pb || lastChecked(a, ma).localeCompare(lastChecked(b, mb));
      })
      .slice(0, PENDING_VERIFY_SWEEP_LIMIT);
    for (const g of pending) {
      out.checked += 1;
      sweepLastCheckedAt.set(String(g.id ?? ""), new Date().toISOString());
      saveSweepLastChecked();
      const meta = { ...((g.classification_metadata ?? {}) as Record<string, unknown>) };
      const sha = String(meta.pending_outcome_verification);
      // Not yet observable in a clone (pull-sync hasn't converged, or the land was
      // reverted) — leave open; the sweep retries on every tick.
      if (!shaIsAncestorOfAnyClone(sha)) { tally.not_in_clone += 1; continue; }
      // A REVERTED land is not a land. The ancestor check above passes forever once the
      // commit exists, revert or not, so ask explicitly.
      // A revert the operator recorded on the gap counts too: route-edit and direct reverts carry no
      // `This reverts commit` line for the clone check to find.
      const rbSweep = meta.regressed_by as { sha?: unknown; revert_sha?: unknown } | null | undefined;
      const operatorReverted = !!rbSweep && typeof rbSweep === "object" && !!rbSweep.revert_sha && String(rbSweep.sha ?? "").startsWith(sha.slice(0, 7));
      if (operatorReverted || shaWasRevertedInAnyClone(sha)) {
        tally.reverted += 1;
        console.warn(`[gap-sweep] gap ${String(g.id)} NOT closed: landed sha ${sha.slice(0, 12)} was REVERTED — the change is gone from HEAD, so the gap is unresolved and stays open for another attempt`);
        await releaseUnresolvedLanding(g, `landed ${sha.slice(0, 12)} was reverted`, sha);
        // A landing made under a semantic dissent resolves its by-effect check as failed: it is gone.
        await resolveDissentOutcome(String(g.id ?? ""), { result: "failed" }).catch(dissentOutcomeUnwritten(String(g.id ?? ""), "failed"));
        continue;
      }
      // A REOPENED row is not re-closed on a landing older than its re-detection (see staleCloseEvidence):
      // checked BEFORE the evidence run, which proves nothing about this reopen and can cost a test_suite.
      const staleSweep = staleCloseEvidence(g, sha);
      if (staleSweep) {
        tally.stale += 1;
        console.warn(`[gap-sweep] gap ${String(g.id)} NOT closed: ${staleSweep.reason} — credited sha ${sha.slice(0, 12)} landed ${staleSweep.committed_at ?? "at an unknown time"}, gap re-detected ${staleSweep.redetected_at}; no outcome appended, released for a landing after the re-detection`);
        await releaseStaleLanding(g, staleSweep);
        continue;
      }
      // Post-cutover: the async verifier CAN now observe the landed state. Close ONLY on a
      // positively-MEASURED 'absent' (a Class-1 literal or Class-2 resolver-behaviour predicate
      // observed the condition gone). Everything else abstains (§12.6 step 1):
      //   'present'  -> defect still there; a RE-LAND (>=2) is out of coverage -> escalate.
      //   'pending'  -> SINGLE landing, no measurement predicate: PROVENANCE, not resolution.
      //                 This is the inert-diff (bafd83d) hole — a no-op diff landed and used to
      //                 close green HERE. Hold pending, ask the human, do NOT close, do NOT
      //                 re-compose (disposition set so the picker skips it -> no manufactured re-land).
      //   'unknown'  -> unmeasured; close only if the landed-commit class has EARNED fail-open trust
      //                 (it never does on provenance alone -> abstain, retry next tick).
      // Marked on an earlier tick: its check was edited by its own landing, so re-running it proves nothing.
      if (meta.disposition === "awaiting_operator_review" && (meta.self_authored_check as { sha?: unknown } | undefined)?.sha === sha) { tally.self_authored += 1; continue; }
      const verdict = await evaluateGapCheck(g);
      const gidSweep = String(g.id ?? "");
      // 8.5: an 'absent' from a check that never read 'present' at birth closes nothing.
      const suspectSweep = verdict === "absent" ? predicateSuspect(meta) : null;
      if (suspectSweep) {
        tally.unknown += 1;
        console.log(`[gap-sweep] gap ${gidSweep} reads absent but is NOT closed: predicate_suspect (${suspectSweep})`);
        continue;
      }
      if (verdict === "present") {
        tally.present += 1;
        const falsified = await recordFalsifiedAutonomousLanding(g, meta, sha);
        if (falsified === "awaiting_restart") { tally.awaiting_restart += 1; sweepAwaitingRestart = true; continue; }
        // A semantic dissent's by-effect check fails only on a 'present' ATTRIBUTABLE to the landing (the
        // landed code is running here); a 'present' read before the restart says nothing about it.
        if (falsified === "recorded") {
          // 8.4: the settlement is written; revert now (the reader keys off the ledger row, not this stamp).
          kickAutoRevert("inline");
          await resolveDissentOutcome(gidSweep, { result: "failed" }).catch(dissentOutcomeUnwritten(gidSweep, "failed"));
          tally.falsified += 1;
          continue;
        }
        // A MEASURED 'present' while the landing runs here: the change did not fix it, so it gets another attempt.
        // Class-3 'present' (landed twice) stays held for the human the re-land escalation asks.
        if (liftLandVerificationHold(meta) && landVerdictIsMeasured(meta) && (await landedCommitRunningHere(sha)) === "running") {
          await releaseUnresolvedLanding(g, `measured present with landed ${sha.slice(0, 12)} running`);
          await resolveDissentOutcome(gidSweep, { result: "failed" }).catch(dissentOutcomeUnwritten(gidSweep, "failed"));
        }
        const editSitePresent = gapEditSite(g, (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>) ?? "";
        if (landedCommitVerdict(gidSweep, editSitePresent) === 'present') {
          escalateRelandToHuman(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""), deps.ask);
        }
        continue;
      }
      if (verdict === "pending") {
        tally.pending += 1;
        await markPendingVerification(g, sha, "pending sweep: single landing, no measurement predicate");
        escalatePendingVerification(gidSweep, String(g.category ?? "?"), String(g.summary ?? ""), deps.ask, sha);
        continue;
      }
      if (verdict === "unknown" && !closeOracleEarnedTrust("landed_commit")) {
        tally.unknown += 1;
        continue; // unmeasured and untrusted — leave open for the next tick
      }
      // CLOSE ONLY WHERE THE FIX RUNS (09-29): this node's runtime file is evidence only if this node serves
      // the vessel on the landed code. Otherwise leave it open for the node that does.
      const runningHere = await landedCommitRunningHere(sha);
      if (runningHere !== "running") {
        tally.awaiting_restart += 1;
        sweepAwaitingRestart = true;
        console.log(`[gap-sweep] gap ${gidSweep} reads ${verdict} but landed ${sha.slice(0, 12)} is ${runningHere} on this node — not closed here`);
        continue;
      }
      const selfAuthoredSweep = selfAuthoredCheckInputs(g, sha);
      if (selfAuthoredSweep.length > 0) {
        tally.self_authored += 1;
        console.log(`[gap-sweep] gap ${gidSweep} reads ${verdict} but landed ${sha.slice(0, 12)} edited its own check input(s) ${selfAuthoredSweep.join(", ")}; not closed (awaiting operator review)`);
        await markAwaitingOperatorReview(g, sha, selfAuthoredSweep);
        continue;
      }
      // THE INDEPENDENT LANDING VERDICT, taken here by the evaluator and BEFORE any credit: a read at HEAD does not
      // say this landing flipped the check. Re-run the gap's own check at the landing's parent and at the landed
      // sha (once per landing: a deterministic outcome is stored as the label, grounded or not). Without a
      // grounded label the landing is not closed verified; a run that could not judge leaves it for the next tick.
      // Only a label computed in THIS pass counts: a stored grounded label is a record any gap writer can forge, so it
      // never substitutes for the re-run; a stored UNGROUNDED one may skip it (the fail-safe direction).
      let independentLabel: GoalVerificationLabel | null = null;
      if (landedCloseReason(meta, sha, isLiteralOnlyStepClose(meta)) === "awaiting_independent_verdict") {
        let ivReason = "an ungrounded verdict for this landing is already recorded";
        const storedLabel = landingLabelHere(meta, sha);
        let ungroundedLabel: GoalVerificationLabel | null = storedLabel?.grounded === false ? storedLabel : null;
        let freshUngrounded = false;
        if (!ungroundedLabel) {
          const iv = await independentLandingVerdict(g, sha);
          ivReason = iv.reason;
          if (iv.label) {
            meta.goal_verification_label = iv.label;
            if (iv.label.grounded) independentLabel = iv.label;
            else { ungroundedLabel = iv.label; freshUngrounded = true; }
          }
        }
        // A check green at the landing's parent AND at the landed sha never saw the defect: re-reading it can never
        // ground this landing, so the gap leaves pending (needs_information, a human asked) instead of looping here.
        if (nonDiscriminatingLandingLabel(ungroundedLabel) && (await releaseNonDiscriminatingCheck(g, sha, ungroundedLabel!, deps.ask))) {
          tally.non_discriminating += 1;
          continue;
        }
        if (freshUngrounded) await markPendingVerification({ ...g, classification_metadata: meta }, sha, `independent verdict: ${ivReason}`);
        if (landedCloseReason(meta, sha, isLiteralOnlyStepClose(meta), independentLabel) === "awaiting_independent_verdict") {
          tally.unlabelled += 1;
          console.log(`[gap-sweep] gap ${gidSweep} reads ${verdict} but landed ${sha.slice(0, 12)} is NOT closed: no grounded independent verdict (${ivReason})`);
          continue;
        }
      }
      // verdict === 'absent' (MEASURED resolved) OR 'unknown' with earned trust -> close.
      tally.absent += 1;
      // ONE CREDIT PER (gap, landing): a standing row may re-close after a reopen on the landing it already
      // credited; that close is recorded, but the landing's posterior and the close-oracle are not paid twice.
      const sweepLandRef = await landingDecisionRef(sha);
      const credited = joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: sha }, sweepLandRef.decision_id ? { decision_id: sweepLandRef.decision_id } : {});
      if (!credited) console.log(`[gap-sweep] gap ${gidSweep}: landing ${sha.slice(0, 12)} already credited FAVORABLE; closing without a second credit`);
      // SUCCESS label for the close-oracle (§12.6 1a): a MEASURED close builds the trustworthy
      // "measured" class posterior. Provenance-only closes no longer happen here, so landed_commit
      // never accrues a fake success from a commit count — it earns trust only via human confirmation
      // (solicitation-outcome-scan) and loses it on re-lands. That asymmetry is deliberate.
      if (credited) recordCloseVerdict("measured", false);
      const sweepClosedMeta: Record<string, unknown> = {
        ...meta,
        // Under the lane's own semantic dissent the landing is partial (landedCloseReason), never verified.
        closed_reason: landedCloseReason(meta, sha, isLiteralOnlyStepClose(meta), independentLabel),
        close_basis: verdict,
        falsifier_exercise: isLiteralOnlyStepClose(meta)
          ? { detector: "gap-sweep", verdict: "literal_present", passed: false, ran_at: new Date().toISOString(), commit: sha }
          : { detector: "gap-sweep", verdict, passed: verdict === "absent", ran_at: new Date().toISOString(), commit: sha },
        resolution: `landed via mitosis cutover ${sha} (${verdict === 'absent' ? 'measured condition check' : 'earned close-oracle trust'})`,
        closed_at: new Date().toISOString(),
      };
      const sweepCloseWrite = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: {
          id: String(g.id),
          category: g.category,
          source: g.source,
          summary: g.summary,
          detected_at: g.detected_at,
          classification_metadata: sweepClosedMeta,
          status: "closed",
        },
      } as never);
      if (sweepCloseWrite?.shape !== "structuredError") await closeAncestorsOnSamePredicate(String(g.id), sweepClosedMeta);
      if (sweepCloseWrite?.shape !== "structuredError") await closeDescendantsOnSamePredicate(String(g.id), sweepClosedMeta);
      // Calibration land credit is taken by the gap-store holder from the close written above.
      if (credited) updateClassPosterior(gapClassOf(g), true);
      // The by-effect check passed: a landing made under a semantic dissent resolves it as passed.
      if (sweepCloseWrite?.shape !== "structuredError") await resolveDissentOutcome(String(g.id), { result: "passed" }).catch(dissentOutcomeUnwritten(String(g.id), "passed"));
      out.closed += 1;
    }
  } catch (err) {
    // Was a bare `catch {}`. A sweep that dies mid-batch left NO evidence it had, which is
    // indistinguishable from a sweep that found nothing — the same ambiguity this tally
    // exists to remove. Still best-effort; it just says so now.
    console.warn(`[gap-sweep] aborted after checked=${out.checked}: ${(err as Error)?.message ?? String(err)}`);
  }
  // ALWAYS log, including the all-zero case. "checked=0" is a real finding (nothing is
  // stamped pending) and is not the same as "checked=13 closed=0 pending=11", which says the
  // machinery works and the INPUT is unmeasurable. Silence conflated those two for the whole
  // life of this function.
  console.log(`[gap-sweep] checked=${out.checked} closed=${out.closed} ${JSON.stringify(tally)}`);
  return out;
}

// ── Close-oracle posterior (§12.6 step 1(a), 2026-08-14) ────────────────────────────────
// The close-oracle is graded like any other activity: its per-evidence-class reliability accrues
// from ground truth, so its trust is EARNED, not assumed. A single-landing close via the
// landed-commit class is a provisional SUCCESS; a later RE-LAND on that class is the retrospective
// FALSE-CLOSE label (the prior close did not hold — reality re-detected the gap). Both labels are
// recorded at the close/refuse decision points, so the posterior is calibrated against the
// UN-AUTHORABLE REFERENT (re-detection) without instrumenting the re-open path. Per class the
// posterior is Beta(closes_that_held + 1, false_closes + 1); closeOracleReliability reads its mean.
// One label per gap (the callers dedup), so a single thrashing gap cannot dominate the posterior.
// Call-time (not module-load) so tests can point at a fixture file; production never sets it.

/**
 * GRADING AFTER A feature_compose APPLY FAILURE, with the bounded one-shot patch_with_tools escalation
 * (anchor_not_found / localization miss). feature_compose already rolled back on applyFailed (nothing to
 * double-land); pwt reads-then-edits the target agentically where blind-draft could not match old_string.
 * One-shot PER GAP LINEAGE via pwt_escalated (no cross-tick loop); fires ONLY on apply_failed (never on
 * semantic/verify rejects); any error or non-land falls through to bumpFailedAttempts unchanged. NB
 * classification_metadata is an OBJECT (property access, not .includes/.push).
 *
 * A HELD ESCALATION IS NOT GRADED, AND IS NOT AN ATTEMPT. When pwt refuses at entry as an infrastructure refusal
 * (isInfraRefusalBody: the operator hold on live-tree writes, stage live_tree_writes_held), no draft ran: the
 * outcome changes neither failed_attempts nor the class posterior, and it does NOT consume the one-shot
 * (pwt_escalated stays unset, so the lift needs no cleanup). Only a pwt_escalation_held {hold_id, at, stage, why}
 * stamp is written to the stored row.
 * RATE LIMIT BY THE STAMP. Without one, every tick would escalate again, be held again and never be graded, so the
 * gap would never accrue failed_attempts. So while the stamp names a hold that readOperatorHold still reads held,
 * the escalation is SKIPPED: pwt is not called, and the compose's own apply failure is graded exactly as it is with
 * no escalation (posterior + bump). Only the held refusal itself goes ungraded, once. Once the hold lifts, the next
 * apply failure escalates for real.
 *
 * Exported with injectable deps for the grading tests; the call site passes none.
 */
export interface PwtEscalationDeps {
  resolvePwt: (p: Record<string, unknown>) => Promise<ResolverResult>;
  updateClassPosterior: (cls: string, landed: boolean) => void;
  bumpFailedAttempts: (gap: Record<string, unknown>, opts: { surprise?: boolean; predictedP?: number; decisionId?: string }) => Promise<void>;
  closeLandedGap: (gap: Record<string, unknown>, land: LandSignal, ref?: { decision_id?: string; ask?: Ask }) => Promise<{ closed: boolean; error?: string }>;
  persistGapMeta: (gap: Record<string, unknown>, patch: Record<string, unknown>) => Promise<void>;
  /** Whether the hold a pwt_escalation_held stamp names still reads held (lib/operator-hold.ts readOperatorHold). */
  holdStillHeld: (holdId: string) => boolean;
}
export const defaultPwtEscalationDeps = (cb: { escalate?: Escalate } = {}): PwtEscalationDeps => ({
  resolvePwt: async (p) => (await import("../resolvers/patch-with-tools.js")).resolvePatchWithTools(p as never),
  updateClassPosterior,
  // A closed bump escalates only through the callback it is handed (gap-judge-core cannot import the residue).
  bumpFailedAttempts: (gap, opts) => bumpFailedAttempts(gap, { ...opts, escalate: cb.escalate }),
  closeLandedGap,
  persistGapMeta: persistGapMetaPatch,
  holdStillHeld: (holdId) => readOperatorHold(holdId).held,
});
export async function escalateApplyFailureToPwt(
  gap: Record<string, unknown>,
  cb: Record<string, unknown>,
  spec: string,
  pred: { predicted: boolean; p: number },
  deps: PwtEscalationDeps = defaultPwtEscalationDeps(),
  ref: { decision_id?: string; ask?: Ask } = {},
): Promise<{ escalated: boolean; landed: boolean; held: boolean; skipped_held: boolean }> {
  const _gm = ((gap as { classification_metadata?: Record<string, unknown> }).classification_metadata ??= {});
  let _pwtLanded = false;
  let escalated = false;
  let held = false;
  const priorHold = (_gm.pwt_escalation_held && typeof _gm.pwt_escalation_held === "object") ? _gm.pwt_escalation_held as Record<string, unknown> : null;
  const priorHoldId = typeof priorHold?.hold_id === "string" && priorHold.hold_id ? priorHold.hold_id : null;
  let stillHeld = false;
  if (cb.apply_failed && !_gm.pwt_escalated && priorHoldId) {
    try { stillHeld = deps.holdStillHeld(priorHoldId); } catch { stillHeld = true; }
    if (stillHeld) console.log(`[gap-to-feature] pwt escalation for ${String(gap.id)} SKIPPED: hold ${priorHoldId} (stamped ${String(priorHold?.at ?? "-")}) still held — grading the compose failure as with no escalation`);
  }
  if (cb.apply_failed && !_gm.pwt_escalated && !stillHeld) {
    _gm.pwt_escalated = true; // one-shot BEFORE the attempt: a crash/retry can never re-escalate
    escalated = true;
    try {
      const result = await deps.resolvePwt({
        type: "patch_with_tools",
        proposal_text: spec + `\n\nPRIOR FEATURE-COMPOSE APPLY FAILURE ON THIS FILE (do not repeat it): op_count=${cb.op_count}, apply_failed, rolled_back=${cb.rolled_back}`,
        // `gap.file_path` is ALWAYS undefined — measured 0 of 360 live gaps carry a
        // top-level file_path, while 104 carry classification_metadata.edit_site. So
        // this handed patch_with_tools `undefined`, deriveVesselFromPath threw
        // "undefined is not an object (evaluating 'filePath.match')", and the
        // escalation had never once run. Worse, pwt_escalated is set one-shot ABOVE
        // this line, so every gap that reached here was permanently marked escalated
        // by a crash. Same field order identifyVessel() already uses.
        target_file: gapEditSite(gap, _gm),
        gap_id: gap.id,
        proposal_id: gap.id,
        // Explicit, not the resolver's silent `?? "/vessels"` default: the value
        // becomes visible in the trace, which is the point of threading it.
        vessels_root: process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
      });
      const rb = (((result as unknown as Record<string, unknown>)?.body ?? result ?? {}) as Record<string, unknown>);
      if (isInfraRefusalBody(rb)) {
        held = true;
        delete _gm.pwt_escalated; // a held refusal is not an attempt: the one-shot is not consumed
        const stamp = { at: new Date().toISOString(), stage: String(rb.stage ?? ""), hold_id: rb.hold_id ?? null, why: String(rb.why ?? rb.detail ?? "").slice(0, 300) };
        console.log(`[gap-to-feature] pwt escalation for ${String(gap.id)} NOT RUN (${stamp.stage}${stamp.hold_id ? ` ${String(stamp.hold_id)}` : ""}: ${stamp.why}) — no failed_attempts bump, no class-posterior beta`);
        _gm.pwt_escalation_held = stamp;
        try { await deps.persistGapMeta(gap, { pwt_escalation_held: stamp }); }
        catch (e) { console.warn("[gap-to-feature] pwt escalation hold stamp not written: " + (e as Error).message); }
      } else {
        const _land = (rb.landing ?? {}) as Record<string, unknown>;
        const _sha = (rb.new_git_sha ?? rb.commit_sha ?? _land.new_git_sha) as string | undefined;
        const _pushed = rb.push_status === "pushed" || _land.push_status === "pushed" || _land.landed === true;
        if (rb.mitosisStaged && _pushed && _sha) {
          await deps.closeLandedGap(gap, { landed: true, commit_sha: String(_sha), vessel: "development-vessel", push_status: "pushed" }, ref);
          _pwtLanded = true;
        }
      }
    } catch (e) {
      console.warn("[gap-to-feature] pwt escalation error: " + (e as Error).message);
    }
  }
  if (!_pwtLanded && !held) {
    if (!isInfraRefusalBody(cb)) deps.updateClassPosterior(gapClassOf(gap), false);
    await deps.bumpFailedAttempts(gap, { surprise: pred.predicted, predictedP: pred.p, decisionId: ref.decision_id });
  }
  return { escalated, landed: _pwtLanded, held, skipped_held: stillHeld };
}
const closeOracleCalibPath = (): string => process.env["CLOSE_ORACLE_CALIB_PATH"] ?? "/workspace/close-oracle-calibration.json";
type CloseOracleCalib = Record<string, { closes: number; false_closes: number; operator_engaged?: number }>;
function readCloseOracleCalib(): CloseOracleCalib {
  try { const p = closeOracleCalibPath(); return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CloseOracleCalib) : {}; }
  catch { return {}; }
}
function recordCloseVerdict(evidenceClass: string, falseClose: boolean): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    if (falseClose) rec.false_closes += 1; else rec.closes += 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
// Operator-verdict-corpus calibration (§12.6 step 1b): when a HUMAN answers a re-land escalation
// (read back via solicitation_outcome_scan over obsidian interaction episodes), that engagement is
// an operator verdict corroborating the abstain — the oracle calibrating against the operator
// corpus, not just against reality's re-detection. Tracked honestly as engagement (met/unmet), not
// folded into the reliability posterior as a fake polar verdict, since met/unmet carries no polarity.
export function recordOperatorEngagement(evidenceClass: string): void {
  try {
    const c = readCloseOracleCalib();
    const k = evidenceClass || "unknown";
    const rec = c[k] ?? { closes: 0, false_closes: 0 };
    rec.operator_engaged = (rec.operator_engaged ?? 0) + 1;
    c[k] = rec;
    writeFileSync(closeOracleCalibPath(), JSON.stringify(c));
  } catch { /* best-effort */ }
}
/** Beta-mean reliability of the close-oracle at an evidence class: P(a close of this class holds). */
export function closeOracleReliability(evidenceClass: string): { alpha: number; beta: number; reliability: number; closes: number; false_closes: number; operator_engaged: number } {
  const rec = readCloseOracleCalib()[evidenceClass || "unknown"] ?? { closes: 0, false_closes: 0 };
  const held = Math.max(0, rec.closes - rec.false_closes); // closes that did NOT later re-land
  const alpha = held + 1;                                  // Beta(1,1) prior
  const beta = rec.false_closes + 1;
  return { alpha, beta, reliability: alpha / (alpha + beta), closes: rec.closes, false_closes: rec.false_closes, operator_engaged: rec.operator_engaged ?? 0 };
}
/** The commit that turned a gap's own check green: the newest commit touching the check's subject files (the
 *  edit_site, check_inputs; see birthCheckRepo) after the gap's birth tree (predicate_birth_sha, else detected_at),
 *  on the clone HEAD the parent tree was cut from. null when none.
 *  THE CHECK IS NOT ITS OWN SUBJECT: its instrument (checkInstrumentSet, read at the birth tree and at HEAD: the
 *  test_file and its non-src import closure, as the independent verdict's guard reads it) is excluded from the
 *  subject files, and ANY commit in the range touching it means the green was read on a different judge than the
 *  one the gap was born with: `held` names the stage (instrument-only, the fixing commit itself, or a separate
 *  commit since birth) and the caller does not close. v1: no re-run of the original check on the new tree. */
function fixingCommitSinceBirth(gap: Record<string, unknown>, meta: Record<string, unknown>): { sha: string; head: string; held?: { stage: string; instrument_commit: string; files: string[] } } | null {
  const repo = birthCheckRepo(meta);
  if (!repo || repo.files.length === 0 || !existsSync(join(repo.dir, ".git"))) return null;
  const head = sweepGitOut(repo.dir, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const birth = typeof meta.predicate_birth_sha === "string" ? meta.predicate_birth_sha : "";
  const since = typeof gap.detected_at === "string" && Number.isFinite(Date.parse(gap.detected_at)) ? gap.detected_at : "";
  const birthOk = !!birth && sweepGitOut(repo.dir, ["cat-file", "-e", `${birth}^{commit}`]) !== null;
  const range = birthOk ? [`${birth}..HEAD`] : since ? [`--since=${since}`, "HEAD"] : null;
  if (!range) return null;
  const readAt = (ref: string, path: string): string | null => sweepGitOut(repo.dir, ["show", `${ref}:${path}`]);
  const instrument = [...new Set([...(birthOk ? checkInstrumentSet(meta, birth, readAt) : []), ...checkInstrumentSet(meta, head, readAt)])];
  const subjects = repo.files.filter((f) => !instrument.includes(f));
  // No pathspec would match EVERY commit in the range: a check with no subject beyond its own instrument has no fixing commit.
  const sha = subjects.length > 0 ? sweepGitOut(repo.dir, ["log", "-1", "--format=%H", ...range, "--", ...subjects]) : null;
  const instrumentSha = instrument.length > 0 ? sweepGitOut(repo.dir, ["log", "-1", "--format=%H", ...range, "--", ...instrument]) : null;
  if (instrumentSha) {
    const files = (sweepGitOut(repo.dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", instrumentSha]) ?? "").split("\n").filter((f) => instrument.includes(f));
    const stage = !sha ? "own_green_instrument_only_commit" : sha === instrumentSha ? "own_green_mixed_instrument_commit" : "own_green_instrument_changed_since_birth";
    return { sha: sha || instrumentSha, head, held: { stage, instrument_commit: instrumentSha, files } };
  }
  return sha ? { sha, head } : null;
}

/** Exported for tests. A green-on-parent refusal with a commit that fixed the check's subject since the gap's
 *  birth CLOSES the gap fixed_elsewhere (a measurement, naming that commit), instead of re-picking it after
 *  every exclusion. With no such commit the green is unexplained (flaky, environmental): exclusion only. */
export async function markTerminalRefusal(gap: Record<string, unknown>, cb: Record<string, unknown> | null | undefined): Promise<void> {
  const why = String(cb?.terminal_refusal ?? "");
  console.log(`[gap-to-feature] terminal refusal for ${String(gap.id ?? "?")}: ${why || "(no reason)"}; no bump, full cooldown`);
  if (!why.startsWith("the gap's own check is already GREEN on the parent tree")) return;
  try {
    const fresh = await readGapFresh(String(gap.id ?? ""));
    if (!fresh || String(fresh.status ?? "") !== "open") return;
    const m0 = ((fresh.classification_metadata ?? {}) as Record<string, unknown>);
    const found = predicateSuspect(m0) === null ? fixingCommitSinceBirth(fresh, m0) : null;
    const held = found?.held ?? null;
    if (held) console.log(`[gap-to-feature] ${String(fresh.id)}: not closed fixed_elsewhere: ${held.stage}: ${held.instrument_commit.slice(0, 12)} touched the gap's own check (${held.files.slice(0, 5).join(", ") || "its instrument"}), so its green on parent is not a measurement of a fix`);
    const fix0 = held ? null : found;
    // A reopened gap is not fixed_elsewhere by a commit that landed before its re-detection.
    const staleFix = fix0 ? staleCloseEvidence(fresh, fix0.sha) : null;
    if (staleFix) console.log(`[gap-to-feature] ${String(fresh.id)}: not closed fixed_elsewhere: ${staleFix.reason} (${fix0!.sha.slice(0, 12)} landed ${staleFix.committed_at ?? "unknown"}, re-detected ${staleFix.redetected_at})`);
    const fix = staleFix ? null : fix0;
    if (fix) {
      const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: { ...fresh, status: "closed", classification_metadata: { ...m0,
        closed_reason: "fixed_elsewhere", close_basis: "absent", resolution: `fixed elsewhere by ${fix.sha.slice(0, 12)}: own check green on parent ${fix.head.slice(0, 12)}`, closed_at: new Date().toISOString(),
        falsifier_exercise: { detector: "gap-to-feature:terminal_refusal", verdict: "absent", passed: true, ran_at: new Date().toISOString(), commit: fix.head, fixed_by: fix.sha } } } } as never);
      if (w?.shape !== "structuredError" && (w?.body as { action?: unknown } | undefined)?.action !== "skipped") {
        console.log(`[gap-to-feature] ${String(fresh.id)}: closed fixed_elsewhere by ${fix.sha.slice(0, 12)} (own check green on parent ${fix.head.slice(0, 12)})`);
        return;
      }
    } else if (!held) {
      console.log(`[gap-to-feature] ${String(fresh.id)}: green on parent but no fixing commit found — not closing`);
    }
    await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { ...fresh, classification_metadata: { ...m0, own_check_green_on_parent: { at: new Date().toISOString(), reason: why.slice(0, 300),
      ...(held ? { stage: held.stage, instrument_commit: held.instrument_commit, instrument_files: held.files.slice(0, 10) } : {}) } } } } as never);
  } catch { /* best-effort: without the marker the full cooldown still bounds re-picks */ }
}
