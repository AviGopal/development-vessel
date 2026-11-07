/**
 * gap_check_supply_tick — the substrate writes the failing test a gap needs before the lane can take it
 * (REALIGNMENT §2.3 supply contract). WIRING, NOT A NEW SUBSYSTEM (§2.0): every step is an organ that exists.
 *
 * The lane composes only ARMED gaps (composeEligibilitySkipReason: open, class1/class2, an edit site, not held).
 * A gap with no check of its own is excluded as needs_information on every pick, and until now the only way
 * out was an operator hand-writing a failing test and arming the gap from it. This tick does that work:
 *
 *   1. CLASSIFY (checkSupplyDisposition): an open, unheld gap with no class1/class2 check or no edit site, and
 *      no literal predicate of its own, is NEEDS-LOCALIZATION. Computed on read; the disposition
 *      (CHECK_SUPPLY_DISPOSITION, which the shared eligibility predicate holds) is written only on a row this
 *      tick dispatches for, never as a bulk label.
 *   2. DISPATCH: for at most the rhythm's max_per_tick such gaps, ONE edit-intent goal per gap through
 *      dispatch_goal, naming the gap's own OUT-OF-SUITE check file (B′): "Write ONE failing test in
 *      repos/<vessel>/test/checks/<slug>.check.ts that reproduces: <symptom>. …" (checkSupplyGoal: one test whose
 *      assertion fails because of the defect, the edit site imported as a namespace, no network, no src changes).
 *      bun's default discovery never runs a *.check.ts, so the intended red never reaches the pre-cutover suite, the
 *      post-land suite or pull-sync; the supply never APPENDS to an existing *.test.ts (a red there reads as a
 *      regression everywhere), and feature_compose's R3 gate lets a test_writing compose write that one path only.
 *      One file per goal. The row's check_supply ledger records the attempt and the titles the file already held; a gap is not asked
 *      again until its backoff (backoff_hours * 2^(attempts-1)) has passed, and after max_attempts it is marked
 *      exhausted, so the tick cannot livelock on a gap whose test never lands. CONTROL ARM: by hash(gap id)
 *      parity half the gaps are recorded (gap_check_supply_arm "control") and never sent a goal, so the supply's
 *      effect can be measured against gaps it did not touch. The arm is TIME-BOXED (controlArmStep): a control row
 *      older than the rhythm's control_expiry_days (default 7) moves to treatment for good, its supply hold cleared.
 *   3. ARM: once new test titles exist in that file, they become a test_suite check. The test must IMPORT the
 *      edit site (the gap's own, the one its summary names, or, with none, an existing src module the test imports:
 *      check-supply-admission.ts checkImportsEditSite, the rule feature_compose's verify applies). The ONE judge
 *      (takeBirthVerdict, the birth seam's) runs it through test_suite (P0: ./<check path>) and its run report is
 *      read too: only 'present' with every named test among the run's failures AND each an ASSERTION by the shared
 *      classifier the report carries (red_reason, retry-evidence.ts classifyCheckRun: not a load error, a network
 *      call or a timeout) is written, through substrateGap_write with the verdict as the in-process trusted birth stamp,
 *      clearing the disposition in the same write. Green at HEAD, red for the wrong reason, a test that does
 *      not import the edit site, or one that reads a name its module does not export (check-supply-admission.ts
 *      missingExportRefusal: check_references_missing_export), or whose red asserts a shape or body field the function
 *      it calls never returns (contractMismatchRefusal: check_asserts_contract_mismatch) writes no check: the gap stays
 *      unarmed (fail closed), and so does one whose calls never reach the gap's region (checkMissesRegionRefusal:
 *      check_call_misses_region). The first failure's error line and Expected/Received are kept on the ledger. No region is written, so
 *      the arm-time region gate has nothing to refuse; the write still passes through it.
 *
 * OUTCOME (the dispatch is read back; a dispatch alone earns no credit): every dispatch records the node that sent
 * it (dispatch_node, the substrate's bootstrap identity) and its goal-host. A gap still at goal_dispatched with no new
 * titles has its goal's outcome read from THAT node's goal-host (GET /executions/:id, the contract dispatch-goal.ts
 * reads): running waits; terminal and not reached is a FAILED attempt with the reach reason (state dispatch_failed);
 * terminal and reached with no new title after a grace is failed too. An outcome that cannot be read (not found on the
 * host, host unreachable, a status this code does not know, a dispatch owned by another node that never
 * settles) is never read as failed: it waits, loudly, and only past a shaped staleness bound becomes dispatch_lost with
 * WHY it was lost. A record with no dispatch id is never lost: goal_dispatched is written only with the id, and the
 * record before the send (send_pending) is recovered by its own node as the unconfirmed send it is (a non-attempt).
 * A settled gap (failed or lost) is retried after its backoff ahead of fresh gaps, and a gap whose goal is in flight
 * is never sent a second one. A gap whose target the live autonomyScope excludes gets no goal and one skip record
 * (state scope_excluded): the lane could never land it. Bounds are read from the family's rhythm body.
 * PLACEMENT (compose-placement.ts, law 11): with no free local compose slot of the supply's class, the goal goes through
 * the development-vessel of a peer that composes the vessel, sees the row, admits the targets and has a free slot, so
 * the compose runs where capacity is while the store holder stays authoritative for the row. Its ledger names that
 * peer as dispatch_node (placed_by this node). Its outcome is read back through that peer (its dispatch_host answers a
 * composeOwnership read naming the dispatch from its own goal-host) and settles as read; a peer that answers no dispatch
 * leaves it unread, settled by arming or, unsettled, by dispatch_timeout_hours.
 *
 * CADENCE IS A RHYTHM (law 5). The family's timeShapedRhythm impulse is read at use time: no rhythm means no
 * work (reason no_rhythm), a rhythm not due by the conductor's own formula (rhythmDueScore) means no DISPATCH (the
 * bookkeeping, ARM, OUTCOME, the own-check un-arm and the hold release, runs on every pass, at most once per shaped
 * bookkeeping_min_interval_s when undue), and the per-tick bound, backoff and attempt cap come from the same impulse's
 * body. DEMAND makes it due: an undue pass that finds a sendable row and fewer than max_per_tick of this node's goals in
 * flight writes the staleness at which that formula reads due, so the next conductor pass fires it. The rhythm conductor fires the family through FAMILY_RESOLVERS and leaves it PENDING, and on its other passes
 * asks for the bookkeeping alone through FAMILY_BOOKKEEPING (bookkeeping_only); this resolver settles its family from
 * its REPORT when it completes (checkSupplySettlementLeg), whichever entry ran it, so no exit is ever credited as success.
 *
 * MEASURES (counters on the report, not traces): of the armed gaps whose check was born in the window, the
 * share whose check the system wrote (predicate_source gap_check_supply), and of those the share verified red
 * at HEAD (predicate_birth_verdict present).
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { ResolverResult } from "./types.js";
import { birthTreeMoved, checkSupplyExpectationOf, class2PredicateKey, DETECTOR_ROW_UNARMABLE_REASON, gapStoreIsLocal, judgedInputsOf, landedCheckSource, postConsumerTrace, predicateSuspect, resolveSubstrateGap, resolveSubstrateGapWrite, sameJudgedInputs, takeBirthVerdictWithReport, unrenderedBindingToken, type JudgedInputs, type MintedBirthVerdict } from "./substrate-gap.js";
import { noteGapLocalization } from "./gap-localization.js";
import { type Ledger, type Row, JUDGED_NOT_ARMED, nonEmpty, TEST_WRITING_STAGE_RE, outcomeKindOf, CHECK_SUPPLY_FAMILY, posNum, type OutcomeBounds, outcomeBoundsOf, checkSupplyNode, type LostWhy, type DispatchProbe, probeDispatch, dispatchVerdict, GOAL_HOST_ENDPOINT } from "../landing/check-supply-dispatch.js";
export { landedCheckSource, type LandedCheck } from "./substrate-gap.js";
import {
  CHECK_SUPPLY_DISPOSITION,
  composeEligibilitySkipReason,
  EDIT_SITE_IS_OWN_CHECK,
  editSiteIsOwnCheck,
  gapEditSite,
  ownCheckUnarmMeta,
  isAwaitingLandVerification,
  isParkingDisposition,
  PARKING_DISPOSITIONS,
} from "../judge/gap-eligibility.js";
import { autonomyScopeExcludes, editSitePath, identifyVessel, parseScopeExceptions, type AutonomyScope } from "../judge/gap-policy.js";
import { causeClearsNeedsRegion, noteCauseAnchorGoal, settleCauseAnchor, statedCauseOf } from "./check-region-cause-anchor.js";
import { checkImportsEditSite, checkSupplyCheckPath, configEditSite, castCalleeRefusal, configSiteCheckGoal, consumerResolverModules, contractMismatchRefusal, exportGuardUnavailable, MISSING_EXPORT_STAGE, missingExportRefusal, moduleExports, srcReaderAt, vesselRelativeEditSite, type SrcReader } from "./check-supply-admission.js";
import { codeContract, type CodeContract } from "./code-introspect.js";
import { VESSEL_TEST_FILE_RE } from "./vessel-paths.js";
import { isSystemBornLineage, lineageIndex } from "./operator-acts.js";
import { readFamilyRhythm, rhythmDueScore, rhythmSettlementOverlay, writeFamilyRhythm, type RhythmBody } from "./rhythm-conductor-tick.js";
// The check-run judge lives with the evaluator (scope-earn-in.ts, an excluded file): item 2 reads it from there.
import { coverageKnobs, RAN_PACING, redForTheRightReason, regionStatementMutant, selectMutants, type Mutant } from "./scope-earn-in.js";
import { MAX_GOAL_LEN, resolveDispatchGoal } from "./dispatch-goal.js";
import { dispatchGoalOnPeer, placeCompose, placementArmKnobs, readPlacedDispatch } from "./compose-placement.js";
import { armRedReasonRefusal, testTitleInSource, type CheckRunClass } from "./retry-evidence.js";
import { onlyTestsProblem, resolveTestSuite } from "./test-suite.js";
import { selfAuthHeaders } from "../lib/self-auth.js";
import { METABOB_API_KEY, VOLUME_ROOT } from "../config.js";
import { gapCheckTimeoutMs, sweepGitOut } from "../judge/gap-check-judge.js";
import { countLiteral, regionFromProposalText, regionOf } from "../lib/region-literal.js";
import { classifyTestDefect, TEST_DEFECT_CERTIFIER_SHAPE, type TestDefectClassification } from "../lib/child-script-parse.js";
import { resolvePoolImpulse } from "./pool-impulse.js";
// THE ARM STEP'S PREDICATES LIVE IN check-supply-admission.ts (user ruling, arm pre-check option i): moved there
// unchanged so the test-writing verify (feature-compose.ts) reads them from lane core, never from this lane-editable
// module. Re-exported here, so every importer of gap-check-supply is unchanged; imported here for the arm step itself.
import { firstFailureOf, clonesRoot, codeOnly, falsifiableAnchors, CHECK_NO_CONTROL_STAGE, CHECK_NO_CONTROL_REASON, splitRedGreen, noControlRefusal, TEST_TITLE_CALL_RE, decodedTitle, declaredTestTitles, holderCheckReport, siteRegionSource, checkMissesRegionRefusal, mutantRun, editSiteMutationGate, REGION_RED_UNCHANGED_STAGE, regionGateApplies, explainedTextRegion, regionMutantGate, type CheckAnchor, type AnchorSources, type MutationGateOutcome } from "./check-supply-admission.js";
export { commentFreeSource, anchorOccurrences, TOKEN_ANCHOR_MAX, falsifiableAnchors, CHECK_NO_CONTROL_STAGE, CHECK_NO_CONTROL_REASON, splitRedGreen, noControlRefusal, declaredTestTitles, mutationGateVerdict, siteRegionSource, CHECK_MISSES_REGION_STAGE, checkMissesRegionRefusal, REGION_RED_UNCHANGED_STAGE, regionGateApplies, explainedTextRegion, allOccurrencesMutant, editSiteMutationGateAt, regionMutantGateAt } from "./check-supply-admission.js";
export type { CheckAnchor, AnchorSources, MutationGateOutcome } from "./check-supply-admission.js";
/** The predicate_source a system-authored check carries: the discriminator the measures count. */
export const CHECK_SUPPLY_SOURCE = "gap_check_supply";

const DEV_SELF_ENDPOINT = process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";
const SELF_RESOLVE_URL = `${DEV_SELF_ENDPOINT}/v2/impulses/resolve`;
/** The record written BEFORE the send (CHANGE-30 record before send): no dispatch id yet, so never goal_dispatched. */
export const SEND_PENDING = "send_pending";
/** How many arm entries a ledger keeps (check_supply.arms); the oldest is dropped past it. */
const ARM_HISTORY_MAX = 5;
const settledHistory = (l: Ledger): Row[] => {
  const prior = Array.isArray(l.history) ? l.history.slice(-4) : [];
  if (l.state === "dispatch_failed" || l.state === "dispatch_lost")
    return [...prior, { attempt: Number(l.attempts ?? 0), state: l.state, reason: l.reason ?? "", outcome: l.outcome ?? {} }];
  if (JUDGED_NOT_ARMED.has(String(l.state ?? "")))
    return [...prior, { attempt: Number(l.attempts ?? 0), state: l.state, reason: l.reason ?? "", titles: Array.isArray(l.judged_titles) ? l.judged_titles : [] }];
  return prior;
};

export interface GapCheckSupplyTickPointer {
  type: "gap_check_supply_tick";
  /** The tick's clock (ms). Tests pin it; production reads Date.now(). */
  now_ms?: number;
  /** Carried by the conductor's FAMILY_RESOLVERS entry ("report"): this resolver settles its family by its report. */
  settled_by?: string;
  /** Carried by the conductor's FAMILY_BOOKKEEPING entry: the bookkeeping steps only (arm, outcome, un-arm, hold
   *  release), never a dispatch, whatever the rhythm's due-ness. */
  bookkeeping_only?: boolean;
  dry_run?: boolean;
}

const metaOf = (row: Row): Row => {
  const m = row["classification_metadata"] ?? row["metadata"];
  return (m && typeof m === "object" ? m : {}) as Row;
};
const ledgerOf = (meta: Row): Ledger => (meta["check_supply"] && typeof meta["check_supply"] === "object" ? meta["check_supply"] : {}) as Ledger;
const falsifierClassOf = (meta: Row): string => {
  const f = meta["falsifier"];
  return String((f && typeof f === "object" ? (f as { class?: unknown }).class : f) ?? "").toLowerCase();
};
const runtimeRoot = (): string => process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";

/** The arm's and the re-evaluation's reason for a check that is in no landed tree. */
export const CHECK_NOT_LANDED = "check_not_landed";

/**
 * IS THIS CLONE'S origin/dev CURRENT ENOUGH TO SAY A CHECK IS NOT THERE? An "absent" read from a STALE ref (the mirror
 * did not move it, a fetch failed) would take back an arm on a check that did land. So an absent decides only when
 * origin/dev contains the sha this node's pull-sync gate last verified for the vessel (its marker
 * <volume>/.pull-sync/<vessel>.gated-sha, the one pull-sync reads first). A missing or malformed marker, or a ref
 * that does not contain it, is not current: nothing is decided. `cache` holds the answer per vessel for the tick.
 * The marker is runtime state pull-sync writes (its MARKER_DIR), so it is read under VOLUME_ROOT, never WORKSPACE_ROOT:
 * the env file points that at the super-repo clone, where no marker is, and every tick read "no readable gated-sha
 * marker", so no false arm was ever taken back.
 */
let pullSyncMarkerDir = join(VOLUME_ROOT, ".pull-sync");
/** Tests point the marker dir at a temp dir (null restores the volume's); the vessel never calls it. */
export function __setPullSyncMarkerDirForTests(dir: string | null): void { pullSyncMarkerDir = dir ?? join(VOLUME_ROOT, ".pull-sync"); }
export function originDevCurrent(vessel: string, cache?: Map<string, { current: boolean; why: string }>): { current: boolean; why: string } {
  const hit = cache?.get(vessel);
  if (hit) return hit;
  let out: { current: boolean; why: string };
  let gated = "";
  try { gated = readFileSync(join(pullSyncMarkerDir, `${vessel}.gated-sha`), "utf-8").trim(); } catch { gated = ""; }
  if (!/^[0-9a-f]{40}$/i.test(gated)) out = { current: false, why: `no readable gated-sha marker for ${vessel}` };
  else if (sweepGitOut(join(clonesRoot(), vessel), ["merge-base", "--is-ancestor", gated, "origin/dev"]) === null) out = { current: false, why: `origin/dev does not contain the gated sha ${gated.slice(0, 12)}` };
  else out = { current: true, why: "" };
  cache?.set(vessel, out);
  return out;
}

/**
 * NEEDS-LOCALIZATION: an open gap the lane cannot take only because it has no check of its own (or no edit site),
 * and that nothing else holds. null for every gap that is compose work already, held by a human or a landing,
 * closed, carrying a literal predicate of its own (a different repair), routed elsewhere (orphan producers), or a
 * detector row nothing can arm (substrate-gap.ts A DETECTOR ROW NOTHING CAN ARM: no site and no file to localize from).
 */
export function checkSupplyDisposition(row: Row): typeof CHECK_SUPPLY_DISPOSITION | null {
  if (String(row["status"] ?? "open") !== "open") return null;
  const meta = metaOf(row);
  if (meta["operator_hold"] === true || isParkingDisposition(meta["disposition"]) || isAwaitingLandVerification(row)) return null;
  // Skip re-commit children: these summarize a discarded draft's failure, not a HEAD defect.
  // feature_compose files these with summary 'compose for gap X repeated already-recorded failure class <cls>: ...'
  // and classification_metadata { re_commit:true, source_gap_id, root_gap_id, failure_class, edit_site } (feature-compose.ts:5340-5358).
  // BY THE MARKER ONLY, never by the id: an id is a name, and a real defect gap may start with the word (the open
  // recommit-children-are-never-retired-when-their-parent-is-fixed is ABOUT re-commits). The id-prefix fallback
  // skipped every such row forever, unsupplied.
  if (meta["re_commit"] === true && nonEmpty(meta["failure_class"])) return null;
  if (nonEmpty(meta["expected_literal"]) || nonEmpty(meta["hardcoded_url"])) return null;
  if (String(meta["falsifier_unresolvable_reason"] ?? "").startsWith(DETECTOR_ROW_UNARMABLE_REASON)) return null;
  const cat = String(row["category"] ?? "");
  if (cat === "orphaned_capability" || cat === "unreachable_producer") return null;
  const skip = composeEligibilitySkipReason(row);
  return skip === "unarmed" || skip === "no_edit_site" ? CHECK_SUPPLY_DISPOSITION : null;
}

/** The vessel a gap's test belongs in: the lane's own identification first, then a vessel named in the summary. */
export function checkSupplyVessel(row: Row): string | null {
  const meta = metaOf(row);
  const ledgerVessel = ledgerOf(meta).vessel;
  if (typeof ledgerVessel === "string" && /^[A-Za-z0-9_.-]+$/.test(ledgerVessel)) return ledgerVessel;
  const known = identifyVessel(row, meta);
  if (known) return known;
  const summary = String(row["summary"] ?? "");
  const exists = (v: string): boolean => existsSync(join(runtimeRoot(), v)) || existsSync(join(clonesRoot(), v));
  const named = /repos\/([A-Za-z0-9_.-]+)\//.exec(summary)?.[1];
  if (named && exists(named)) return named;
  for (const m of summary.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:vessel|api))\b/g)) {
    if (m[1] && exists(m[1])) return m[1];
  }
  return null;
}

/** The file a gap's check is written to: one per gap, OUT OF SUITE, test/checks/<checkSupplyCheckFile(gapId)> (the slug
 *  is defined once, in check-supply-admission.ts, where feature_compose's R3 gate allows exactly this path). */
export function checkSupplyTestFile(gapId: string): string {
  return checkSupplyCheckPath(gapId);
}

/** The split the control arm was born with: half of all gaps, by hash parity. */
export const HISTORICAL_CONTROL_FRACTION = 0.5;
/** A gap's experiment arm, stable for its id. Control-arm gaps are classified but get no goal, so the supply's effect
 *  on arming and closure can be measured against gaps it did not touch (law 12).
 *
 *  THE SPLIT IS SHAPED. It was a fixed half, an indefinite hold over about 41% of the system's own detections with no
 *  end date or review (user ruling 2026-10-14: lift it after the capacity window, the fraction moving into the supply
 *  rhythm's record with a default of 0, so the system can set it). The tick passes the record's control_fraction. The
 *  id's position is a stable value in [0,1) built so that at exactly 0.5 the arms are the historical parity arms (the
 *  earlier measurement stays comparable); 0 puts every gap in treatment, 1 every gap in control. */
export function checkSupplyArm(gapId: string, controlFraction: number = HISTORICAL_CONTROL_FRACTION): "treatment" | "control" {
  const b = createHash("sha256").update(gapId).digest()[0]!;
  const position = ((((b & 1) ^ 1) * 128) + (b >> 1)) / 256; // parity 1 (the historical control) falls in [0, 0.5)
  return position < controlFraction ? "control" : "treatment";
}

/** The control arm's documented default time-box, used only when the rhythm body has no control_expiry_days. */
export const CONTROL_EXPIRY_DAYS_DEFAULT = 7;
/** A row's arm as the tick reads it: a row whose control arm EXPIRED is treatment for good (sticky), whatever its hash
 *  says; every other row is checkSupplyArm's, unchanged. */
export function checkSupplyRowArm(row: Row, controlFraction: number): "treatment" | "control" {
  if (nonEmpty(metaOf(row)["gap_check_supply_arm_expired_at"])) return "treatment";
  return checkSupplyArm(String(row["id"]), controlFraction);
}
/**
 * THE CONTROL ARM IS TIME-BOXED (user ruling). A control row was held (CHECK_SUPPLY_DISPOSITION) forever,
 * with no arm timestamp, so the hold kept it from every other arming route too. Now a control row carries
 * gap_check_supply_arm_at; one older than the rhythm's control_expiry_days moves to treatment
 * (gap_check_supply_arm_expired_at) and its supply hold, and only that disposition, is cleared. A control row with no
 * stamp is stamped now and not expired: its clock starts at the stamp, so no backlog flips on one tick.
 */
export function controlArmStep(row: Row, now: number, expiryMs: number): { kind: "stamp"; meta: Row } | { kind: "expire"; meta: Row; days: number } | null {
  const meta = metaOf(row);
  if (meta["gap_check_supply_arm"] !== "control" || nonEmpty(meta["gap_check_supply_arm_expired_at"])) return null;
  const at = Date.parse(String(meta["gap_check_supply_arm_at"] ?? ""));
  if (!Number.isFinite(at)) return { kind: "stamp", meta: { gap_check_supply_arm_at: new Date(now).toISOString() } };
  if (now - at <= expiryMs) return null;
  return {
    kind: "expire",
    days: (now - at) / 86_400_000,
    meta: { gap_check_supply_arm: "treatment", gap_check_supply_arm_expired_at: new Date(now).toISOString(), ...(meta["disposition"] === CHECK_SUPPLY_DISPOSITION ? { disposition: "" } : {}) },
  };
}

const symptomOf = (summary: string, max = 600): string => summary
  .replace(/^(?:Close substrate gap [\w:.!-]+:\s*)+/, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max)
  .replace(/[\s.]+$/, "");

/** The edit site as the check imports it: its path relative to the check file, without the extension. */
function importSpecifier(testFile: string, siteRel: string): string {
  const from = testFile.split("/").slice(0, -1);
  const to = siteRel.replace(/\.(?:[cm]?[jt]sx?)$/, "").split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(i).join("/")}`;
}
export const NO_ANCHOR_REASON = "evidence names no falsifiable anchor";
const DECLARATION = /\b(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
/** The names declared in a source file (code only). */
export function declaredNames(src: string): Set<string> {
  return new Set([...codeOnly(src).matchAll(DECLARATION)].map((m) => m[1]!));
}
/**
 * THE ANCHORS STEP 3 BUILDS A CHECK ON (user ruling on the anchor census): the evidence's own (falsifiableAnchors over
 * the summary and falsifier_spec) first, unchanged. Only a row those leave with none falls through to what its writers
 * already put there: (a) its region literal (classification_metadata.region, else the `in the region "X"` clause
 * goal-host's restateWithTargetFile writes into a route-edit summary) when it occurs exactly once in the site; (b) the
 * snake_case and camelCase site tokens it names (the region gate's `site_tokens` rule); then (c), for an "investigate
 * and decompose gap <parent>:" wrapper (gap-to-feature's decompose goal), the PARENT row's summary and falsifier_spec
 * against the wrapper's own site. The parent id is a structured field when the row has one, else the id that prefix
 * names; the parent is read from the pass's store read, never fetched. Nothing anchors: [] (no check, as before).
 * semantic_gate_reason and failure_lessons describe a rejected patch, so they are never sources.
 */
const DECOMPOSE_WRAPPER = /^investigate and decompose gap (\S+?):\s/i;
const PARENT_FIELDS = ["parent_gap_id", "root_gap_id", "source_gap_id"] as const;
/** The parent a decompose wrapper names: a structured field first, the summary prefix's id only when there is none. */
export function decomposeWrapperParentId(row: Row): string | null {
  const m = DECOMPOSE_WRAPPER.exec(String(row["summary"] ?? ""));
  if (!m) return null;
  const meta = metaOf(row);
  const field = PARENT_FIELDS.map((k) => meta[k]).find(nonEmpty);
  return field !== undefined ? String(field).trim() : m[1]!;
}
export function checkSupplyAnchors(row: Row, siteSrc: string | null, byId: ReadonlyMap<string, Row>, vesselDeclared: ReadonlySet<string> | null = null): { anchors: CheckAnchor[]; parent: string | null } {
  const of = (r: Row): CheckAnchor[] => {
    const meta = metaOf(r);
    const summary = String(r["summary"] ?? "");
    const spec = typeof meta["falsifier_spec"] === "string" ? String(meta["falsifier_spec"]) : "";
    const own = falsifiableAnchors(summary, siteSrc, spec, vesselDeclared);
    if (own.length > 0 || siteSrc === null) return own;
    return falsifiableAnchors(summary, siteSrc, spec, null, { site_tokens: true, region: regionOf(meta) || regionFromProposalText(summary) });
  };
  const anchors = of(row);
  if (anchors.length > 0) return { anchors, parent: null };
  const pid = decomposeWrapperParentId(row);
  const parent = pid !== null ? byId.get(pid) : undefined;
  if (!parent || pid === String(row["id"] ?? "")) return { anchors: [], parent: null };
  const inherited = of(parent);
  return { anchors: inherited, parent: inherited.length > 0 ? pid : null };
}
/**
 * A SYMBOL ANCHOR IS NOT A CALLABLE UNLESS THE SITE EXPORTS IT. A symbol anchors a check when it resolves in the site's
 * code, and an internal function does: the goal then said "Build it on … symbol `universalToolFallback` …: call the
 * code", the drafter called it off the namespace import, and the verify refused the check,
 * check_references_missing_export (f176b321, three times on goal-host src/index.ts). Given the site's exported names
 * (its codeContract, the list the goal shows), a symbol anchor it does not export is said to be internal and reached
 * through an export on the list. No names (no reader, an unreadable site, an open list) labels nothing.
 */
const anchorText = (anchors: readonly CheckAnchor[], site?: { rel: string; exported: ReadonlySet<string> }): string => anchors.map((a) => a.kind === "symbol" ? `symbol \`${a.value}\`${site && !site.exported.has(a.value) ? ` (internal to ${site.rel}, not exported: the test cannot call it, so reach it through an export on the list that does)` : ""}` : a.kind === "text" ? `text ${JSON.stringify(a.value)}` : a.kind === "token" ? `token \`${a.value}\`` : a.kind === "region" ? `region ${JSON.stringify(a.value)} (the one line of the site holding it)` : `behaviour "${a.value}"`).join("; ");

/**
 * QUOTE WHAT THE GATE WOULD READ AS AN UNRENDERED BINDING (CHANGE-32a). A check goal is built from a gap's own prose,
 * and a gap ABOUT placeholders quotes them ({{…}}, {{goal.id}}): pre-gate rows hold them unquoted. The gap-store write
 * gate (substrate-gap.ts unrenderedBindingToken) then refuses the whole ledger write that carries the goal, so the
 * supply could never record what it sent. The gate's own definition of a QUOTATION is a token wrapped in backticks;
 * this wraps exactly the tokens the gate flags, using the gate's own rule, until it flags none. One definition.
 */
export function quoteUnrenderedTokens(s: string): string {
  let out = s;
  for (let guard = 0; guard < 100; guard++) {
    const t = unrenderedBindingToken(out);
    if (t === null) return out;
    let i = out.indexOf(t);
    while (i >= 0 && out[i - 1] === "`" && out[i + t.length] === "`") i = out.indexOf(t, i + 1);
    if (i < 0) return out;
    out = `${out.slice(0, i)}\`${t}\`${out.slice(i + t.length)}`;
  }
  return out;
}
/**
 * THE GOAL BUDGET (MAX_GOAL_LEN, dispatch-goal.ts). dispatch_goal refuses a goal over the bound whole, so a goal the
 * parts push past it lost every part, the row's must-fail or falsifier_spec sentence with it. The other parts keep
 * their own bounds (the export list and signatures, the region line, the row texts, the prior attempt) and are never
 * cut here; the symptom is cut LAST, to what they leave: a goal over the bound is rebuilt with the symptom shortened by
 * the overflow, so the expected-value sentence stays intact. A goal inside the bound is unchanged; one still over it with no symptom left is
 * returned as before, and dispatch_goal refuses it.
 */
export function checkSupplyGoal(vessel: string, testFile: string, summary: string, site: string | null = null, reader?: SrcReader, anchors: readonly CheckAnchor[] = [], prior: readonly Row[] = [], meta: Row | null = null): string {
  const whole = quoteUnrenderedTokens(checkSupplyGoalText(vessel, testFile, summary, site, reader, anchors, prior, meta));
  let goal = whole;
  for (let max = symptomOf(summary).length; goal.length > MAX_GOAL_LEN && max > 0;) {
    max = Math.max(0, max - (goal.length - MAX_GOAL_LEN));
    goal = quoteUnrenderedTokens(checkSupplyGoalText(vessel, testFile, summary, site, reader, anchors, prior, meta, max));
  }
  return goal.length > MAX_GOAL_LEN ? whole : goal;
}
/**
 * THE DRAFTER IS TOLD THE REGION THE GATE WILL REPLACE (law 8). The arm step's region gate (regionMutantGate) replaces
 * the statement the row's evidence derives (explainedTextRegion) and refuses a check whose red survives it, but the
 * goal never named that statement: the drafter learned the region only from a refusal. Given the row's metadata, the
 * goal now carries the same derivation, over the same inputs (the summary, falsifier_spec, must_fail and control) and
 * under the same rule (regionGateApplies), so the drafter's anchor and the gate's cannot diverge: the anchor, the
 * statement at path:line, and what that statement produces. No derivable region: nothing is added.
 */
export function regionInputsOf(meta: Row): { spec: string; more: AnchorSources } {
  return { spec: typeof meta["falsifier_spec"] === "string" ? String(meta["falsifier_spec"]) : "", more: { must_fail: typeof meta["must_fail"] === "string" ? String(meta["must_fail"]) : undefined, control: typeof meta["control"] === "string" ? String(meta["control"]) : undefined, cause: statedCauseOf(meta) } };
}
/** What a region statement produces, read off its text: a return value, a throw, a log line or a state write. */
export function regionObservable(statement: string): string {
  const s = statement.trim();
  if (/^return\b/.test(s)) return "the value it returns";
  if (/^throw\b/.test(s)) return "the error it throws";
  if (/\bconsole\.(?:log|warn|error|info|debug)\s*\(|\b(?:log|logger\.\w+)\s*\(/.test(s)) return "the line it logs";
  if (/^(?:await\s+)?[\w$.[\]"'`]+\s*(?:[-+*/%&|?]{0,2}=)(?!=)|\.(?:set|push|add|delete|unshift|splice)\s*\(|\b(?:writeMeta|write\w*|persist\w*)\s*\(/.test(s)) return "the state it writes";
  return "what that statement does";
}
export function regionGoalSentence(siteRel: string, siteSrc: string | null, summary: string, meta: Row): string {
  if (siteSrc === null || !regionGateApplies(meta, siteSrc)) return "";
  const { spec, more } = regionInputsOf(meta);
  const region = explainedTextRegion(siteSrc, siteRel, summary, spec, more).region;
  if (!region) return "";
  const m = region.mutant;
  const first = regionStatementMutant(siteSrc, m.start, m.start + 1, siteRel)?.original ?? m.original;
  const shown = m.original.replace(/\s+/g, " ").slice(0, 160);
  const at = `${siteRel}:${m.line}`;
  const more1 = region.occurrences > 1 ? ` (with its ${region.occurrences - 1} other occurrence(s) there)` : "";
  return `The gap's region, derived from its evidence: ${region.kind} anchor ${JSON.stringify(region.anchor.slice(0, 120))} at ${at}${more1}, the statement \`${shown}\`. ` +
    `Assert on THIS: ${regionObservable(first)} at ${at}. The arm step replaces that statement, and a check whose red survives the replacement is refused. `;
}
function checkSupplyGoalText(vessel: string, testFile: string, summary: string, site: string | null = null, reader?: SrcReader, anchors: readonly CheckAnchor[] = [], prior: readonly Row[] = [], meta: Row | null = null, symptomMax?: number): string {
  const siteRel = vesselRelativeEditSite(site);
  // A CONFIG EDIT SITE (an activity seed or template) gets the consumer-behaviour goal (check-supply-admission.ts
  // configSiteCheckGoal): the arm step refuses a check that only reads the template's literals.
  const cfg = reader && siteRel ? configEditSite(siteRel, reader.read(siteRel)) : null;
  if (cfg && siteRel) {
    const consumerImports = consumerResolverModules(cfg.resolvers, reader!).map((module) => ({ module, spec: importSpecifier(testFile, module) }));
    return configSiteCheckGoal({ vessel, testFile, symptom: symptomOf(summary, symptomMax), siteRel, siteImport: importSpecifier(testFile, siteRel), templates: cfg.templates, resolvers: cfg.resolvers, consumerImports });
  }
  const imp = siteRel && /\.(?:[cm]?[jt]sx?)$/.test(siteRel)
    ? `Import the module the defect lives in as a namespace, import * as mod from "${importSpecifier(testFile, siteRel)}", and assert on it`
    : "Import the src module the defect lives in as a namespace (import * as mod from \"../../src/<file>\") and assert on it";
  const codeSite = siteRel && /\.(?:[cm]?[jt]sx?)$/.test(siteRel) ? siteRel : null;
  const contract = codeSite && reader ? codeContract(codeSite, reader) : null;
  const exported = contract && !("unavailable" in contract) && contract.open === null && contract.exports.length > 0 ? { rel: codeSite!, exported: new Set(contract.exports.map((e) => e.name)) } : undefined;
  const named = anchors.length
    ? `Build it on what the evidence names (${anchorText(anchors, exported)}): call the code with an input and make the failing assertion on what it returns, throws, logs or prints (its behaviour, never its declaration). `
    : "";
  const exportsList = codeSite ? (reader ? exportListSentence(codeSite, reader, summary, contract ?? undefined) : unreadSiteSentence(codeSite)) : "";
  const regionLine = codeSite && reader && meta ? regionGoalSentence(codeSite, reader.read(codeSite), summary, meta) : "";
  return `Write ONE failing test in repos/${vessel}/${testFile} that reproduces: ${symptomOf(summary, symptomMax)}. ` +
    `Its expect() assertion fails because of the defect, not because the file fails to load: ${imp}. ` + exportsList + named + regionLine +
    mustFailControlSentence(meta) +
    priorAttemptSentence(prior) +
    "No network, no services, no timers. Do not change src/ or any other file.";
}

/**
 * THE MODULE'S REAL EXPORTS, GIVEN TO THE CHECK WRITER (F-ARM). The writer drafted without them and invented one
 * (2f36f62, route-edit-bd252f8c: `mod["shellResult"]` on goal-host src/index.ts, where shellResult is a shape name):
 * the arm step now refuses such a check (check-supply-admission.ts missingExportRefusal), and this is the fact that
 * lets the writer avoid it. The list is read by the same extractor the refusal uses (moduleExports, over the clone the
 * goal's reader reads, the tree vesselTestInventory walks for the decompose prompt) and bounded like that prompt's
 * source list: at most EXPORT_LIST_MAX names, those the gap's own words name first, then source order, the rest
 * counted. The names are clamped by characters too (EXPORT_LIST_MAX_CHARS): dispatch_goal refuses a goal over
 * MAX_GOAL_LEN (8192), and 80 long names alone could pass it. Empty when the module exports nothing.
 * THE LIST IS THE MODULE'S CONTRACT (code-introspect.ts codeContract, the contract codeIntrospectResult returns with
 * include_contract, read in-process over this reader): each function is listed with its REAL signature (`name: kind
 * (parameters): ReturnType`), whatever route exports it (`export { … }`, a re-export, a default), and the `shape`
 * strings its returns carry where the return walk reads them.
 * Told only names and kinds, the writer invented call shapes: a row object where four numbers belong, `.shapes` read
 * off a function returning string[]. Signatures are clamped each (EXPORT_SIGNATURE_MAX) and in all
 * (EXPORT_SIGNATURES_MAX_CHARS), in the list's order; a name past either bound keeps its kind and loses only its
 * signature. A site that cannot be read is SAID to be unread (unreadSiteSentence), never silently left without a list.
 */
export const EXPORT_LIST_MAX = 80;
export const EXPORT_LIST_MAX_CHARS = 3000;
export const EXPORT_SIGNATURE_MAX = 200;
export const EXPORT_SIGNATURES_MAX_CHARS = 2000;
/** What the goal says when the edit site cannot be read here: no list, said plainly. */
export function unreadSiteSentence(siteRel: string): string {
  return `${siteRel} could not be read here, so its exports and their signatures are not listed: open it before writing the test, and call only what it exports, with the parameters each function declares. `;
}
export function exportListSentence(siteRel: string, reader: SrcReader, summary: string, read?: CodeContract): string {
  const contract = read ?? codeContract(siteRel, reader);
  if ("unavailable" in contract) return contract.unavailable === "not readable" ? unreadSiteSentence(siteRel) : `${siteRel} could not be parsed here (${contract.unavailable}), so its exports and their signatures are not listed: open it before writing the test, and call only what it exports, with the parameters each function declares. `;
  const ex = { names: new Map(contract.exports.map((e) => [e.name, e.kind])), open: contract.open };
  if (ex.names.size === 0) return "";
  const words = summary.toLowerCase();
  const ranked = [...ex.names].map(([name, kind], i) => ({ name, kind, i, hit: name.length >= 3 && words.includes(name.toLowerCase()) ? 1 : 0 }))
    .sort((a, b) => b.hit - a.hit || a.i - b.i);
  const shown: typeof ranked = [];
  let chars = 0;
  for (const x of ranked) {
    if (shown.length >= EXPORT_LIST_MAX) break;
    const len = x.name.length + x.kind.length + 4; // "name: kind, "
    if (chars + len > EXPORT_LIST_MAX_CHARS) continue;
    shown.push(x);
    chars += len;
  }
  if (shown.length === 0) return "";
  const entries = new Map(contract.exports.map((e) => [e.name, e]));
  let sigChars = 0;
  const signed = new Map<string, string>();
  for (const x of shown) {
    const e = entries.get(x.name);
    if (!e?.signature) continue;
    const shapes = e.returned?.shapes?.length ? ` returning shape ${e.returned.shapes.map((s) => JSON.stringify(s)).join(" | ")}` : "";
    const v = `${e.signature}${shapes}`;
    const t = v.length > EXPORT_SIGNATURE_MAX ? `${v.slice(0, EXPORT_SIGNATURE_MAX - 1)}…` : v;
    if (sigChars + t.length + 1 > EXPORT_SIGNATURES_MAX_CHARS) continue;
    signed.set(x.name, t);
    sigChars += t.length + 1;
  }
  const more = ex.names.size - shown.length;
  return `${siteRel} exports ${more > 0 ? `${ex.names.size} names; ${shown.length} of them` : `exactly these ${shown.length} name${shown.length === 1 ? "" : "s"}`}${ex.open ? " (and what it re-exports from a module not readable here)" : ""} (name: kind${signed.size ? ", each function with its declared signature" : ""}): ` +
    `${shown.map((x) => `${x.name}: ${x.kind}${signed.has(x.name) ? ` ${signed.get(x.name)}` : ""}`).join(", ")}${more > 0 ? `, and ${more} more` : ""}. ` +
    "The test may reference only exports from this list: a name the module does not export (an internal function, a shape name, a label) is undefined on the import, so a check that reads one is refused; reach internal code through an export on the list. " +
    (signed.size ? "Call each function with the parameters its signature declares, and assert only on what its declared return type can hold (a property of an object, never of an array or a string). " : "");
}

/**
 * THE ROW'S MUST-FAIL AND CONTROL, SAID TO THE DRAFTER (law 8). The row's meta.must_fail and meta.control reached the
 * region gate (regionInputsOf) but never the goal, so the drafter guessed what the failing assertion should expect and
 * wrote no control: tonight's arming-only landing expected a literal no src line holds. The must-fail is the expected
 * (correct) value the failing assertion states. A row with no must_fail but a prose falsifier_spec (the operator-written
 * expected behaviour) has the spec said the same way: the spec reached only the region and anchor derivation, so the
 * drafter of such a row was told only to name an expected value, guessed it, and drafted red for the wrong reason.
 * With neither, the drafter is asked to name that value in the test's title. A CONTROL is always asked for, and the
 * arm step refuses a check with none (CHECK_NO_CONTROL_STAGE). Each row text is clamped to MUST_FAIL_CONTROL_MAX_CHARS,
 * as the export list is, so the goal stays inside MAX_GOAL_LEN; the spec is read only when must_fail is absent and
 * under the same clamp, so it adds no more than a must_fail does.
 */
export const MUST_FAIL_CONTROL_MAX_CHARS = 300;
export const CONTROL_REQUEST = "Write a second test, a CONTROL: an input the defect does not touch, asserting behaviour that must stay the same. It passes now and after the fix.";
const clampRowText = (v: unknown): string => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t.length > MUST_FAIL_CONTROL_MAX_CHARS ? `${t.slice(0, MUST_FAIL_CONTROL_MAX_CHARS - 1)}…` : t;
};
export function mustFailControlSentence(meta: Row | null): string {
  const mustFail = clampRowText(meta?.["must_fail"]);
  const control = clampRowText(meta?.["control"]);
  const spec = mustFail ? "" : clampRowText(meta?.["falsifier_spec"]);
  const mf = mustFail
    ? `After the fix, this must hold: ${mustFail}. The failing assertion states THAT expected value; it is red now because the code does something else. `
    : spec
    ? `After the fix, this must hold: ${spec}. The failing assertion states THAT expected value; it is red now because the code does something else. `
    : "Name the expected (correct) value in the failing test's title. ";
  return mf + `${CONTROL_REQUEST} ` + (control ? `The control: ${control}. ` : "");
}

/**
 * WHAT THE LAST JUDGED ATTEMPT SHOWED, said to the next one. Without it a check that landed green at HEAD was followed
 * by the same goal text, so the drafter wrote the same check again. The wording follows the dissent child's ("must
 * differ from … which already passes"): it names the check that did not reproduce and asks for a different one. The
 * reason is cut at 160 characters, or after the `check_references_missing_export:<symbol>` it carries when that ends
 * later (an existence_only reason puts it past 160), so the next attempt is told the name it must not read.
 */
export function priorAttemptSentence(prior: readonly Row[]): string {
  // A dispatch the goal-host refused at a test-writing stage is a judged attempt too: its check was drafted and refused
  // before it could land, so the next goal is told that stage and why (a dispatch_failed with no such stage adds nothing).
  const testWritingRefusal = (h: Row | undefined): RegExpExecArray | null =>
    h?.["state"] === "dispatch_failed" ? TEST_WRITING_STAGE_RE.exec(String(h["reason"] ?? "")) : null;
  const last = [...prior].reverse().find((h) => JUDGED_NOT_ARMED.has(String(h?.["state"] ?? "")) || testWritingRefusal(h) !== null);
  if (!last) return "";
  const tw = testWritingRefusal(last);
  if (tw) {
    const fromStage = String(last["reason"] ?? "").slice(tw.index).replace(/^[\w$]+[:=]?\s*/, "");
    return `An earlier attempt was refused at test-writing: ${tw[1]}: ${fromStage.slice(0, 160)}: write a different test that avoids that. `;
  }
  const titles = (Array.isArray(last["titles"]) ? (last["titles"] as unknown[]) : []).filter((t): t is string => typeof t === "string" && t.length > 0);
  const named = titles.length ? titles.map((t) => JSON.stringify(t)).join(", ") : "the previous check";
  if (last["state"] === "green_at_head")
    return `An earlier attempt wrote ${named}, which already PASSES at HEAD, so it does not reproduce the defect: write a different test whose assertion fails because of the defect. Tests already in the file do not count. `;
  const reason = String(last["reason"] ?? "");
  const sym = new RegExp(`${MISSING_EXPORT_STAGE}:[\\w$]+`).exec(reason);
  return `An earlier attempt wrote ${named}, which was not accepted (${reason.slice(0, Math.max(160, sym ? sym.index + sym[0].length : 0))}): write a different test that avoids that. `;
}

/** The source of the call `test("<title>", …)` / `it(…)` from its opening parenthesis to the matching close (strings skipped). */
function testBody(src: string, title: string): string | null {
  // Matched on the DECODED title, as declaredTestTitles reads it: a title written with an escape (`'the widget\'s'`)
  // is found as well.
  const m = [...src.matchAll(TEST_TITLE_CALL_RE)].find((c) => decodedTitle(c[2] ?? "") === title);
  if (!m || m.index === undefined) return null;
  let i = src.indexOf("(", m.index), depth = 0, q: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (q) { if (c === "\\") j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}
/** One expect(...) statement's text: the argument and the matcher chain, to the matcher's call. */
const EXPECTATIONS = /\bexpect\s*\(([\s\S]*?)\)\s*((?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*[A-Za-z]+\s*\(([^)]*)\))/g;
/**
 * AN EXISTENCE ASSERTION IS NEVER A FALSIFIER (C-invented-1 at the arm step). Each expect() in the named tests is
 * existence-only when it asserts only that a name exists, is defined, or has a type: `typeof x` against a type name,
 * toBeDefined / not.toBeUndefined / toBeTruthy on a bare or module member, `"x" in mod`, toHaveProperty, Object.keys
 * containment, toBeInstanceOf(Function). A check whose every assertion is one of those is refused; one behaviour assertion
 * (a call's result, a throw, an output) keeps it armable, and the red-for-the-right-reason judge decides as before.
 */
export function existenceOnlyCheck(src: string, titles: readonly string[]): { existence_only: boolean; assertions: number; existence: number } {
  let assertions = 0, existence = 0;
  const memberOrName = /^\s*[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\]))*\s*(?:as\s+[^)]*)?$/;
  // `(mod as any).x` / `(mod as Record<…>)["x"]` read as `mod.x` / `mod["x"]`: a cast does not make an access a behaviour.
  const unwrap = (a: string) => a.trim().replace(/^\((.*)\)$/s, "$1").replace(/\s+as\s+[\w<>\[\], |"]+$/, "").replace(/\(\s*([A-Za-z_$][\w$]*)\s+as\s+[^()]*(?:\([^()]*\)[^()]*)*\)/g, "$1").trim();
  for (const t of titles) {
    const body = testBody(src, t);
    if (!body) continue;
    for (const m of body.matchAll(EXPECTATIONS)) {
      assertions++;
      const arg = unwrap(m[1] ?? ""), chain = (m[2] ?? "").replace(/\s+/g, ""), val = (m[3] ?? "").trim();
      // `typeof <name or member>` asks only what a name is; `typeof f(x)` calls the code and is a behaviour.
      const typeofArg = /^typeof\s/.test(arg) && memberOrName.test(arg.replace(/^typeof\s+/, ""));
      const typeName = /^["'`](function|object|string|number|boolean|undefined|symbol|bigint)["'`]$/.test(val);
      const exists =
        (typeofArg && /\.(not\.)?(toBe|toEqual|toStrictEqual)\(/.test(chain) && typeName) ||
        (memberOrName.test(arg) && /\.(toBeDefined|toBeTruthy|not\.toBeUndefined|not\.toBeNull|not\.toBeFalsy)\(/.test(chain)) ||
        (/^["'`][\w$]+["'`]\s+in\s+/.test(arg) && /\.(toBe|toEqual)\(/.test(chain) && /^true$/.test(val)) ||
        /\.toHaveProperty\(/.test(chain) ||
        (/^Object\.(keys|getOwnPropertyNames)\(/.test(arg) && /\.(toContain|toContainEqual)\(/.test(chain)) ||
        (/\.toBeInstanceOf\(/.test(chain) && /^Function$/.test(val));
      if (exists) existence++;
    }
  }
  return { existence_only: assertions > 0 && existence === assertions, assertions, existence };
}

/** A test file, vessel-relative: a *.test / *.spec / *.check module or a path under test/ or tests/ (VESSEL_TEST_FILE_RE),
 *  or any path with a test/, tests/ or __tests__/ segment. */
export function isTestSourcePath(rel: string): boolean {
  return VESSEL_TEST_FILE_RE.test(rel) || /(^|\/)(tests?|__tests__)\//.test(rel);
}

/**
 * The gap's localized edit site: its own edit site WHENEVER the row sets one, else a src file (never a test file:
 * isTestSourcePath) its summary names that exists in the vessel clone.
 *
 * The row's edit_site is the spec. It used to win only when it sat under repos/<vessel>/ AND already existed in the
 * clone; otherwise the summary's first existing src/*.ts won instead. So a row naming a file the fix creates, or a site
 * outside the vessel tree (docs/..., scripts/...), was re-sited onto whatever file its prose mentioned first, often
 * src/index.ts, and its check was written against the wrong code. The summary fallback now runs only when no edit_site
 * is set.
 */
export function checkSupplySite(row: Row, vessel: string): string | null {
  const own = gapEditSite(row, metaOf(row))?.replace(/:\d+.*$/, "");
  if (own) return own;
  for (const m of String(row["summary"] ?? "").matchAll(/(?:repos\/[A-Za-z0-9_.-]+\/)?(src\/[A-Za-z0-9_./-]+\.ts)\b/g)) {
    const rel = normalize(m[1] ?? "");
    if (!rel.startsWith("src/") || rel.includes("..")) continue;
    // NEVER THE GAP'S OWN TEST. A failing-test row's summary names its failing test file, and a vessel whose tests live
    // under src/ (src/…/x.n1.test.ts, src/…/__tests__/x.test.ts) had that test sited as the change: edit_site_is_own_check,
    // refused on every pass. Skipped, so the scan goes on, and with no other file the localizer reads the own check's
    // call path (localizeForSupply → localizeGap, own_check_call_path).
    if (isTestSourcePath(rel)) continue;
    if (existsSync(join(clonesRoot(), vessel, rel))) return `repos/${vessel}/${rel}`;
  }
  return null;
}

/**
 * The repo paths the lane would write for a gap's check, as the autonomy scope names them: the edit site (vessel-relative,
 * prefixed ONCE — checkSupplySite already returns repos/<vessel>/<rel>) or the whole vessel, and the gap's check file.
 */
export function checkSupplyScopeTargets(vessel: string, site: string | null, testFile: string): string[] {
  const rel = vesselRelativeEditSite(site);
  return [rel ? `repos/${vessel}/${rel}` : `repos/${vessel}/`, `repos/${vessel}/${testFile}`];
}

/** The share measures over armed gaps whose check was born at or after sinceMs. */
export function checkSupplyMeasures(rows: Row[], sinceMs: number): Record<string, number | null> {
  let armed = 0, sys = 0, sysRed = 0;
  for (const row of rows) {
    const meta = metaOf(row);
    const cls = falsifierClassOf(meta);
    if (cls !== "class1" && cls !== "class2") continue;
    // When the gap was armed: the supply's own stamp for a check it wrote, else the check's birth, else its stamp.
    const at = Date.parse(String(ledgerOf(meta).armed_at ?? meta["predicate_birth_at"] ?? meta["falsifier_classified_at"] ?? ""));
    if (!Number.isFinite(at) || at < sinceMs) continue;
    armed += 1;
    if (meta["predicate_source"] !== CHECK_SUPPLY_SOURCE) continue;
    sys += 1;
    if (meta["predicate_birth_verdict"] === "present") sysRed += 1;
  }
  return {
    armed_in_window: armed,
    armed_system_authored: sys,
    system_authored_red_at_head: sysRed,
    system_authored_share: armed > 0 ? sys / armed : 0,
    red_at_head_share: sys > 0 ? sysRed / sys : 0,
  };
}

/**
 * GRADED BY THE REPORT, NOT BY THE EXIT (REALIGNMENT §2.2). Success when the tick dispatched or armed something;
 * failure when everything it tried came back refused (a dispatch refused, a check green at HEAD or red for the
 * wrong reason); nothing at all when it found nothing to do or is still waiting on a test to land.
 */
export function checkSupplySettlementLeg(c: { dispatched: number; armed: number; refused: number }): "alpha" | "beta" | null {
  // A dispatch is a promise, not a result: only an armed check is credit. A refusal, a failed or lost goal is a debit.
  if (c.armed > 0) return "alpha";
  return c.refused > 0 ? "beta" : null;
}

/**
 * ONE SETTLEMENT PER ATTEMPT: the key of one dispatch of one row (its dispatch id, or with none recorded, its send
 * instant). A failed or lost outcome whose key the rhythm already holds was settled before, and is never debited again.
 * Measured: a dispatch_failed write that the next tick undid left the row at goal_dispatched, so the same failure
 * was read back and debited on nearly every tick (one row 434 times), and the family's posterior fell to 16 against 1296.
 */
export function settledAttemptKey(rowId: string, l: { dispatch_id?: unknown; last_dispatch_at?: unknown }): string {
  const attempt = nonEmpty(l.dispatch_id) ? String(l.dispatch_id) : `@${String(l.last_dispatch_at ?? "")}`;
  return createHash("sha256").update(`${rowId}\n${attempt}`).digest("hex").slice(0, 16);
}
/** The attempt keys a rhythm body holds as settled, newest last (settled_attempts; anything else reads as none). */
export function settledAttemptsOf(body: Record<string, unknown>): string[] {
  const raw = body["settled_attempts"];
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}

/**
 * A SEND that did not dispatch, classified by the same rule: the receiver's structured outcome when its body carried
 * one, else its transport: 429 with refused:true is a refusal, 503 (draining) and no answer at all are non-attempts,
 * any other status is a failed send.
 */
export function classifySendFailure(r: ResolverResult): { kind: "non_attempt" | "refused" | "failed"; reason: string; retry_after_s?: number; http_status: number | null } {
  const body = ((r.body ?? {}) as Row);
  const http = typeof body["http_status"] === "number" ? (body["http_status"] as number) : null;
  const resp = (body["response"] && typeof body["response"] === "object" ? body["response"] : {}) as Row;
  const detail = String(body["detail"] ?? "").slice(0, 160);
  const why = typeof resp["goalReachReason"] === "string" ? `: ${String(resp["goalReachReason"]).slice(0, 160)}` : "";
  const named = outcomeKindOf(resp["outcome"]);
  if (named) return { kind: named.kind, reason: `${detail}${why}`, http_status: http, ...(named.retry_after_s ? { retry_after_s: named.retry_after_s } : {}) };
  if (http === 429 && resp["refused"] === true) return { kind: "refused", reason: `${detail}${why}`, http_status: http };
  if (http === 503 || http === null) return { kind: "non_attempt", reason: detail || "the goal-host did not answer", http_status: http };
  return { kind: "failed", reason: `${detail}${why}`, http_status: http };
}

/**
 * The wait before re-sending after the n-th CONSECUTIVE non-attempt (CHANGE-30): the kind's base delay (a refusal's
 * own retry_after_s when the receiver gave one) doubled per consecutive one, capped by the shaped maximum, and never
 * shorter than what the receiver asked for. Bounded by construction: the sends a never-taking receiver gets in any
 * window fall as the streak grows (with the defaults, 30 min doubling to a 6 h cap: at most 7 sends in 24 h).
 */
export function nonAttemptDelayMs(baseMs: number, streak: number, maxMs: number, receiverMinMs = 0): number {
  const n = Math.max(1, Math.floor(streak));
  const grown = Math.min(baseMs * 2 ** Math.min(n - 1, 30), Math.max(maxMs, baseMs));
  return Math.max(grown, receiverMinMs);
}
/** The ledger a non-attempt settles to: not charged (the send's attempt is given back), not sent before not_before. */
export function nonAttemptLedger(ledger: Ledger, kind: "non_attempt" | "refused", reason: string, delayMs: number, nowMs: number, outcome?: Row, streak?: number): Ledger {
  return {
    ...ledger,
    state: kind === "refused" ? "send_refused" : "non_attempt",
    attempts: Math.max(0, Number(ledger.attempts ?? 0) - 1),
    not_before: new Date(nowMs + delayMs).toISOString(),
    non_attempt_streak: streak ?? Number(ledger.non_attempt_streak ?? 0) + 1,
    reason,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * This node's live autonomyScope record, read from its own pool (the record's authority, as the rhythm is read). The
 * supply's skip is only a saving (it does not send a goal the lane could never land); the containment itself is the
 * lane's admission, which fails closed. So an absent or unreadable record here skips nothing and is reported.
 */
async function readScopeSelf(): Promise<AutonomyScope> {
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "autonomyScope", status: "open" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { excluded: [], readable: false, reason: `autonomyScope read HTTP ${res.status}` };
    const j = (await res.json()) as { body?: { impulses?: Array<{ body?: Row }> } };
    const body = j.body?.impulses?.[0]?.body;
    if (!body) return { excluded: [], readable: false, absent: true, reason: "no autonomyScope record" };
    const raw = body["excluded_paths"];
    const excluded = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : [];
    // excluded_path_exceptions too, read as the lane reads it: without it a lifted file under an excluded directory
    // would be skipped here as one "the lane could never land".
    const exceptions = parseScopeExceptions(body["excluded_path_exceptions"]);
    return { excluded, readable: true, reason: `autonomyScope: ${excluded.length} excluded path(s)`, ...(exceptions.length ? { exceptions } : {}) };
  } catch (err) {
    return { excluded: [], readable: false, reason: `autonomyScope unreadable: ${String((err as Error)?.message ?? err).slice(0, 120)}` };
  }
}
/**
 * A CHECK THE CODE CAN PASS BY ECHOING ITS INPUT (qa ruling A, 2026-10-24). goal-host da804a66's check passes
 * verifyGoalReached a goal containing "right predicate with a baseline" and "independent verifier", and asserts
 * /predicate.*baseline/ and /independent/ over the verdict's reason: a judge that quotes the goal back passes it, and
 * so would a "fix" that only echoes. Refused at arm, statically, as CHECK_ECHO_SATISFIABLE_STAGE, when EVERY expect()
 * in the check is satisfied by echo: it matches at least one string or regex literal (in the expect's argument or
 * its matcher's), and each of them occurs in (a string), or matches (a regex), a string literal the check passes in a
 * call to the code under test (a member of a namespace import, or a named import, of a relative module). A negated
 * expect, or one with no literal (toBe(true) on a computed value, a status number), is not echo, so a log-line check
 * whose asserted text is not in its inputs stays allowed. Same parser as siteRegionSource.
 */
export const CHECK_ECHO_SATISFIABLE_STAGE = "check_echo_satisfiable";
export function echoSatisfiableRefusal(checkSrc: string): { reason: string } | null {
  let ts: typeof import("typescript");
  try { ts = createRequire(import.meta.url)("typescript") as typeof import("typescript"); } catch { return null; }
  type Node = import("typescript").Node;
  const sf = ts.createSourceFile("c.ts", checkSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ns = new Set<string>();
  const named = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith(".")) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) ns.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) named.add(el.name.text);
    if (st.importClause.name) named.add(st.importClause.name.text);
  }
  const strings = (n: Node, out: string[]): string[] => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) { out.push(n.head.text); for (const sp of n.templateSpans) out.push(sp.literal.text); }
    ts.forEachChild(n, (c) => { strings(c, out); });
    return out;
  };
  const underTest = (e: import("typescript").Expression): boolean => {
    let x: import("typescript").Expression = e;
    while (ts.isPropertyAccessExpression(x)) { if (ts.isIdentifier(x.expression) && ns.has(x.expression.text)) return true; x = x.expression; }
    return ts.isIdentifier(x) && named.has(x.text);
  };
  const inputs: string[] = [];
  const expects: Array<{ negated: boolean; lits: Array<{ s?: string; rx?: RegExp }> }> = [];
  const literalsIn = (n: Node, out: Array<{ s?: string; rx?: RegExp }>): void => {
    if (ts.isRegularExpressionLiteral(n)) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(n.text);
      if (m) { try { out.push({ rx: new RegExp(m[1]!, m[2]!.replace(/[gy]/g, "")) }); } catch { /* unreadable: not echo */ } }
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ s: n.text });
    if (ts.isCallExpression(n) && underTest(n.expression)) return; // the code's own call is an input, not an assertion
    ts.forEachChild(n, (c) => literalsIn(c, out));
  };
  const visit = (n: Node): void => {
    if (ts.isCallExpression(n) && underTest(n.expression)) for (const a of n.arguments) strings(a, inputs);
    // expect(<arg>)[.not][.resolves|.rejects].<matcher>(<args>)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      let base: import("typescript").Expression = n.expression.expression;
      let negated = false;
      while (ts.isPropertyAccessExpression(base)) { if (base.name.text === "not") negated = true; base = base.expression; }
      if (ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === "expect") {
        const lits: Array<{ s?: string; rx?: RegExp }> = [];
        for (const a of base.arguments) literalsIn(a, lits);
        for (const a of n.arguments) literalsIn(a, lits);
        expects.push({ negated, lits });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const echoed = (l: { s?: string; rx?: RegExp }): boolean => l.s !== undefined ? l.s.length > 0 && inputs.some((i) => i.includes(l.s!)) : inputs.some((i) => l.rx!.test(i));
  if (expects.length === 0 || inputs.length === 0) return null;
  if (!expects.every((e) => !e.negated && e.lits.length > 0 && e.lits.every(echoed))) return null;
  const shown = expects.flatMap((e) => e.lits.map((l) => l.s !== undefined ? JSON.stringify(l.s) : String(l.rx))).slice(0, 6).join(", ");
  return { reason: `${CHECK_ECHO_SATISFIABLE_STAGE}: every literal the check asserts (${shown}) is already in the input it passes the code under test, so code that echoes its input passes it and no fix is measured: assert on what the code computes from an input that does not contain the expected text` };
}
/**
 * A CHECK THAT EXPECTS A LITERAL NOBODY SAID (qa ruling, 2026-10-24). development-vessel 85ca4d09's check expects
 * runGapStoreMergeMigration to return { status: "skipped", reason: "local_copy_on_forwarding_node_is_stale_and_must_be_retired" }:
 * a reason no code writes and the gap never names. Its red is the invented value's, and a "fix" that writes that
 * string turns it green. Refused at arm, statically, as CHECK_EXPECTS_INVENTED_LITERAL_STAGE, when an expected string
 * literal of a toBe / toEqual / toMatchObject / toContain / toMatch assertion (in the matcher's argument, or in the
 * initializer of the const it names) is identifier-like (the whole literal a snake_case or camelCase name: a reason
 * code, a field name), and occurs in neither the edit-site source nor the gap's own text (summary, falsifier_spec,
 * must_fail, control). It is judged after the run, after the contract rule (contractMismatchRefusal) and the cast rule,
 * so a literal the code's contract cannot return is named by the more specific contract refusal. A negated
 * assertion expects an absence and is not read. KNOWN LIMIT: a check whose expected outcome the gap's fix contradicts
 * (general inverted intent) has no deterministic gate; this catches only the invented-literal form of it.
 */
export const CHECK_EXPECTS_INVENTED_LITERAL_STAGE = "check_expects_invented_literal";
const EXPECTING_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toMatchObject", "toContain", "toMatch"]);
export function inventedLiteralRefusal(checkSrc: string, siteSrc: string | null, gapText: string): { reason: string } | null {
  if (siteSrc === null) return null;
  let ts: typeof import("typescript");
  try { ts = createRequire(import.meta.url)("typescript") as typeof import("typescript"); } catch { return null; }
  type Node = import("typescript").Node;
  const sf = ts.createSourceFile("c.ts", checkSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const consts = new Map<string, Node>();
  const collect = (n: Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const expected: string[] = [];
  const strings = (n: Node, depth = 0): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) expected.push(n.text);
    else if (ts.isIdentifier(n) && depth === 0 && consts.has(n.text)) { strings(consts.get(n.text)!, 1); return; }
    ts.forEachChild(n, (c) => strings(c, depth));
  };
  const visit = (n: Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && EXPECTING_MATCHERS.has(n.expression.name.text)) {
      let base: import("typescript").Expression = n.expression.expression;
      let negated = false;
      while (ts.isPropertyAccessExpression(base)) { if (base.name.text === "not") negated = true; base = base.expression; }
      if (!negated && ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === "expect") for (const a of n.arguments) strings(a);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // IDENTIFIER-LIKE ONLY (coordinator default, option a, 2026-10-24): a reason code or field name, snake_case or
  // camelCase, the whole literal. A prose phrase was read too: it refused a correct check expecting the fix's NEW
  // message ("refused by containment"), which no site holds yet and the gap words differently.
  const carries = (l: string): boolean => /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(l) || /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(l);
  const invented = expected.filter((l) => carries(l) && !siteSrc.includes(l) && !gapText.includes(l));
  if (invented.length === 0) return null;
  const shown = invented.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 100))).join(", ");
  return { reason: `${CHECK_EXPECTS_INVENTED_LITERAL_STAGE}: the check expects ${shown}, which occurs in neither the edit site nor the gap's own text, so its red is the invented value's and writing that text would turn it green: expect what the gap says the code must produce, in the gap's or the code's own words` };
}
/**
 * AN ARM REFUSAL REACHES THE DRAFTER (qa loop-closing ruling, 2026-10-24). A check refused at arm wrote its reason on
 * the check-supply ledger only; the drafter's evidence (drafter/evidence.ts priorAttemptFeedbackBlock, which renders
 * classification_metadata.failure_lessons, with attemptEvidenceBlock for structured records) never saw it, so the
 * next check goal's draft could repeat the refused check. A refusal of one of these classes now APPENDS a structured
 * record to the row's existing failure_lessons, under its existing cap (8, the oldest non-lock record evicted first,
 * as feature-compose keeps it): its class, stage "arm", the own check (test_file, and the failure the arm judged),
 * the full reason, and the refused check's text capped at 4 KB.
 */
// The stages, by value: REGION_RED_UNCHANGED_STAGE is declared further down, and a const is not readable before it.
export const ARM_LESSON_CLASSES: ReadonlySet<string> = new Set(["region_red_unchanged", "red_independent_of_edit_site", "check_echo_satisfiable", "check_expects_invented_literal", "check_satisfied_by_gutting"]);
export const FAILURE_LESSONS_MAX = 8;
export const ARM_LESSON_EXCERPT_MAX = 4096;
export function withArmRefusalLesson(meta: Row, a: { reason: string; testFile: string; checkSrc: string; firstFailure?: Row | null; at: string }): Row[] | null {
  const cls = /^([a-z_]+):/.exec(a.reason)?.[1] ?? "";
  if (!ARM_LESSON_CLASSES.has(cls)) return null;
  const lessons = (Array.isArray(meta["failure_lessons"]) ? [...(meta["failure_lessons"] as Row[])] : []);
  const ff = (a.firstFailure ?? null) as { name?: unknown; error?: unknown; expected?: unknown; received?: unknown } | null;
  lessons.push({
    class: cls, stage: "arm", at: a.at, reason: a.reason,
    own_check: { test_file: a.testFile, ...(ff ? { failing: [{ name: String(ff.name ?? ""), ...(ff.error != null ? { error: String(ff.error) } : {}), ...(ff.expected != null ? { expected: `Expected: ${String(ff.expected)}` } : {}), ...(ff.received != null ? { received: `Received: ${String(ff.received)}` } : {}) }] } : {}) },
    check_excerpt: a.checkSrc.slice(0, ARM_LESSON_EXCERPT_MAX),
  });
  while (lessons.length > FAILURE_LESSONS_MAX) {
    const i = lessons.findIndex((l) => l?.["no_effect_vs_parent"] !== true && !Array.isArray(l?.["constraints"]));
    lessons.splice(i >= 0 ? i : 0, 1);
  }
  return lessons;
}
/** The region gate's outcome as its one arm log line names it (`[gap-check-supply] <id>: region_gate=<outcome>`), so the
 *  unmeasured share is countable from the journal: measured-passed, refused, unmeasured: no region, unmeasured: no measurement. */
export function regionGateOutcome(g: MutationGateOutcome): string {
  if (g.kind === "refuse") return "refused";
  if (g.kind === "wait") return "waiting";
  const decided = String(g.record["decided"] ?? "");
  return decided === "unmeasured: no region" ? decided : decided.startsWith("unmeasured") ? "unmeasured: no measurement" : "measured-passed";
}
export function derivedTextRegion(siteSrc: string, siteRel: string, evidence: string, spec = "", more: AnchorSources = {}): { anchor: string; kind: "text" | "token" | "cause"; occurrences: number; mutant: Mutant } | null {
  return explainedTextRegion(siteSrc, siteRel, evidence, spec, more).region;
}
/**
 * A CHECK A GUTTED SITE PASSES (gate 9, ruling 2026-10-24). light-dispatch ac2ed275's check expects answerOutcome's
 * `ok` to be false for a resolved:false answer, and goal-host 39fbacd's expects carryForward to carry nothing: an
 * answerOutcome that always answers { ok: false }, or a carryForward that returns [], passes them, so a "fix" that
 * removes the behaviour closes the gap. ONE extra mutant (CHECK_SATISFIED_BY_GUTTING_STAGE): the body of every
 * function of the edit site the check names (a member of a namespace import, or a named import, as siteRegionSource
 * reads them; not the same-file declarations those reach) is replaced by its fallback return, one edit over the span.
 * The fallback is the function's first existing early return whose value uses nothing bound in the function (no
 * parameter, no local: `return FALLBACK;`), else the zero value of its declared return type ([], "", 0, false, null or
 * undefined for a union holding it, an object of its required fields at their zero, read through same-file aliases and
 * interfaces; {} for a type not declared in the file). Green under it (every named test passes): refused, the reason
 * the drafter's lesson. Run last, only for a check every other gate let through. A run that did not measure decides
 * nothing.
 */
export const CHECK_SATISFIED_BY_GUTTING_STAGE = "check_satisfied_by_gutting";
export const GUTTING_REASON = `${CHECK_SATISFIED_BY_GUTTING_STAGE}: a fix that removes the behaviour passes it; add a control asserting the behaviour that must remain`;
export function guttingMutant(siteSrc: string, checkSrc: string, siteRel = "m.ts"): (Mutant & { functions: string[] }) | null {
  let ts: typeof import("typescript");
  try { ts = createRequire(import.meta.url)("typescript") as typeof import("typescript"); } catch { return null; }
  type Node = import("typescript").Node;
  const check = ts.createSourceFile("c.ts", checkSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nsNames = new Set<string>();
  const wanted = new Set<string>();
  check.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !n.importClause || n.importClause.isTypeOnly || !ts.isStringLiteral(n.moduleSpecifier) || !n.moduleSpecifier.text.startsWith(".")) return;
    const nb = n.importClause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) nsNames.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) wanted.add((el.propertyName ?? el.name).text);
  });
  const reads = (n: Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && nsNames.has(n.expression.text)) wanted.add(n.name.text);
    ts.forEachChild(n, reads);
  };
  reads(check);
  const site = ts.createSourceFile("s.ts", siteSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const types = new Map<string, Node>();
  const fns: Array<{ name: string; fn: import("typescript").FunctionLikeDeclaration }> = [];
  for (const st of site.statements) {
    if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st))) types.set(st.name.text, st);
    if (ts.isFunctionDeclaration(st) && st.name && st.body && wanted.has(st.name.text)) fns.push({ name: st.name.text, fn: st });
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && wanted.has(d.name.text) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) fns.push({ name: d.name.text, fn: d.initializer });
    }
  }
  const members = (n: Node): readonly import("typescript").TypeElement[] => ts.isInterfaceDeclaration(n) || ts.isTypeLiteralNode(n) ? n.members : [];
  const zero = (t: import("typescript").TypeNode | undefined, depth = 0): string => {
    if (!t || depth > 4) return "undefined";
    const K = ts.SyntaxKind;
    if (ts.isParenthesizedTypeNode(t)) return zero(t.type, depth);
    if (t.kind === K.StringKeyword) return "\"\"";
    if (t.kind === K.NumberKeyword) return "0";
    if (t.kind === K.BooleanKeyword) return "false";
    if (t.kind === K.BigIntKeyword) return "0n";
    if (t.kind === K.VoidKeyword || t.kind === K.UndefinedKeyword || t.kind === K.AnyKeyword || t.kind === K.UnknownKeyword || t.kind === K.NeverKeyword) return "undefined";
    if (ts.isLiteralTypeNode(t)) return t.literal.getText(site);
    if (ts.isArrayTypeNode(t) || ts.isTupleTypeNode(t)) return "[]";
    if (ts.isTypeOperatorNode(t)) return zero(t.type, depth);
    if (ts.isUnionTypeNode(t)) {
      const lit = (m: import("typescript").TypeNode, k: number) => m.kind === k || (ts.isLiteralTypeNode(m) && m.literal.kind === k);
      if (t.types.some((m) => lit(m, K.NullKeyword))) return "null";
      if (t.types.some((m) => lit(m, K.UndefinedKeyword) || m.kind === K.VoidKeyword)) return "undefined";
      return zero(t.types[0], depth);
    }
    if (ts.isTypeLiteralNode(t)) return objectZero(members(t), depth);
    if (ts.isTypeReferenceNode(t)) {
      const name = t.typeName.getText(site);
      const arg = t.typeArguments?.[0];
      if (name === "Promise" || name === "PromiseLike") return zero(arg, depth + 1);
      if (name === "Array" || name === "ReadonlyArray") return "[]";
      if (name === "Set" || name === "ReadonlySet") return "new Set()";
      if (name === "Map" || name === "ReadonlyMap") return "new Map()";
      const decl = types.get(name);
      if (decl && ts.isTypeAliasDeclaration(decl)) return zero(decl.type, depth + 1);
      if (decl) return objectZero(members(decl), depth + 1);
    }
    return "{}";
  };
  const objectZero = (ms: readonly import("typescript").TypeElement[], depth: number): string => {
    const fields = ms.filter((m): m is import("typescript").PropertySignature => ts.isPropertySignature(m) && !m.questionToken).map((m) => `${m.name.getText(site)}: ${zero(m.type, depth + 1)}`);
    return fields.length ? `{ ${fields.join(", ")} }` : "{}";
  };
  /** The first early return whose value uses nothing the function binds (its parameters, its locals). */
  const earlyReturn = (fn: import("typescript").FunctionLikeDeclaration): string | null => {
    const body = fn.body;
    if (!body || !ts.isBlock(body)) return null;
    const bound = new Set<string>();
    const bind = (n: Node): void => {
      if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) bound.add(n.name.text);
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) bound.add(n.name.text);
      ts.forEachChild(n, bind);
    };
    bind(fn);
    const last = body.statements[body.statements.length - 1];
    let found: string | null = null;
    const uses = (e: Node): boolean => {
      if (ts.isIdentifier(e) && bound.has(e.text) && !(ts.isPropertyAccessExpression(e.parent) && e.parent.name === e) && !(ts.isPropertyAssignment(e.parent) && e.parent.name === e)) return true;
      if (e.kind === ts.SyntaxKind.ThisKeyword) return true;
      return ts.forEachChild(e, uses) === true;
    };
    const visit = (n: Node): void => {
      if (found !== null || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isReturnStatement(n) && n !== last && !(n.expression && uses(n.expression))) { found = n.expression ? n.expression.getText(site) : "undefined"; return; }
      ts.forEachChild(n, visit);
    };
    for (const st of body.statements) visit(st);
    return found;
  };
  const edits: Array<{ start: number; end: number; replacement: string; line: number }> = [];
  for (const { fn } of fns) {
    if (!fn.body || fn.asteriskToken) continue;
    const isAsync = (ts.getModifiers?.(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const value = earlyReturn(fn) ?? zero(fn.type);
    const promised = !isAsync && fn.type && ts.isTypeReferenceNode(fn.type) && fn.type.typeName.getText(site) === "Promise";
    const ret = promised ? `Promise.resolve(${value})` : value;
    const start = fn.body.getStart(site), end = fn.body.getEnd();
    const cast = /\.[cm]?tsx?$/.test(siteRel) ? " as any" : "";
    edits.push({ start, end, replacement: ts.isBlock(fn.body) ? `{ return ${ret}${cast}; }` : `(${ret}${cast})`, line: site.getLineAndCharacterOfPosition(start).line + 1 });
  }
  if (edits.length === 0) return null;
  edits.sort((x, y) => x.start - y.start);
  const start = edits[0]!.start, end = edits[edits.length - 1]!.end;
  let replacement = "", at = start;
  for (const e of edits) { replacement += siteSrc.slice(at, e.start) + e.replacement; at = e.end; }
  replacement += siteSrc.slice(at, end);
  return { operator: "replace_statement", start, end, original: siteSrc.slice(start, end), replacement, line: edits[0]!.line, functions: fns.filter(({ fn }) => fn.body && !fn.asteriskToken).map((f) => f.name) };
}
export async function guttingGate(a: { vessel: string; siteRel: string; testFile: string; checkSrc: string; titles: string[] }): Promise<MutationGateOutcome> {
  let src: string | null = null;
  try { src = readFileSync(join(clonesRoot(), a.vessel, a.siteRel), "utf-8"); } catch { src = null; }
  const m = src === null ? null : guttingMutant(src, a.checkSrc, a.siteRel);
  if (!m) return { kind: "pass", record: { decided: src === null ? `unmeasured: the edit site ${a.siteRel} is not readable here` : "unmeasured: the check names no function of the edit site" } };
  const { functions, ...mutant } = m;
  const record: Row = { functions, line: m.line, replacement: m.replacement.slice(0, 200) };
  const run = await mutantRun(a, mutant);
  if ("wait" in run) return { kind: "wait", detail: run.wait };
  const r = run.report;
  const applied = ((r?.["mutation"] ?? null) as Row | null)?.["applied"] === true;
  if (!applied || r?.["ran"] !== true || !(Number(r?.["total"] ?? 0) > 0)) return { kind: "pass", record: { ...record, decided: "unmeasured: the gutted run measured nothing" } };
  if (Number(r["requested_not_passing"] ?? 1) === 0) return { kind: "refuse", reason: GUTTING_REASON, record: { ...record, green: true } };
  return { kind: "pass", record: { ...record, green: false } };
}

/** Settle a report-graded family's rhythm (the conductor left it pending: directFamilySettlement). */
export async function settleFamily(rhythm: { id: string; body: RhythmBody & Row }, leg: "alpha" | "beta", d: { staleness: number; alpha: number; beta: number }, source = "gap-check-supply-tick", extra: Row = {}): Promise<void> {
  // `extra` lands in the SAME write as the leg (the settled attempt keys): a debit and its key are stored together or not at all.
  try {
    const res = await fetch(SELF_RESOLVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...selfAuthHeaders(SELF_RESOLVE_URL, SELF_RESOLVE_URL) },
      body: JSON.stringify({ impulse: { type: "poolImpulse_write", id: rhythm.id, shape: "timeShapedRhythm", source,
        body: { ...rhythm.body, ...rhythmSettlementOverlay(leg, d.alpha, d.beta, d.staleness), ...extra } } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.warn(`[gap-check-supply] rhythm ${rhythm.id} ${leg} settlement not written: HTTP ${res.status}`);
  } catch (err) {
    // The next tick re-derives due-ness from whatever the registry holds; this tick's leg (and its keys) are lost.
    console.warn(`[gap-check-supply] rhythm ${rhythm.id} ${leg} settlement lost: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }
}

/** The short key a skip reason is counted under in the dispatch pass line. */
function skipReasonKey(reason: string): string {
  if (reason === NO_ANCHOR_REASON) return "no_anchor";
  if (reason.startsWith("target ") && reason.includes("excluded by the autonomy scope")) return "scope_excluded";
  if (reason.startsWith("localized site ")) return "localized_site_excluded";
  if (reason.startsWith("localization write refused")) return "localization_refused";
  if (reason.startsWith("not sent:")) return "not_sent";
  if (reason.startsWith("dispatch failed")) return "dispatch_failed";
  if (reason.startsWith("send refused") || reason.startsWith("send not taken")) return "non_attempt";
  const m = /^([a-z_]+)(?::|\b)/.exec(reason);
  return m ? m[1]! : "other";
}

async function writeMeta(row: Row, meta: Row, opts?: Parameters<typeof resolveSubstrateGapWrite>[1], expect?: Ledger): Promise<ResolverResult> {
  return resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: { id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open", classification_metadata: meta },
    ...(expect ? { expect_check_supply: expectedLedger(expect) } : {}),
  } as never, opts);
}
/**
 * A LEDGER WRITE EXPECTS THE LEDGER IT REPLACES (substrate-gap.ts expect_check_supply, checked by the store holder
 * under its lock). Two nodes' supplies dispatched one row: the node whose compose lane was BUSY wrote its intent and
 * then its non-attempt over the other node's live record, which could then never be settled. So the intent expects
 * the ledger as this pass read it, every write after the send expects that intent, and the outcome step's writes
 * expect the dispatch they settle. A refused write wrote nothing: the other node's record stands.
 */
const expectedLedger = (l: Ledger) => checkSupplyExpectationOf({ classification_metadata: { check_supply: l } });
const ledgerMoved = (w: ResolverResult): boolean => w.shape === "structuredError" && ((w.body ?? {}) as Row)["skip_reason"] === "check_supply_precondition_failed";

/**
 * I1, LOCALIZE BEFORE ADMISSION. An armed class2 gap whose ONLY compose skip is no_edit_site needs a site, not a test:
 * admission excludes it before any localizer runs, and a test-writing goal would replace a check it already has. The
 * site comes from the gap's own evidence (checkSupplySite: a src file its summary names that exists in the vessel
 * clone), else localizeGap without the LLM, the localizer the lane already runs after a pick. A class1 or literal row
 * is never sited here (a guessed site would make a literal measurable at the guess; checkSupplyDisposition already
 * drops expected_literal and hardcoded_url rows), and a row with any site field is never re-aimed.
 * Persisted as edit_site (what eligibility reads) plus the shaped localizationRecord (gap.localization, the record
 * compose admission reads), with localized_by and localization_method beside it, outside the record's closed key set.
 * History: af21e4fe wrote edit_site from localizeGap with a flat pointer the store refused; f77676f6 fixed the wrapper
 * and dropped the payload, so the site was never persisted.
 */
export function localizableBySupply(row: Row): boolean {
  const meta = metaOf(row);
  return composeEligibilitySkipReason(row) === "no_edit_site" && falsifierClassOf(meta) === "class2" && predicateSuspect(meta) === null
    && !nonEmpty(meta["expected_literal"]) && !nonEmpty(meta["hardcoded_url"]);
}
async function localizeForSupply(row: Row, vessel: string, site: string | null): Promise<{ file: string; method: string; evidence: Array<{ read: string; why: string }> } | null> {
  if (site) return { file: site, method: "check_supply_site", evidence: [{ read: "summary", why: `the gap's summary names ${site}, which exists in the ${vessel} clone` }] };
  const { localizeGap } = await import("../landing/gap-localize.js");
  const loc = await localizeGap(row, { useLlm: false });
  if (!loc || !loc.file.startsWith(`repos/${vessel}/`) || !existsSync(join(clonesRoot(), loc.file.replace(/^repos\//, "")))) return null;
  return { file: loc.file, method: loc.method, evidence: [{ read: loc.method, why: loc.description }] };
}

/**
 * A FAILING TEST WHOSE DEFECT IS IN THE TEST ITSELF IS LOCALIZED TO THE TEST FILE (development-vessel:test-defect-
 * localization). A row whose own check (evidence_resolve test_suite) is red because a child script the test spawns does
 * not parse (`bun --eval` of a template literal whose escape the runtime cooked into the child's source) was sited on the
 * src module the child imports: every draft edited src, the check stayed red, and the one fix, in the test, was refused
 * as self-certification. Taken for an open class2 row whose own-check baseline reads red_code_reachable for its check,
 * whose edit site is not already that test file, and whose row carries no operator hold and no test_defect record.
 * The call is PER FAILING CASE (child-script-parse classifyTestDefect: a stored parse error AND an unparseable child
 * script in that case's own body, in the clone's file NOW): every case a test defect -> the row is one; only some ->
 * mixed, left as it is (its other cases are src failures); none -> nothing, no line.
 *   - variant-0 (the control): logged "would localize to the test file"; no write, no trace.
 *   - variant-1: ONE write (the write seam re-labels a half-written row unresolvable, gap-eligibility editSiteIsOwnCheck):
 *     edit_site = the test file, test_defect {cases, certifier: the child-parse check, prior_edit_site, decision_id},
 *     protected_files without the test file, a localization record, and pwt_escalated (the one-shot pwt escalation
 *     edits edit_site with no own check; a test_defect draft is admitted only through feature_compose's certifier).
 *     DEBT: pwt_escalated is reused to mean "this route is closed", recorded as test_defect.pwt_closed_by; the proper
 *     fix is gap-landing-verdict's escalation condition reading test_defect itself.
 *     The row's own check is unchanged: it still closes the row.
 * Its grade is decided by its consumer, the next compose that drafts the row (feature-compose test-defect admission):
 * a certified test-only draft that turns the own check red -> green -> reached. Under variant-1 the decision is a trace
 * (output testDefectLocalization), the credit a trace in its composition chain.
 */
export const TEST_DEFECT_LOCALIZATION_ACTIVITY = "development-vessel:test-defect-localization";
export const TEST_DEFECT_LOCALIZATION_CREDIT_ACTIVITY = "development-vessel:test-defect-localization-credit";
export const testDefectLocalizationVariantId = (variant: number): string => (variant === 0 ? TEST_DEFECT_LOCALIZATION_ACTIVITY : `${TEST_DEFECT_LOCALIZATION_ACTIVITY}-v${variant}`);
const TDL_LOG = `[${TEST_DEFECT_LOCALIZATION_ACTIVITY}]`;
type TdMaskRow = { id?: string; body?: unknown };
export type TestDefectLocalizationDeps = {
  readMasks?: () => TdMaskRow[];
  postTrace?: (t: Record<string, unknown>) => Promise<number | null>;
  /** The check file's text in the vessel clone, or null when unreadable. */
  readCheck?: (vessel: string, testFile: string) => string | null;
};
let tdlDeps: TestDefectLocalizationDeps = {};
let tdlSeq = 0;
/** Tests only: the seams the test-defect localization uses. null restores the real ones. */
export function __setTestDefectLocalizationDepsForTests(d: TestDefectLocalizationDeps | null): void { tdlDeps = d ?? {}; }
/** The variant in force for the localization at `nowIso`: the first open activityVariantMask row for it whose
 *  [from, until) holds now. None, an unknown variant or an unreadable pool: variant-0. Never throws. */
export function testDefectLocalizationVariant(nowIso: string): { variant: number; why: string } {
  return tdMaskVariant(TEST_DEFECT_LOCALIZATION_ACTIVITY, nowIso);
}
/** The variant in force for `activityId` at `nowIso`, read from the activityVariantMask pool rows (the seam above). */
function tdMaskVariant(activityId: string, nowIso: string): { variant: number; why: string } {
  let rows: TdMaskRow[];
  try {
    rows = (tdlDeps.readMasks ?? (() => resolvePoolImpulse({ type: "poolImpulse", shape: "activityVariantMask", status: "open" }).body.impulses as TdMaskRow[]))();
  } catch (err) {
    return { variant: 0, why: `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0` };
  }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== activityId) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (v !== 0 && v !== 1) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}
export type TestDefectCandidate = { vessel: string; testFile: string; failing: Array<{ name?: unknown; error?: unknown }> };
/** The row's own check and its red baseline failures when the localization may take it, else null. */
export function testDefectCandidate(row: Row): TestDefectCandidate | null {
  const meta = metaOf(row);
  if (falsifierClassOf(meta) !== "class2" || meta["operator_hold"] === true || (meta["test_defect"] !== undefined && meta["test_defect"] !== null)) return null;
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown; only_tests?: unknown } } | undefined;
  const testFile = er?.shape === "test_suite" && typeof er.input?.test_file === "string" ? er.input.test_file : "";
  const vessel = typeof er?.input?.vessel === "string" ? er.input.vessel.replace(/^repos\//, "") : "";
  if (!testFile || !vessel || !/^[A-Za-z0-9_.-]+$/.test(vessel) || testFile.startsWith("/") || testFile.split("/").includes("..")) return null;
  const site = String(gapEditSite(row, meta) ?? "").replace(/:\d+.*$/, "").replace(/^repos\/[^/]+\//, "");
  if (site === testFile || editSiteIsOwnCheck(row)) return null;
  const b = meta["own_check_baseline"] as { verdict?: unknown; test_file?: unknown; only_tests?: unknown; failing?: unknown } | undefined;
  const only = Array.isArray(er?.input?.only_tests) ? (er!.input!.only_tests as unknown[]).map(String) : [];
  if (!b || b.verdict !== "red_code_reachable" || b.test_file !== testFile || JSON.stringify(only) !== JSON.stringify(Array.isArray(b.only_tests) ? b.only_tests : [])) return null;
  const failing = Array.isArray(b.failing) ? (b.failing as Array<{ name?: unknown; error?: unknown }>) : [];
  return failing.length > 0 ? { vessel, testFile, failing } : null;
}
/** The one write that localizes a test-defect row to its test file (variant-1). */
export function testDefectLocalizationWrite(row: Row, c: TestDefectCandidate, cls: TestDefectClassification, decisionId: string, nowIso: string): Row {
  const meta = metaOf(row);
  const file = `repos/${c.vessel}/${c.testFile}`;
  const prior = gapEditSite(row, meta) ?? null;
  const protectedFiles = Array.isArray(meta["protected_files"]) ? (meta["protected_files"] as unknown[]).map(String).filter((p) => p.replace(/^repos\/[^/]+\//, "") !== c.testFile) : null;
  const why = `every failing case of its own check runs a child script that does not parse (${cls.cases.map((k) => k.why).slice(0, 1).join("")})`;
  return {
    id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open",
    classification_metadata: {
      edit_site: file,
      localized_by: "test-defect-localization",
      localization_method: TEST_DEFECT_CERTIFIER_SHAPE,
      test_defect: {
        at: nowIso, decision_id: decisionId, prior_edit_site: prior,
        // pwt_escalated below is set to CLOSE the escalation route for this row, not because it escalated: said here.
        pwt_closed_by: "test-defect-localization",
        cases: cls.cases.map((k) => ({ name: k.name, call: k.call, why: k.why })),
        certifier: { shape: TEST_DEFECT_CERTIFIER_SHAPE, vessel: c.vessel, test_file: c.testFile },
      },
      ...(protectedFiles !== null ? { protected_files: protectedFiles } : {}),
      ...(meta["relocation_hint"] !== undefined ? { relocation_hint: null } : {}),
      ...(meta["suspected_real_location"] !== undefined ? { suspected_real_location: null } : {}),
      pwt_escalated: true,
    },
    localization: { gap_id: String(row["id"]), file, evidence: [{ read: "own_check_baseline", why }], method: TEST_DEFECT_CERTIFIER_SHAPE, created_at: nowIso },
  };
}
/** THE DECISION for one candidate row. Logs one line when any failing case is a test defect; never throws. */
export async function testDefectLocalizationDecision(row: Row, nowIso: string, dryRun: boolean): Promise<{ verdict: TestDefectClassification["verdict"]; variant: number; wrote: boolean } | null> {
  try {
    const c = testDefectCandidate(row);
    if (!c) return null;
    const readCheck = tdlDeps.readCheck ?? ((v: string, f: string): string | null => { try { return readFileSync(join(clonesRoot(), v, f), "utf-8"); } catch { return null; } });
    const src = readCheck(c.vessel, c.testFile);
    if (src === null) return null;
    const cls = classifyTestDefect(src, c.failing);
    if (cls.verdict === "none") return null;
    const id = String(row["id"]);
    const m = testDefectLocalizationVariant(nowIso);
    const calls = cls.cases.map((k) => `${k.name.split(" > ").pop()}=${k.call}`).join("; ").slice(0, 600);
    const decisionId = `test-defect-localization-${id.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80)}-${Date.parse(nowIso)}-${process.pid}-${++tdlSeq}`;
    if (cls.verdict === "mixed") {
      console.log(`${TDL_LOG} decision=${decisionId} variant=${m.variant} (${m.why}) gap=${id} verdict=mixed test_file=${c.testFile} cases=[${calls}] -> left as it is (a case fails outside its child scripts)`);
      return { verdict: "mixed", variant: m.variant, wrote: false };
    }
    const outcome = m.variant === 1 ? `localized to repos/${c.vessel}/${c.testFile}` : "would localize to the test file (variant-0: no write)";
    console.log(`${TDL_LOG} decision=${decisionId} variant=${m.variant} (${m.why}) gap=${id} verdict=test_defect test_file=${c.testFile} prior_edit_site=${String(gapEditSite(row, metaOf(row)) ?? "none")} cases=[${calls}] -> ${outcome}`);
    if (m.variant !== 1 || dryRun) return { verdict: "test_defect", variant: m.variant, wrote: false };
    const w = await resolveSubstrateGapWrite({ type: "substrateGap_write", expect_status: "open", gap: testDefectLocalizationWrite(row, c, cls, decisionId, nowIso) } as never);
    if (w.shape === "structuredError") { console.warn(`${TDL_LOG} write refused for ${id}: ${JSON.stringify(w.body).slice(0, 200)}`); return { verdict: "test_defect", variant: 1, wrote: false }; }
    const vid = testDefectLocalizationVariantId(1);
    void (tdlDeps.postTrace ?? ((t: Record<string, unknown>) => postConsumerTrace(t, "test-defect-localization")))({
      execution_id: decisionId, template_id: vid, activity_id: vid, activity_variant_id: vid, status: "completed", success: true, started_at: nowIso, duration_ms: 0,
      input_shapes: ["substrateGap"], output_shapes: ["testDefectLocalization"],
      tasks: [{ id: "localize-test-defect", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`testDefectLocalization:${decisionId}`] }],
      tags: ["test_defect_localization_variant:1"],
      metadata: { testDefectLocalization: { gap_id: id, vessel: c.vessel, test_file: c.testFile, prior_edit_site: gapEditSite(row, metaOf(row)) ?? null, cases: cls.cases.length, decided_at: nowIso } },
    }).then((st) => { if (st === null || st < 200 || st >= 300) console.warn(`${TDL_LOG} own trace of ${decisionId} not posted (http=${st ?? "none"})`); })
      .catch((err) => console.warn(`${TDL_LOG} own trace of ${decisionId} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
    return { verdict: "test_defect", variant: 1, wrote: true };
  } catch (err) {
    console.warn(`${TDL_LOG} decision failed for ${String(row["id"])} (${String((err as Error)?.message ?? err).slice(0, 160)}): nothing written`);
    return null;
  }
}

/**
 * WHAT THE TEST-DEFECT PASS'S PER-TICK BUDGET COUNTS (activity development-vessel:test-defect-localization-budget).
 * Variant-0 counts every decision against max_per_tick, so a decision that writes nothing (variant-0 of the
 * localization, or a mixed row, which is never written) spends a slot on every pass: the same first rows in store order
 * fill the budget forever and a row behind them is never decided (on both nodes, 3 per pass = max_per_tick 3, and the
 * narrowed root never decided). Variant-1 counts only writes against max_per_tick, and bounds the decisions a pass makes
 * by the rhythm's test_defect_decide_max, so every candidate up to that bound is decided each pass. Both variants count
 * the candidates the budget left undecided and log one line per pass; variant-1 posts it as a trace (output
 * testDefectLocalizationBudget). Its grade is its consumer's: a row decided this pass that a variant-0 pass leaves
 * undecided, read off the localization's own decision lines.
 */
export const TEST_DEFECT_BUDGET_ACTIVITY = "development-vessel:test-defect-localization-budget";
export const testDefectBudgetVariantId = (variant: number): string => (variant === 0 ? TEST_DEFECT_BUDGET_ACTIVITY : `${TEST_DEFECT_BUDGET_ACTIVITY}-v${variant}`);
/** The default bound on decisions per pass under variant-1 (the rhythm's test_defect_decide_max overrides it). */
export const TEST_DEFECT_DECIDE_MAX = 20;
const TDB_LOG = `[${TEST_DEFECT_BUDGET_ACTIVITY}]`;
let tdbSeq = 0;
export type TestDefectPassEntry = { id: string; verdict: string; variant: number; wrote: boolean };
type TestDefectDecide = (row: Row, nowIso: string, dryRun: boolean) => ReturnType<typeof testDefectLocalizationDecision>;
/** The variant in force for the pass's budget at `nowIso` (the localization's mask seam). */
export function testDefectBudgetVariant(nowIso: string): { variant: number; why: string } {
  return tdMaskVariant(TEST_DEFECT_BUDGET_ACTIVITY, nowIso);
}
/** One due pass over the open rows. `decide` is the localization's decision (a seam for tests). Never throws. */
export async function testDefectPass(a: { open: Row[]; touched: Set<string>; perTick: number; decideMax: number; nowIso: string; dryRun: boolean; decide?: TestDefectDecide }): Promise<{ decisions: TestDefectPassEntry[]; budget: Record<string, unknown> }> {
  const decide = a.decide ?? testDefectLocalizationDecision;
  const m = testDefectBudgetVariant(a.nowIso);
  const decisions: TestDefectPassEntry[] = [];
  const decidedIds = new Set<string>();
  let wrote = 0;
  const spent = (): boolean => (m.variant === 1 ? wrote >= a.perTick || decisions.length >= Math.max(a.perTick, a.decideMax) : decisions.length >= a.perTick);
  for (const row of a.open) {
    const id = String(row["id"]);
    if (a.touched.has(id) || spent()) continue;
    const d = await decide(row, a.nowIso, a.dryRun);
    if (!d) continue;
    decisions.push({ id, ...d });
    decidedIds.add(id);
    if (d.wrote) { a.touched.add(id); wrote += 1; }
  }
  // The candidates the budget left undecided this pass (testDefectCandidate is pure; nothing is classified or read).
  let undecided = 0;
  for (const row of a.open) {
    const id = String(row["id"]);
    if (!decidedIds.has(id) && !a.touched.has(id) && testDefectCandidate(row) !== null) undecided += 1;
  }
  const budget = { variant: m.variant, per_tick: a.perTick, decide_max: m.variant === 1 ? Math.max(a.perTick, a.decideMax) : a.perTick, decided: decisions.length, wrote, undecided_candidates: undecided, decided_at: a.nowIso };
  if (decisions.length > 0 || undecided > 0) {
    const passId = `test-defect-localization-budget-${Date.parse(a.nowIso)}-${process.pid}-${++tdbSeq}`;
    console.log(`${TDB_LOG} pass=${passId} variant=${m.variant} (${m.why}) per_tick=${a.perTick} counts=${m.variant === 1 ? "writes" : "decisions"} decided=${decisions.length} wrote=${wrote} undecided_candidates=${undecided}`);
    if (m.variant === 1) {
      const vid = testDefectBudgetVariantId(1);
      void (tdlDeps.postTrace ?? ((t: Record<string, unknown>) => postConsumerTrace(t, "test-defect-localization-budget")))({
        execution_id: passId, template_id: vid, activity_id: vid, activity_variant_id: vid, status: "completed", success: true, started_at: a.nowIso, duration_ms: 0,
        input_shapes: ["substrateGap"], output_shapes: ["testDefectLocalizationBudget"],
        tasks: [{ id: "budget-test-defect-pass", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`testDefectLocalizationBudget:${passId}`] }],
        tags: ["test_defect_localization_budget_variant:1"],
        metadata: { testDefectLocalizationBudget: { ...budget, decided_ids: [...decidedIds].slice(0, 50) } },
      }).then((st) => { if (st === null || st < 200 || st >= 300) console.warn(`${TDB_LOG} trace of ${passId} not posted (http=${st ?? "none"})`); })
        .catch((err) => console.warn(`${TDB_LOG} trace of ${passId} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`));
    }
  }
  return { decisions, budget };
}

// ONE PASS AT A TIME IN THIS PROCESS, AND AN UNDUE PASS AT MOST ONCE PER bookkeeping_min_interval_s. The conductor
// asks for the bookkeeping on every pass (a heartbeat drives it about twice a minute), and two overlapping passes
// would read the same settled_attempts and debit one attempt twice. Kept in process memory, never on the rhythm row:
// any write there resets the age its due score is measured from.
let passInFlight = false;
let lastBookkeepingAt: number | null = null;

/**
 * THE LANDABLE BAND of a row, shared by the two passes that pick which gaps get work first (the own-check baseline and
 * the test-writing dispatch): 0 = system-born (operator-acts.ts isSystemBornLineage, over `byId`, the pass's store read
 * indexed once) and landable, 1 = system-born and not landable, 2 = the rest. Landable = an edit_site whose file
 * (editSitePath) the live autonomy scope does not exclude (autonomyScopeExcludes, over the tick's one scope read), and
 * no parking disposition (PARKING_DISPOSITIONS: needs_information, needs_info, awaiting_operator_review park a row out
 * of autonomous work). A row with no edit_site is not landable. An unreadable scope (or none) decides nothing: no row is
 * in band 0, so the order is the honest-first order.
 */
export function landableBandOf(row: Row, byId: ReadonlyMap<string, Row>, scope: AutonomyScope | null): 0 | 1 | 2 {
  if (!isSystemBornLineage(row, byId)) return 2;
  const m = metaOf(row);
  const site = m["edit_site"];
  return scope?.readable && typeof site === "string" && site.trim().length > 0 && autonomyScopeExcludes(scope, editSitePath(site, m)) === null && !PARKING_DISPOSITIONS.includes(String(m["disposition"] ?? "")) ? 0 : 1;
}
/** `rows` in landableBandOf order, each band keeping the order it was given. Ordering only: nothing is dropped. */
function byLandableBand(rows: Row[], byId: ReadonlyMap<string, Row>, scope: AutonomyScope | null): Row[] {
  const band = new Map(rows.map((r) => [r, landableBandOf(r, byId, scope)]));
  return [0, 1, 2].flatMap((b) => rows.filter((r) => band.get(r) === b));
}

/**
 * One own-check-baseline goal per row whose test_suite own check has no baseline fresh at its vessel's current origin/dev
 * (ownCheckBaselineFor) and no baseline goal at it, in three bands, each in landability order: system-born (isSystemBornLineage) rows the lane could
 * land, then the other system-born rows, then the rest; at most the shaped per-tick bound. Each goal is its own goal-host execution (selectable and traced); its dispatch is appended to the
 * row's own_check_baseline_dispatches (the last 5), so the same (gap, sha) is never sent twice, and each earlier
 * dispatch's execution id is read back from goal-host's record (own-check-baseline-credit.ts dispatchExecutionId) and
 * kept there: the baseline's content grade joins on it. An unreadable policy measures nothing. A failed send stops the
 * loop (the next due pass retries) and records nothing.
 */
export async function dispatchOwnCheckBaselines(
  open: Row[],
  deps: { node: string; nowIso: string; write: (row: Row, meta: Row) => Promise<ResolverResult>; send?: typeof resolveDispatchGoal; headOf?: (vessel: string) => string | null; executionIdOf?: (dispatchId: string) => Promise<string | null>; env?: Record<string, string | undefined>; byId?: ReadonlyMap<string, Row>; scope?: () => Promise<AutonomyScope> },
): Promise<Array<{ id: string; base_sha: string; dispatch_id: string }>> {
  const { readOwnCheckEnvPolicy } = await import("./own-check-baseline.js");
  const { ownCheckVesselOf, ownCheckBaselineFor, newOwnCheckLookupPass } = await import("../judge/gap-eligibility.js");
  const { dispatchExecutionId } = await import("./own-check-baseline-credit.js");
  const pol = await readOwnCheckEnvPolicy(deps.env);
  if (!pol.ok) { console.warn(`[gap-check-supply] ${pol.why}: no own-check baseline is measured this pass`); return []; }
  const max = pol.policy.own_check_baseline_per_tick;
  const sent: Array<{ id: string; base_sha: string; dispatch_id: string }> = [];
  if (max <= 0) return sent;
  newOwnCheckLookupPass(); // this tick's guard is a pass: failed own-check lookups of an earlier pass are asked again
  const { orderByLandability } = await import("../judge/gap-admission.js");
  const heads = new Map<string, string | null>();
  const headOf = deps.headOf ?? ((v: string): string | null => sweepGitOut(join(clonesRoot(), v), ["rev-parse", "origin/dev"]));
  let probes = 2 * max + 2;
  type Disp = { base_sha: string; dispatch_id: string; execution_id?: string; at?: string; node?: string };
  // HONEST ORIGIN FIRST: a row that is system-born by the autonomy judge's origin predicate (operator-acts.ts
  // isSystemBornLineage, over `byId`, the store read the pass already holds, indexed once) is measured before one that
  // is not; each group keeps landability order. The candidates are the rows the loop below would not skip for their
  // vessel, filtered first (a filter commutes with the stable sort, so the order is unchanged), so the predicate reads
  // only them.
  const byId = lineageIndex(deps.byId ?? new Map<string, Row>(open.map((r) => [String(r["id"] ?? ""), r])));
  const candidates = orderByLandability(open.filter((r) => { const v = ownCheckVesselOf(metaOf(r)); return !!String(r["id"] ?? "") && !!v && /^[A-Za-z0-9_.-]+$/.test(v); }), byId);
  // LANDABLE BEFORE NOT: of the honest rows, those the lane could land go first (landableBandOf, over the tick's one
  // scope read, deps.scope). An unreadable scope (or none given) decides nothing: no row is promoted, so the order is
  // the honest-first order. Ordering only: every candidate is still walked, and the scope is read only when there is an
  // honest row to band.
  const scope = deps.scope && candidates.some((r) => isSystemBornLineage(r, byId)) ? await deps.scope() : null;
  for (const row of byLandableBand(candidates, byId, scope)) {
    if (sent.length >= max) break;
    const id = String(row["id"] ?? "");
    const meta = metaOf(row);
    const vessel = ownCheckVesselOf(meta);
    if (!id || !vessel || !/^[A-Za-z0-9_.-]+$/.test(vessel)) continue;
    let list = (Array.isArray(meta["own_check_baseline_dispatches"]) ? meta["own_check_baseline_dispatches"] : []) as Disp[];
    // Each earlier dispatch's execution id, once goal-host's record carries it (bounded reads per pass).
    let filled = false;
    list = await Promise.all(list.map(async (d) => {
      if (!d || typeof d.dispatch_id !== "string" || d.execution_id || probes <= 0) return d;
      probes -= 1;
      const e = await (deps.executionIdOf ?? dispatchExecutionId)(d.dispatch_id);
      if (!e) return d;
      filled = true;
      return { ...d, execution_id: e };
    }));
    if (!heads.has(vessel)) heads.set(vessel, headOf(vessel));
    const head = heads.get(vessel) ?? null;
    // A reading FRESH at head (ownCheckBaselineFor: at head, or at an older sha whose diff to head touches none of its
    // files) is not measured again; a stale one is. A goal still in flight is matched by its exact sha (no reading yet).
    const measured = !head || !/^[0-9a-f]{40}$/.test(head) || list.some((d) => d?.base_sha === head) || (meta["own_check_baseline"] as { base_sha?: unknown } | undefined)?.base_sha === head || ownCheckBaselineFor(meta, head) !== null;
    if (measured) { if (filled) await deps.write(row, { own_check_baseline_dispatches: list }); continue; }
    const testFile = String(((meta["evidence_resolve"] as { input?: Row } | undefined)?.input ?? {})["test_file"] ?? "");
    const goal = `classify gap ${id}'s own check ${vessel}/${testFile} at base ${head!.slice(0, 12)} as green_at_parent | red_code_reachable | red_environmental | unrunnable (ownCheckBaseline)`;
    const r = await (deps.send ?? resolveDispatchGoal)({ type: "dispatch_goal", goal, target_template_id: "development-vessel:own-check-baseline", expected_output_shapes: ["ownCheckBaseline"], variables: { gap_id: id, base_ref: head! }, timeout_ms: 15_000 });
    const dispatchId = r.shape === "goalDispatchResult" ? ((r.body ?? {}) as { dispatch_id?: unknown }).dispatch_id : null;
    if (typeof dispatchId !== "string" || !nonEmpty(dispatchId)) {
      if (filled) await deps.write(row, { own_check_baseline_dispatches: list });
      console.warn(`[gap-check-supply] ${id}: own-check baseline goal not sent (${JSON.stringify(r.body ?? null).slice(0, 160)}); the next due pass retries`);
      break;
    }
    await deps.write(row, { own_check_baseline_dispatches: [...list, { base_sha: head!, dispatch_id: dispatchId, at: deps.nowIso, node: deps.node }].slice(-5) });
    sent.push({ id, base_sha: head!, dispatch_id: dispatchId });
  }
  return sent;
}

export async function resolveGapCheckSupplyTick(pointer: GapCheckSupplyTickPointer): Promise<ResolverResult> {
  if (passInFlight) return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "in_progress", family: CHECK_SUPPLY_FAMILY } };
  passInFlight = true;
  try {
    return await supplyPass(pointer);
  } finally {
    passInFlight = false;
  }
}

async function supplyPass(pointer: GapCheckSupplyTickPointer): Promise<ResolverResult> {
  const now = typeof pointer.now_ms === "number" ? pointer.now_ms : Date.now();
  const nowIso = new Date(now).toISOString();

  // 1. CADENCE: this family's rhythm, read now. Seeding it is the bootstrap seeder's job, not this resolver's:
  // the conductor only calls a family it has read, so a self-seed here could never run.
  const rhythm = await readFamilyRhythm(CHECK_SUPPLY_FAMILY);
  if (!rhythm) return { shape: "gapCheckSupplyReport", body: { fired: false, reason: "no_rhythm", family: CHECK_SUPPLY_FAMILY } };
  const due = rhythmDueScore(rhythm.body, rhythm.updated_at, now);
  const threshold = posNum(rhythm.body["due_threshold"], 1);
  // THE RHYTHM PACES THE DISPATCH, NOT THE BOOKKEEPING. Gated as a whole, an undue family read back no outcome, armed
  // no landed check and un-armed nothing until it came due again, so a family whose posterior sank under debits held a
  // failed goal at goal_dispatched for 18 to 50 hours, and the repair its outcome should have triggered waited with it. So ARM, OUTCOME, the
  // own-check un-arm and the hold release run on every pass; DISPATCH, localization and placement only when due. An
  // undue pass is not a fire: no credit, no staleness answered (a debit is still written, as the beta leg it is).
  // A PAUSED family does nothing at all, as before: the pause is a hold, and the arm step writes checks and runs suites.
  const dispatchDue = pointer.bookkeeping_only !== true && due.due_score >= threshold;
  const notDue = { fired: false, reason: "not_due", due_score: due.due_score, due_threshold: threshold };
  if (due.paused_by) return { shape: "gapCheckSupplyReport", body: { ...notDue, paused_by: due.paused_by } };
  // A DUE PASS CLAIMS ITS SLOT BEFORE THE WORK (the scope-earn-in pattern, RAN_PACING). The family settled only on an
  // alpha or beta leg, so a due pass that sent, armed and was refused nothing wrote no leg: the family stayed due and
  // every caller (the conductor's direct fire, the boredom selector's tagged template) re-ran the whole pass, one to two
  // a minute on one node. The first caller past the due gate resets the pacing (staleness 0, updated_at now) by a
  // compare-and-set on the row it read, before any gap-store read: the next caller within the cadence reads not_due
  // (and an undue pass is floored), and a caller that read the same row loses the CAS and returns not_due. Credit is
  // the settlement written after the work, as before. An undue pass claims nothing: its clock is the debit's alone.
  if (dispatchDue && !pointer.dry_run && !(await writeFamilyRhythm(rhythm, RAN_PACING, "gap-check-supply-tick", rhythm.updated_at))) {
    return { shape: "gapCheckSupplyReport", body: { ...notDue, detail: "another tick claimed this due slot (rhythm row moved since it was read)" } };
  }
  const floorMs = posNum(rhythm.body["bookkeeping_min_interval_s"], 600) * 1000;
  if (!dispatchDue && lastBookkeepingAt !== null && now >= lastBookkeepingAt && now - lastBookkeepingAt < floorMs) {
    return { shape: "gapCheckSupplyReport", body: { ...notDue, bookkeeping: `skipped: the last pass was ${Math.round((now - lastBookkeepingAt) / 1000)} s ago (floor ${floorMs / 1000} s)` } };
  }
  lastBookkeepingAt = now;
  const perTick = Math.floor(posNum(rhythm.body["max_per_tick"], 1));
  const backoffMs = posNum(rhythm.body["backoff_hours"], 24) * 3600_000;
  const maxAttempts = Math.floor(posNum(rhythm.body["max_attempts"], 3));
  // A NON-ATTEMPT's wait and a REFUSAL's wait (CHANGE-30), read from the same shaped record; a refusal prefers the
  // receiver's own retry_after_s. The non-attempt default sits well inside the 24 h park TTL a deferred landing keeps.
  const nonAttemptDelayMsBase = posNum(rhythm.body["non_attempt_delay_s"], 1800) * 1000;
  const refusalDelayMs = posNum(rhythm.body["refusal_delay_s"], 3600) * 1000;
  const maxNonAttemptDelayMs = posNum(rhythm.body["max_non_attempt_delay_s"], 6 * 3600) * 1000;
  // The wait for the NEXT consecutive non-attempt of a gap: its kind's base, doubled per consecutive one, capped.
  const delayFor = (kind: "non_attempt" | "refused", ledger: Ledger, retryAfterS?: number): { ms: number; streak: number } => {
    const streak = Number(ledger.non_attempt_streak ?? 0) + 1;
    const receiverMs = kind === "refused" && retryAfterS ? retryAfterS * 1000 : 0;
    return { ms: nonAttemptDelayMs(kind === "refused" ? (receiverMs || refusalDelayMs) : nonAttemptDelayMsBase, streak, maxNonAttemptDelayMs, receiverMs), streak };
  };
  // The control split, read from the same shaped record; absent or unusable means no control arm.
  const cf = Number(rhythm.body["control_fraction"]);
  const controlFraction = Number.isFinite(cf) && cf >= 0 && cf <= 1 ? cf : 0;
  // The control arm's time-box and its per-pass write bound (stamps and expiries together), from the same record.
  const controlExpiryMs = posNum(rhythm.body["control_expiry_days"], CONTROL_EXPIRY_DAYS_DEFAULT) * 86_400_000;
  const controlExpiryPerTick = Math.floor(posNum(rhythm.body["control_expiry_per_tick"], perTick));
  const windowMs = posNum(rhythm.body["measure_window_days"], 7) * 86_400_000;
  const bounds: OutcomeBounds = outcomeBoundsOf(rhythm.body);
  const maxOutcomeReads = Math.floor(posNum(rhythm.body["max_outcome_reads"], 50));
  // THE CANDIDATE ORDER, read from the same shaped record. "eligible_never_attempted_first" ranks a band ahead of the
  // rest: never attempted, filed by the system itself (substrate_detected) and with an edit site in the clone, so the
  // system's own writable rows are not starved behind operator retries. Absent, or any other value: today's order.
  const candidateOrder = rhythm.body["candidate_order"];
  const eligibleFirst = candidateOrder === "eligible_never_attempted_first";
  // "eligible_never_attempted_newest_first": the same band, ranked first, and ordered NEWEST first within it (the age key
  // today's order reads, reversed); the rows outside the band keep today's order and follow.
  const newestFirst = candidateOrder === "eligible_never_attempted_newest_first";
  const localNode = checkSupplyNode();

  const read = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  // AN UNREADABLE STORE IS NOT AN EMPTY ONE. On a node that forwards its gap store, a holder that did not answer read as
  // zero rows, and the pass would say "0 due": a pass marker for a pass that read nothing. Said by its own line instead.
  if (read.shape !== "substrateGap") {
    const detail = String(((read.body ?? {}) as Row)["detail"] ?? "").slice(0, 200);
    console.log(`[check-supply] bookkeeping: store_unreadable dispatch=${dispatchDue ? "due" : "undue"} node=${localNode} (${detail})`);
    return { shape: "gapCheckSupplyReport", body: { ...notDue, reason: "store_unreadable", dispatch: dispatchDue ? "due" : "undue", detail } };
  }
  const rows = (((read.body ?? {}) as { gaps?: Row[] }).gaps ?? []).filter((r) => typeof r["id"] === "string");
  const open = rows.filter((r) => String(r["status"] ?? "open") === "open");
  const touched = new Set<string>();
  const armed: string[] = [];
  const notArmed: Array<{ id: string; reason: string }> = [];
  const dispatched: Array<{ id: string; goal: string; dispatch_id: string | null }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const exhausted: string[] = [];
  const controlMarked: string[] = [];
  const localized: Array<{ id: string; edit_site: string; method: string }> = [];
  const outcomes: { not_attempts: Array<{ id: string; kind: string; reason: string; not_before: string }>; failed: Array<{ id: string; reason: string }>; lost: Array<{ id: string; why: LostWhy; reason: string }>; running: number; awaiting_titles: number; waiting: Array<{ id: string; why: LostWhy; detail: string }> } = { not_attempts: [], failed: [], lost: [], running: 0, awaiting_titles: 0, waiting: [] };
  let refused = 0;
  // THE CONTROL SIGNAL (law 6): this pass's check_no_control refusals and its arms that carried a control, said in one
  // line after the arm loop, so the refusal's effect on arming is read from the journal, not inferred.
  let noControlRefused = 0, armedWithControl = 0, controlsArmed = 0;
  // Attempts the rhythm already holds as settled, and the ones this tick settles (stored by its settlement write).
  const settledBefore = new Set(settledAttemptsOf(rhythm.body));
  const settledNow: string[] = [];
  const resettled: Array<{ id: string; dispatch_id: string | null }> = [];

  // 2. ARM: a dispatched gap whose test has landed (new titles in its test file).
  const landedRefs = new Map<string, Set<string> | null>();
  let armBudget = perTick;
  for (const row of open) {
    // A forwarding node reads on past a spent budget: a row waiting on, or settled by, the holder spends none.
    if (armBudget <= 0 && gapStoreIsLocal()) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const sent = ledgerOf(meta);
    // THE FILE THE GOAL WAS TOLD TO WRITE: intended_test_file, else test_file on a record written before the send kept
    // the two apart. It becomes test_file below only once it is read at origin/dev.
    const checkFile = sent.intended_test_file ?? sent.test_file;
    // A failed or lost goal's test may still land late: its titles arm the gap all the same.
    // A SETTLED JUDGEMENT (green_at_head, arm_refused, existence_only) IS TAKEN AGAIN WHEN WHAT IT READ HAS CHANGED: a
    // landed title it never judged (a reader since fixed: an escaped title was once dropped), or a different row region
    // or edit_site, or a different landed check, than its judged_inputs record. Settled, such a row waited out the
    // attempt backoff and was then sent a new goal whose baseline subtracted the landed check for good (a region
    // corrected or cleared after an arm refusal changed nothing). It is judged again now, on this path, against its own
    // baseline. A judgement written before judged_inputs existed reads as changed, once.
    const settled = JUDGED_NOT_ARMED.has(String(sent.state ?? ""));
    if (!(settled || sent.state === "goal_dispatched" || sent.state === SEND_PENDING || sent.state === "dispatch_failed" || sent.state === "dispatch_lost" || sent.state === "non_attempt" || sent.state === "send_refused") || !checkFile || !sent.vessel) continue;
    // LANDED, NOT PRESENT: the check is read from the clone's origin/dev (landedCheckSource). A file only in the work
    // tree (a refused cutover's leftover, or a landing still on its way) arms nothing and writes nothing: if it lands,
    // a later tick arms it.
    const landed = landedCheckSource(sent.vessel, checkFile, landedRefs);
    if (landed.state !== "landed") {
      if (!settled && existsSync(join(clonesRoot(), sent.vessel, checkFile))) notArmed.push({ id, reason: `${CHECK_NOT_LANDED}: ${checkFile} is in the clone's work tree but not at origin/dev${landed.state === "unreadable" ? " (origin/dev unreadable)" : ""}` });
      continue;
    }
    // THE CHECK IS AT origin/dev: from here every write of this row's ledger names it as test_file, the field readers
    // take as "this gap has a check file". Set at send, it named a file that may never land.
    const ledger = { ...sent, vessel: sent.vessel, test_file: checkFile };
    const src = landed.src;
    const baseline = Array.isArray(ledger.baseline_titles) ? ledger.baseline_titles : [];
    const titles = declaredTestTitles(src).filter((t) => !baseline.includes(t)).slice(0, 20);
    if (titles.length === 0) continue; // nothing appended yet: still waiting on the goal
    // Every new title judged, on the same inputs: a settled judgement, left to the backoff and the next goal.
    const inputs = judgedInputsOf(meta, src);
    const judgedBefore = Array.isArray(ledger.judged_titles) ? ledger.judged_titles : [];
    if (settled && titles.every((t) => judgedBefore.includes(t)) && sameJudgedInputs(ledger.judged_inputs, inputs)) continue;
    const judgedNow = { judged_titles: titles, judged_inputs: inputs };
    // The budget bounds the checks run for this tick: here, the ones this node runs; on a node that forwards its gap
    // store, the ones it hands to the holder (counted at the hand-off below), which bounds the holder's load. Waiting on
    // or reading back the holder's verdict spends nothing (a present's report read, below, runs the check once more at
    // the holder, one per settled row); spent on the judge's abstain, it let one row's re-judged unknown block every
    // other row on every tick.
    if (gapStoreIsLocal()) armBudget -= 1;
    touched.add(id);
    // A ROW FLAGGED needs_region (substrate-gap.ts flagNonLiteralRegion) is never armed: its region was not literal once
    // in its edit_site, and the arm write would refuse it. Refused here, terminal, with the region text it was filed
    // with, so the ledger records an outcome rather than a dispatch with none. A write that sets a literal-once region
    // clears the flag, and its changed judged_inputs take the row again.
    // Under check-region-cause-anchor variant-1, one whose stated cause resolves in its edit site goes on to the gates.
    const causeSiteRel = meta["needs_region"] === true ? vesselRelativeEditSite(ledger.edit_site ?? meta["edit_site"]) : null;
    if (meta["needs_region"] === true && !causeClearsNeedsRegion(meta, causeSiteRel ? srcReaderAt(join(clonesRoot(), ledger.vessel)).read(causeSiteRel) : null, causeSiteRel)) {
      const reason = `needs_region: ${String(meta["region_prior_text"] ?? "").slice(0, 160)} (not literal once in the row's edit_site)`;
      refused += 1;
      notArmed.push({ id, reason });
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason, ...judgedNow } });
      continue;
    }
    // W2, THE VERIFY'S RULE (check-supply-admission.ts checkImportsEditSite): the gap's edit site, imported in any
    // form testImportsFile reads; with none, an existing src module the test imports becomes it.
    const vesselDir = ledger.vessel;
    const vesselReader = srcReaderAt(join(clonesRoot(), vesselDir));
    const site = await checkImportsEditSite(src, ledger.test_file, ledger.edit_site ?? null, (rel) => existsSync(join(clonesRoot(), vesselDir, rel)), vesselReader);
    const editSite = site.ok ? `repos/${vesselDir}/${site.edit_site}` : null;
    const why = onlyTestsProblem(titles)?.detail ?? (site.ok ? null : `${site.stage}: ${site.reason}`);
    if (!site.ok && site.stage === EDIT_SITE_IS_OWN_CHECK) console.log(`[check-supply] refused ${id}: ${EDIT_SITE_IS_OWN_CHECK} (${site.edit_site})`);
    if (why) {
      refused += 1;
      notArmed.push({ id, reason: why });
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: why, ...judgedNow } });
      continue;
    }
    // F-ARM: a check that reads a name its module does not export is red for the invented name on every tree, never
    // for the defect (2f36f62, route-edit-bd252f8c: mod["shellResult"] on goal-host src/index.ts). Static, before anything
    // runs; the module's real exports come from the same clone the check imports (check-supply-admission.ts).
    const missing = missingExportRefusal(src, ledger.test_file, vesselReader);
    const unguarded = exportGuardUnavailable();
    // A check that only asserts a name exists (or is defined, or has a type) is closed by adding the name: never armed.
    const ex = existenceOnlyCheck(src, titles);
    if (ex.existence_only) {
      const reason = `existence_only: all ${ex.assertions} assertion(s) of the named test(s) only check that a name exists or has a type; a check must assert behaviour${missing ? `; ${missing.reason}` : ""}`;
      refused += 1;
      notArmed.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "existence_only", reason, ...judgedNow } });
      continue;
    }
    if (missing) {
      refused += 1;
      notArmed.push({ id, reason: missing.reason });
      console.warn(`[gap-check-supply] ${id}: ${missing.reason.slice(0, 240)} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: missing.reason, ...judgedNow } });
      continue;
    }
    // THE CHECK'S CALLS REACH THE REGION (checkMissesRegionRefusal): static, before anything runs, like the export guard.
    const region = regionOf(meta);
    const regionSite = region && site.ok ? vesselReader.read(site.edit_site) : null;
    const misses = site.ok && regionSite !== null ? checkMissesRegionRefusal(regionSite, site.edit_site, src, region) : null;
    // THE CHECK IS NOT ECHO-SATISFIABLE (echoSatisfiableRefusal): static, before anything runs. The gap's own text is
    // kept for the invented-literal rule, judged after the run (gateReason below).
    const gapText = [row["summary"], meta["falsifier_spec"], meta["must_fail"], meta["control"]].filter((x) => typeof x === "string").join("\n");
    const echo = misses ? null : echoSatisfiableRefusal(src);
    if (echo) {
      refused += 1;
      notArmed.push({ id, reason: echo.reason });
      console.warn(`[gap-check-supply] ${id}: ${echo.reason.slice(0, 240)} — not armed`);
      const echoLessons = withArmRefusalLesson(meta, { reason: echo.reason, testFile: ledger.test_file, checkSrc: src, at: nowIso });
      if (!pointer.dry_run) await writeMeta(row, { ...(echoLessons ? { failure_lessons: echoLessons } : {}), check_supply: { ...ledger, state: "arm_refused", reason: echo.reason, ...judgedNow } });
      continue;
    }
    if (misses) {
      refused += 1;
      notArmed.push({ id, reason: misses.reason });
      console.warn(`[gap-check-supply] ${id}: ${misses.reason.slice(0, 240)} — not armed`);
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason: misses.reason, ...judgedNow } });
      continue;
    }
    const evidence_resolve = { shape: "test_suite", input: { vessel: `repos/${ledger.vessel}`, test_file: ledger.test_file, only_tests: titles }, zero_field: "requested_not_passing" };
    // THE BIRTH VERDICT IS TAKEN WHERE THE STORE IS HELD. Here, the one judge with its report. On a node that forwards
    // its gap store the judge abstains ('unknown'), so the row was re-judged on every tick and never armed; and the
    // minted stamp never crosses the forward anyway (gateThenForward sends the pointer only), so the holder's write seam
    // judges every forwarded check itself (applyBirthStamp: a new class-2 check is stamped pending and run there, through
    // the same judge, on the holder's tree). So this node HANDS THE CANDIDATE OFF: it writes the check, keeping the
    // needs-localization hold, and settles from the holder's stamp on a later tick. The row is held (not eligible, and
    // pending is predicate_suspect) until a measured 'present' for this exact check is read back here.
    let verdict: "present" | "absent" | "unknown";
    let report: Record<string, unknown> | null = null;
    let stamp: MintedBirthVerdict | undefined;
    if (gapStoreIsLocal()) {
      ({ verdict, report, stamp } = await takeBirthVerdictWithReport(id, { ...meta, evidence_resolve, edit_site: editSite }));
    } else {
      const atHolder = meta["predicate_birth_key"] === class2PredicateKey({ ...meta, evidence_resolve }) ? meta["predicate_birth_verdict"] : undefined;
      if (atHolder === undefined) {
        if (armBudget <= 0) { notArmed.push({ id, reason: "hand_off_deferred: this tick's max_per_tick hand-offs are spent; next tick" }); continue; }
        armBudget -= 1;
        notArmed.push({ id, reason: "birth_verdict_at_holder: the check was handed to the gap-store holder, which measures it" });
        if (pointer.dry_run) continue;
        const holdable = !nonEmpty(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION;
        const w = await writeMeta(row, { evidence_resolve, edit_site: editSite, predicate_source: CHECK_SUPPLY_SOURCE, ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}), check_supply: { ...ledger, handed_off_from: localNode } });
        if (w.shape === "structuredError") console.warn(`[gap-check-supply] ${id}: hand-off to the gap-store holder refused: ${JSON.stringify(w.body).slice(0, 200)}`);
        else console.log(`[gap-check-supply] ${id}: check ${JSON.stringify(titles)} handed to the gap-store holder for its birth verdict; held until it reads present`);
        continue;
      }
      // An absent the holder re-labelled unknown because its tree moved is still the check passing at HEAD.
      verdict = atHolder === "present" ? "present" : atHolder === "absent" || (atHolder === "unknown" && birthTreeMoved(meta)) ? "absent" : "unknown";
      if (verdict === "unknown") { notArmed.push({ id, reason: `awaiting_holder_verdict: ${String(atHolder)}` }); continue; }
      // THE GATES BELOW RUN ON EVERY NODE. The holder's stamp carries no report, and without one every handed-off check
      // armed ungated here (a check red for the wrong reason, or on a contract its target lacks, armed hollow). A present
      // reads its report where it was measured (holderCheckReport); a report that cannot be read arms nothing, and the
      // row is read again on the next tick. Reading it is a settlement, not a hand-off: it spends no max_per_tick.
      if (verdict === "present") {
        const held = await holderCheckReport(evidence_resolve);
        if (!held.report) {
          notArmed.push({ id, reason: `awaiting_holder_report: ${held.detail}` });
          console.warn(`[gap-check-supply] ${id}: the holder's present is not armed until its run report is read (${held.detail})`);
          continue;
        }
        report = held.report;
      }
    }
    // RED FOR THE RIGHT REASON, BY THE SHARED CLASSIFIER: every named test among the failures (redForTheRightReason)
    // AND each an assertion in the report's red_reason (retry-evidence.ts), the rule feature_compose's verify applies.
    // A report without red_reason cannot attribute its red: nothing is armed. Wherever the store is held: a handed-off
    // check is judged from the holder's report of it, read above.
    // An assertion red on a contract the target does not have (333be5f: a shape and a body field the resolver never
    // returns) is red on every tree: contractMismatchRefusal, the verify's rule, judged from the same report.
    // A CHECK CARRIES A CONTROL (CHECK_NO_CONTROL_STAGE): the run's red titles are the must-fail tests, judged by every
    // gate below; its green titles are the controls, kept in the predicate (they must stay green after the fix). A
    // check with no green title is refused after every other gate (wrongReason), so a wrong red keeps its own lesson.
    // No red title at all (a present with no failingTests) is judged on every title, so the judges refuse it as before.
    const split = splitRedGreen(report, titles);
    const redTitles = split.red.length > 0 ? split.red : titles;
    const controlTitles = split.red.length > 0 ? split.green : [];
    const redReason = (report as Record<string, unknown> | null)?.["red_reason"];
    const classified = verdict === "present" ? armRedReasonRefusal(redReason, redTitles) : null;
    const gateReason = verdict === "present" ? redForTheRightReason(report, redTitles) ?? (classified ? `${classified.cause ? `${classified.cause}: ` : ""}${classified.reason}` : null) ?? contractMismatchRefusal(src, ledger.test_file, redReason, vesselReader)?.reason ?? castCalleeRefusal(src, ledger.test_file, vesselReader)?.reason ?? (site.ok ? inventedLiteralRefusal(src, vesselReader.read(site.edit_site), gapText)?.reason : null) ?? null : null;
    // Last, as the costliest: is the red about the edit site at all (EDIT-SITE MUTATION GATE)?
    const mutation = verdict === "present" && !gateReason && site.ok
      ? await editSiteMutationGate({ vessel: vesselDir, siteRel: site.edit_site, testFile: ledger.test_file, checkSrc: src, titles: redTitles, baseline: report, k: coverageKnobs(rhythm.body).k, region: regionOf(meta) })
      : null;
    // Then, on a row with no literal region, the region derived from the evidence (regionMutantGate). It also runs when
    // the edit-site gate refused: the region mutant is a mutant of the site, so a red it moves does depend on the site,
    // and that refusal's premise ("no mutant of the site moves the red") does not stand. On a large site the k operator
    // mutants, spread over every declaration the check reaches, can all miss the code a correct check measures (the
    // hand-written 5e69d7a0 check: six mutants of supplyPass's reach, none on the refusal path).
    const regionGate = (mutation?.kind === "pass" || mutation?.kind === "refuse") && site.ok && regionGateApplies(meta, region ? regionSite : null)
      ? await regionMutantGate({ vessel: vesselDir, siteRel: site.edit_site, testFile: ledger.test_file, titles: redTitles, baseline: report, evidence: String(row["summary"] ?? ""), spec: typeof meta["falsifier_spec"] === "string" ? String(meta["falsifier_spec"]) : "", more: { must_fail: typeof meta["must_fail"] === "string" ? String(meta["must_fail"]) : undefined, control: typeof meta["control"] === "string" ? String(meta["control"]) : undefined , cause: statedCauseOf(meta) } })
      : null;
    if (regionGate && regionGate.kind !== "wait") console.log(`[gap-check-supply] ${id}: region_gate=${regionGateOutcome(regionGate)}`);
    if (regionGate && regionGate.kind !== "wait") settleCauseAnchor(id, regionGate);
    const waiting = mutation?.kind === "wait" ? mutation : regionGate?.kind === "wait" ? regionGate : null;
    if (waiting) {
      notArmed.push({ id, reason: `awaiting_mutation_runs: ${waiting.detail}` });
      console.warn(`[gap-check-supply] ${id}: not armed until its edit-site mutant runs are read (${waiting.detail})`);
      continue;
    }
    const regionMoved = regionGate?.kind === "pass" && Number(regionGate.record["changed"] ?? 0) > 0;
    const siteRefusal = mutation?.kind === "refuse" && !regionMoved ? mutation.reason : null;
    const gatedReason = gateReason ?? siteRefusal ?? (regionGate?.kind === "refuse" ? regionGate.reason : null);
    // Last of all, one more run for a check every gate above let through: does gutting the site pass it (guttingGate)?
    const gutGate = mutation && !gatedReason && site.ok ? await guttingGate({ vessel: vesselDir, siteRel: site.edit_site, testFile: ledger.test_file, checkSrc: src, titles: redTitles }) : null;
    if (gutGate?.kind === "wait") {
      notArmed.push({ id, reason: `awaiting_mutation_runs: ${gutGate.detail}` });
      console.warn(`[gap-check-supply] ${id}: not armed until its edit-site mutant runs are read (${gutGate.detail})`);
      continue;
    }
    // Last of the refusals, so a check red for a wrong reason is told that reason first: no control (a config site's
    // goal asks for its control as the first assertion of its one test, so it is not judged by titles). Fail-closed:
    // only the rhythm's shaped require_control set to false (the record the selector reads) turns it off.
    const configSite = site.ok && configEditSite(site.edit_site, vesselReader.read(site.edit_site)) !== null;
    const requireControl = rhythm.body["require_control"] !== false;
    const wrongReason = gatedReason ?? (gutGate?.kind === "refuse" ? gutGate.reason : null) ?? (verdict === "present" && requireControl && !configSite ? noControlRefusal(controlTitles) : null);
    if (wrongReason === CHECK_NO_CONTROL_REASON) noControlRefused += 1;
    const mutationRecord = mutation && mutation.kind !== "wait" ? { mutation_gate: { ...mutation.record, ...(regionGate && regionGate.kind !== "wait" ? { region_gate: regionGate.record } : {}), ...(gutGate ? { gut_gate: gutGate.record } : {}), ...(mutation.kind === "refuse" && regionMoved ? { refusal_overridden_by: "region_gate" } : {}) } } : {};
    // What the red was at birth (the first failure's error line and the values it compared), kept on the ledger.
    const firstFailure = firstFailureOf(redReason);
    if (verdict !== "present" || wrongReason) {
      // GREEN AT HEAD, OR RED FOR THE WRONG REASON, ARMS NOTHING. An unknown keeps the row's state and is judged again:
      // turned back to goal_dispatched, a settled failure was read back and settled again on the next tick.
      const unknown = verdict === "unknown";
      const state = unknown ? ledger.state : verdict === "absent" ? "green_at_head" : "arm_refused";
      if (!unknown) refused += 1;
      notArmed.push({ id, reason: wrongReason ?? (verdict === "absent" ? "green_at_head" : "verdict_unknown") });
      if (state === "green_at_head") console.warn(`[gap-check-supply] ${id}: green_at_head — the new check(s) ${JSON.stringify(titles)} pass at HEAD, so they do not reproduce the defect; not armed (the next attempt is told)`);
      const judged = unknown ? {} : { ...judgedNow, reason: wrongReason ?? "green_at_head: the new check(s) pass at HEAD", ...(firstFailure ? { first_failure: firstFailure } : {}), ...mutationRecord };
      // A handed-off check judged not to arm (green, or red for the wrong reason) is taken back off the row, so it reads
      // unarmed and is asked again, whichever node judges it: the holder's own tick may reach a handed-off row first.
      const handedOff = !unknown && meta["predicate_birth_key"] === class2PredicateKey({ ...meta, evidence_resolve });
      const armLessons = state === "arm_refused" && wrongReason ? withArmRefusalLesson(meta, { reason: wrongReason, testFile: ledger.test_file, checkSrc: src, firstFailure, at: nowIso }) : null;
      if (!pointer.dry_run) await writeMeta(row, { ...(handedOff ? { evidence_resolve: null } : {}), ...(armLessons ? { failure_lessons: armLessons } : {}), check_supply: { ...ledger, state, last_verdict: verdict, ...judged } });
      continue;
    }
    const countControl = (): void => { if (controlTitles.length > 0) { armedWithControl += 1; controlsArmed += controlTitles.length; } };
    if (pointer.dry_run) { armed.push(id); countControl(); continue; }
    // WHO ARMED IT, AND THROUGH WHICH HAND-OFF. The arm names the node whose tick wrote it; a check the holder measured
    // for a node that handed it off (its stamp's key is this check's) also names that node, from the hand-off write.
    // Without both, an arm on a forwarding node read the same as the holder's own, and could not be attributed.
    const { handed_off_from: handOffNode, ...armLedger } = ledger;
    const viaHandOff = meta["predicate_birth_key"] === class2PredicateKey({ ...meta, evidence_resolve });
    // A hand-off with no node recorded (written before the stamp) is this node's only when it forwards its store.
    const handOff = !viaHandOff ? null : nonEmpty(handOffNode) ? String(handOffNode) : gapStoreIsLocal() ? null : localNode;
    const attribution = { armed_by_node: localNode, ...(handOff ? { handed_off_from: handOff } : {}) };
    // The row's handed_off_from is the LATEST hand-off's: a re-attempt handed off by another node rewrites it. The arm
    // entry keeps the copy taken here, so who armed what, from whose hand-off, survives the next hand-off.
    const armEntry = { armed_at: nowIso, ...attribution };
    const arms = [...(Array.isArray(ledger.arms) ? ledger.arms : []), armEntry].slice(-ARM_HISTORY_MAX);
    const w = await writeMeta(row, {
      evidence_resolve,
      edit_site: editSite,
      predicate_source: CHECK_SUPPLY_SOURCE,
      disposition: meta["disposition"] === CHECK_SUPPLY_DISPOSITION ? "" : meta["disposition"] ?? "",
      check_supply: { ...armLedger, state: "armed", armed_at: nowIso, control_titles: controlTitles, ...attribution, arm: armEntry, arms, red_at_head: true, last_verdict: verdict, non_attempt_streak: 0, ...(settled ? { reason: "", judged_titles: titles } : {}), ...(firstFailure ? { first_failure: firstFailure } : {}), ...(unguarded ? { guard_decided_nothing: unguarded } : {}), ...mutationRecord },
    }, stamp ? { birthVerdict: stamp } : undefined); // the verdict minted by the run above (the seam honours nothing else), or the holder's own
    if (w.shape === "structuredError") {
      const reason = `arm write refused: ${JSON.stringify(w.body).slice(0, 200)}`;
      refused += 1;
      notArmed.push({ id, reason });
      await writeMeta(row, { check_supply: { ...ledger, state: "arm_refused", reason, ...judgedNow } });
    } else {
      armed.push(id);
      countControl();
    }
  }
  console.log(`[check-supply] control: check_no_control=${noControlRefused} armed_with_control=${armedWithControl} control_titles=${controlsArmed} armed=${armed.length} require_control=${rhythm.body["require_control"] !== false ? "on" : "off"} node=${localNode}`);

  // 2n. AN ARM ON A CHECK THAT NEVER LANDED IS TAKEN BACK. Rows armed before the arm read origin/dev (above) may stand on
  // a check that is at no landed tree (a refused cutover's leftover the mirror has since removed). Each pass re-reads
  // every armed check-supply row's check at origin/dev; one that is absent there is un-armed as 2a un-arms
  // (arm_refused, evidence_resolve cleared, the reason the next goal's lesson). Only this node's own arms (or one
  // recorded before arms named their node): another node's clone may hold a landing this one has not pulled yet. An
  // unreadable origin/dev decides nothing, and so does a stale one (originDevCurrent).
  const devCurrent = new Map<string, { current: boolean; why: string }>();
  const staleSaid = new Set<string>();
  for (const row of open) {
    const id = String(row["id"]);
    if (touched.has(id)) continue;
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    if (ledger.state !== "armed" || !ledger.test_file || !ledger.vessel || String(meta["predicate_source"] ?? "") !== CHECK_SUPPLY_SOURCE) continue;
    if (nonEmpty(ledger.armed_by_node) && ledger.armed_by_node !== localNode) continue;
    const er = (meta["evidence_resolve"] ?? null) as { input?: Row } | null;
    if (er?.input?.["test_file"] !== ledger.test_file) continue;
    if (landedCheckSource(ledger.vessel, ledger.test_file, landedRefs).state !== "absent") continue;
    // A STALE origin/dev DECIDES NOTHING (originDevCurrent): said once per vessel per tick.
    const cur = originDevCurrent(ledger.vessel, devCurrent);
    if (!cur.current) {
      if (!staleSaid.has(ledger.vessel)) { staleSaid.add(ledger.vessel); console.warn(`[gap-check-supply] stale origin/dev in the ${ledger.vessel} clone (${cur.why}): no armed check is taken back this tick`); }
      continue;
    }
    touched.add(id);
    const reason = `${CHECK_NOT_LANDED}: the armed check ${ledger.test_file} is not at origin/dev in the ${ledger.vessel} clone (never landed, or removed); un-armed`;
    refused += 1;
    notArmed.push({ id, reason });
    console.warn(`[gap-check-supply] ${id}: ${reason}`);
    if (pointer.dry_run) continue;
    const lessons = withArmRefusalLesson(meta, { reason, testFile: ledger.test_file, checkSrc: "", at: nowIso });
    await writeMeta(row, { evidence_resolve: null, ...(lessons ? { failure_lessons: lessons } : {}), check_supply: { ...ledger, state: "arm_refused", reason } });
  }

  // 2a. THE REGION GATE, CAUGHT UP (qa re-arm ruling, 2026-10-24). Rows armed before the region gate existed carry no
  // mutation_gate.region_gate, so nothing measured that their check depends on the gap's region, and their
  // fixed_elsewhere close now holds (gap-landing-verdict regionGateAtClose). Each pass re-runs the gate on at most
  // `region_regate_per_tick` (shaped, default 3) ARMED check-supply rows with no literal region and no region_gate: the
  // check once more as it stands (the baseline the gate compares), then once under the region mutant (regionMutantGate).
  // Refused: un-armed (arm_refused, evidence_resolve cleared), the reason the next goal's lesson, as at arm. Otherwise
  // the reading is recorded and the row stays armed. A check no longer red at HEAD is recorded unmeasured, so it is not
  // re-run every pass. A row a gate run cannot be read for waits for the next pass.
  const regateMax = Math.floor(posNum(rhythm.body["region_regate_per_tick"], 3));
  const regated: Array<{ id: string; outcome: string }> = [];
  for (const row of open) {
    if (regated.length >= regateMax) break;
    const id = String(row["id"]);
    if (touched.has(id)) continue;
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    const prior = (ledger.mutation_gate ?? null) as Row | null;
    if (ledger.state !== "armed" || !ledger.test_file || !ledger.vessel || String(meta["predicate_source"] ?? "") !== CHECK_SUPPLY_SOURCE) continue;
    if (prior && typeof prior === "object" && prior["region_gate"]) continue;
    const siteRel = vesselRelativeEditSite(meta["edit_site"] ?? ledger.edit_site ?? null);
    let regateSite: string | null = null;
    if (siteRel && regionOf(meta) !== "") { try { regateSite = readFileSync(join(clonesRoot(), ledger.vessel, siteRel), "utf-8"); } catch { regateSite = null; } }
    if (!regionGateApplies(meta, regateSite)) continue;
    const er = (meta["evidence_resolve"] ?? null) as { shape?: unknown; input?: Row } | null;
    const titles = Array.isArray(er?.input?.["only_tests"]) ? (er!.input!["only_tests"] as unknown[]).filter((t): t is string => typeof t === "string") : [];
    if (!siteRel || er?.shape !== "test_suite" || titles.length === 0) continue;
    touched.add(id);
    const input: Row = { vessel: `repos/${ledger.vessel}`, test_file: ledger.test_file, only_tests: titles };
    let baseline: Row | null;
    if (gapStoreIsLocal()) {
      const r = await resolveTestSuite(input as never).catch(() => null);
      baseline = r && r.shape === "test_suite" ? (r.body as Row) : null;
    } else {
      const held = await holderCheckReport({ shape: "test_suite", input });
      if (!held.report && /unreachable|HTTP/.test(held.detail)) continue;
      baseline = held.report;
    }
    if (!baseline || baseline["ran"] !== true) continue;
    const red = Number(baseline["requested_not_passing"] ?? 0) > 0;
    const g: MutationGateOutcome = red
      ? await regionMutantGate({ vessel: ledger.vessel, siteRel, testFile: ledger.test_file, titles, baseline, evidence: String(row["summary"] ?? ""), spec: typeof meta["falsifier_spec"] === "string" ? String(meta["falsifier_spec"]) : "", more: { must_fail: typeof meta["must_fail"] === "string" ? String(meta["must_fail"]) : undefined, control: typeof meta["control"] === "string" ? String(meta["control"]) : undefined , cause: statedCauseOf(meta) } })
      : { kind: "pass", record: { decided: "unmeasured: the check is not red at HEAD" } };
    if (g.kind === "wait") continue;
    const outcome = regionGateOutcome(g);
    regated.push({ id, outcome });
    console.log(`[gap-check-supply] ${id}: region_gate=${outcome} (re-gated: armed before the region gate)`);
    settleCauseAnchor(id, g);
    if (pointer.dry_run) continue;
    const mutation_gate = { ...(prior && typeof prior === "object" ? prior : {}), region_gate: g.record };
    if (g.kind === "refuse") {
      refused += 1;
      notArmed.push({ id, reason: g.reason });
      let checkSrc = "";
      try { checkSrc = readFileSync(join(clonesRoot(), ledger.vessel, ledger.test_file), "utf-8"); } catch { checkSrc = ""; }
      const regateLessons = withArmRefusalLesson(meta, { reason: g.reason, testFile: ledger.test_file, checkSrc, firstFailure: firstFailureOf(baseline["red_reason"]), at: nowIso });
      await writeMeta(row, { evidence_resolve: null, ...(regateLessons ? { failure_lessons: regateLessons } : {}), check_supply: { ...ledger, state: "arm_refused", reason: g.reason, judged_titles: titles, judged_inputs: judgedInputsOf(meta, checkSrc), mutation_gate } });
    } else {
      await writeMeta(row, { check_supply: { ...ledger, mutation_gate } });
    }
  }

  // 2o. THE OWN-CHECK BASELINE (own-check-baseline.ts): on a due pass, at most `own_check_baseline_per_tick` (the shaped
  // ownCheckEnvironmentPolicy) open rows with a test_suite own check not yet measured at their vessel's current
  // origin/dev get one development-vessel:own-check-baseline goal each, the rows admission would pick next first.
  // The live autonomyScope is read at most once per tick (scopeOnce): here, for the baseline's landable band, or at the
  // dispatch step's scope skip below, whichever asks first.
  let scopeRead: AutonomyScope | null = null;
  const scopeOnce = async (): Promise<AutonomyScope> => (scopeRead ??= await readScopeSelf());
  // The store read, indexed once for lineage reads (lineageIndex): the baseline's bands and the dispatch step's.
  const byIdAll = lineageIndex(new Map(rows.map((r) => [String(r["id"]), r])));
  const baselinesSent = dispatchDue && !pointer.dry_run ? await dispatchOwnCheckBaselines(open, { node: localNode, nowIso, write: (row, m) => writeMeta(row, m), byId: byIdAll, scope: scopeOnce }) : [];
  if (baselinesSent.length > 0) console.log(`[gap-check-supply] own-check baselines dispatched: ${baselinesSent.map((b) => `${b.id}@${b.base_sha.slice(0, 12)}=${b.dispatch_id}`).join(", ")}`);

  // 2b. OUTCOME: read back each in-flight goal this tick did not arm from.
  let outcomeReads = 0;
  // THIS NODE'S GOALS STILL IN FLIGHT after the read-back (the DEMAND gate below): sent or placed by this node, with a
  // dispatch id, not yet settled. A record with no dispatch id is not counted: no send of it was ever confirmed, and it
  // waits out dispatch_stale_hours, so counted it would hold the gate shut for a day on a goal that may not exist. Nor
  // is one its goal-host answers 404 for (below).
  let inFlightMine = 0;
  for (const row of open) {
    const id = String(row["id"]);
    if (touched.has(id)) continue;
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    if (ledger.state !== "goal_dispatched" && ledger.state !== SEND_PENDING) continue;
    const owner = nonEmpty(ledger.dispatch_node) ? String(ledger.dispatch_node) : null;
    const mine = owner === null || owner === localNode;
    // A goal this node placed on a peer is read through that peer (compose-placement readPlacedDispatch).
    const placedHere = !mine && ledger.placed_by === localNode && nonEmpty(ledger.dispatch_host);
    if ((mine || placedHere) && nonEmpty(ledger.dispatch_id) && outcomeReads >= maxOutcomeReads) { inFlightMine += 1; continue; }
    let probe: DispatchProbe | null = null;
    if (mine && nonEmpty(ledger.dispatch_id)) { outcomeReads += 1; probe = await probeDispatch(String(ledger.dispatch_id)); }
    else if (placedHere && nonEmpty(ledger.dispatch_id)) { outcomeReads += 1; probe = await readPlacedDispatch(String(ledger.dispatch_host), { gap_id: id, dispatch_id: String(ledger.dispatch_id) }); }
    const v = dispatchVerdict(ledger, probe, now, bounds, localNode);
    const ownSent = (mine || placedHere) && nonEmpty(ledger.dispatch_id);
    if (v.kind === "running") { outcomes.running += 1; if (ownSent) inFlightMine += 1; continue; }
    if (v.kind === "awaiting_titles") { outcomes.awaiting_titles += 1; if (ownSent) inFlightMine += 1; continue; }
    if (v.kind === "wait") {
      // A dispatch its goal-host has NO RECORD of (404, pruned) holds no slot: nothing of this node's is running for it,
      // and goal-host's retention is shorter than dispatch_stale_hours, so counted it would shut the demand gate until
      // the bound settles it. It still waits (and is reported) and is settled by the bound as before.
      if (ownSent && v.why !== "not_found_on_host") inFlightMine += 1;
      outcomes.waiting.push({ id, why: v.why, detail: v.detail });
      console.warn(`[gap-check-supply] outcome unread for ${id}: ${v.why}: ${v.detail}`);
      continue;
    }
    const outcome: Row = { read_at: nowIso, read_by: localNode, ...(probe && probe.http !== "unreachable" ? { http: probe.http, status: probe.status ?? null, reached: probe.reached ?? null, ...(probe.outcome !== undefined ? { outcome: probe.outcome } : {}) } : {}), ...(v.kind === "lost" ? { lost_why: v.why } : {}) };
    if (v.kind === "non_attempt" || v.kind === "refused") {
      // NOT A FAILED ATTEMPT (CHANGE-30): no dispatch_failed, the attempt given back, the shaped wait recorded.
      const d = delayFor(v.kind, ledger, v.retry_after_s);
      const held = nonAttemptLedger(ledger, v.kind, v.reason, d.ms, now, outcome, d.streak);
      outcomes.not_attempts.push({ id, kind: v.kind, reason: v.reason, not_before: String(held.not_before) });
      console.log(`[gap-check-supply] outcome ${held.state} for ${id} (not charged; next not before ${held.not_before}): ${v.reason}`);
      if (!pointer.dry_run) {
        const w = await writeMeta(row, { check_supply: held }, undefined, ledger);
        if (ledgerMoved(w)) console.warn(`[gap-check-supply] ${id}: ${held.state} not written: another writer's record replaced dispatch ${ledger.dispatch_id ?? "none"} first, so it stands`);
      }
      (meta as Row)["check_supply"] = held;
      continue;
    }
    const next: Ledger = { ...ledger, state: v.kind === "failed" ? "dispatch_failed" : "dispatch_lost", reason: v.reason, outcome, non_attempt_streak: 0 };
    const did = nonEmpty(ledger.dispatch_id) ? String(ledger.dispatch_id) : null;
    // ONE DEBIT PER ATTEMPT (settledAttemptKey): an attempt the rhythm already holds as settled is re-recorded, never re-debited.
    const key = settledAttemptKey(id, ledger);
    const again = settledBefore.has(key) || settledNow.includes(key);
    if (again) resettled.push({ id, dispatch_id: did });
    else { refused += 1; settledNow.push(key); }
    if (v.kind === "failed") outcomes.failed.push({ id, reason: v.reason }); else outcomes.lost.push({ id, why: v.why, reason: v.reason });
    console.log(`[gap-check-supply] outcome ${next.state} for ${id} (dispatch ${did ?? "none"}${again ? ", settled before: not debited again" : ""}): ${v.reason}`);
    if (!pointer.dry_run) {
      try {
        const w = await writeMeta(row, { check_supply: next }, undefined, ledger);
        if (w.shape === "structuredError") console.warn(`[gap-check-supply] settlement write for ${id} (dispatch ${did ?? "none"}) refused, the row stays as read: ${JSON.stringify(w.body).slice(0, 200)}`);
      } catch (err) {
        console.warn(`[gap-check-supply] settlement write for ${id} (dispatch ${did ?? "none"}) lost: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
    // The same tick's dispatch step sees the settled ledger (a due retry may be sent now).
    (meta as Row)["check_supply"] = next;
  }
  const outcomesSettled = outcomes.failed.length + outcomes.lost.length + outcomes.not_attempts.length;

  // AN ARMED ROW WHOSE EDIT SITE IS ITS OWN CHECK IS UN-ARMED (gap-eligibility editSiteIsOwnCheck). No pick or compose
  // takes it (edit_site_is_own_check), but a row nothing else writes would stay labelled class2; this write lets the
  // write seam re-label its check unresolvable with the named reason, and records the decision on the row.
  const unarmedOwnCheck: string[] = [];
  for (const row of open) {
    const id = String(row["id"]);
    const own = touched.has(id) || falsifierClassOf(metaOf(row)) !== "class2" ? null : editSiteIsOwnCheck(row);
    if (!own) continue;
    touched.add(id);
    unarmedOwnCheck.push(id);
    console.log(`[check-supply] un-armed ${id}: ${EDIT_SITE_IS_OWN_CHECK} (${own.site})`);
    if (!pointer.dry_run) await writeMeta(row, ownCheckUnarmMeta(own, nowIso));
  }

  // A ROW WHOSE OWN CHECK IS RED ONLY BECAUSE A CHILD SCRIPT THE TEST RUNS DOES NOT PARSE is localized to its test file
  // (testDefectLocalizationDecision). Only when due, bounded by max_per_tick like the localization below; what the
  // budget counts is the activity development-vessel:test-defect-localization-budget (testDefectPass).
  const testDefects: TestDefectPassEntry[] = dispatchDue
    ? (await testDefectPass({ open, touched, perTick, decideMax: Math.floor(posNum(rhythm.body["test_defect_decide_max"], TEST_DEFECT_DECIDE_MAX)), nowIso, dryRun: pointer.dry_run === true })).decisions
    : [];

  // A NARROWED CHILD CARRYING ITS PARENT'S ARMED LEDGER IS GIVEN ITS OWN. Before the inherit fix (narrowedChildRecord,
  // NARROWED_INHERIT_NEVER) a child was minted with a copy of the parent's check_supply, so it reads armed with the
  // parent's armed_at and dispatch id: the dispatch step skips armed rows, and the child, whose falsifier is its own and
  // unarmed, is never supplied a check and cannot close. A ledger armed BEFORE the child was narrowed is that copy: it
  // is cleared (the copy kept beside the reason), so the next due pass supplies the child its own check. A child armed
  // after its narrowing armed itself and is left as it is.
  const clearedInherited: string[] = [];
  for (const row of open) {
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    if (touched.has(id) || ledger.state !== "armed" || !nonEmpty(meta["parent_gap_id"])) continue;
    const cls = falsifierClassOf(meta);
    if (cls === "class1" || cls === "class2") continue;
    const armedAt = Date.parse(String(ledger.armed_at ?? ""));
    const narrowedAt = Date.parse(String(meta["narrowed_at"] ?? row["created_at"] ?? ""));
    if (!Number.isFinite(armedAt) || !Number.isFinite(narrowedAt) || armedAt >= narrowedAt) continue;
    touched.add(id);
    clearedInherited.push(id);
    const reason = `inherited_armed_ledger_cleared: armed_at ${String(ledger.armed_at)} precedes this child's narrowing (${new Date(narrowedAt).toISOString()}), so the armed ledger is the parent ${String(meta["parent_gap_id"])}'s copy, not this child's`;
    console.log(`[check-supply] cleared inherited ledger ${id}: ${reason}`);
    if (!pointer.dry_run) await writeMeta(row, { check_supply: { reason, cleared_at: nowIso, inherited: { armed_at: ledger.armed_at ?? null, dispatch_id: ledger.dispatch_id ?? null, test_file: ledger.test_file ?? null } } });
  }

  // A row marked needs_localization that something else has since armed: release the hold.
  let released = 0;
  for (const row of open) {
    const meta = metaOf(row);
    if (meta["disposition"] !== CHECK_SUPPLY_DISPOSITION || touched.has(String(row["id"]))) continue;
    const cls = falsifierClassOf(meta);
    // A check not yet measured present (a handed-off one still pending at the holder) has not armed the row.
    if ((cls === "class1" || cls === "class2") && predicateSuspect(meta) === null && !pointer.dry_run) {
      touched.add(String(row["id"]));
      released += 1;
      await writeMeta(row, { disposition: "" });
    }
  }
  // THE CONTROL ARM'S TIME-BOX (controlArmStep), on every pass like the release above. Bounded per pass by the
  // shaped control_expiry_per_tick (default max_per_tick), stamps included: every write rewrites the store. Expiries
  // first, oldest stamp first. An expired row is touched, so it is supply work from the NEXT pass.
  const armSteps = open
    .filter((r) => !touched.has(String(r["id"])))
    .map((r) => ({ r, s: controlArmStep(r, now, controlExpiryMs) }))
    .filter((x): x is { r: Row; s: NonNullable<ReturnType<typeof controlArmStep>> } => x.s !== null)
    .sort((a, b) => (a.s.kind === b.s.kind ? (a.s.kind === "expire" && b.s.kind === "expire" ? b.s.days - a.s.days : 0) : a.s.kind === "expire" ? -1 : 1));
  const controlStamped: string[] = [];
  const controlExpired: string[] = [];
  for (const { r, s } of armSteps.slice(0, controlExpiryPerTick)) {
    const id = String(r["id"]);
    if (!pointer.dry_run) {
      const w = await writeMeta(r, s.meta);
      if (w.shape === "structuredError") { console.warn(`[check-supply] control arm ${s.kind} not written: ${id}`); continue; }
    }
    if (s.kind === "stamp") { controlStamped.push(id); continue; }
    touched.add(id);
    controlExpired.push(id);
    console.log(`[check-supply] control arm expired: ${id} after ${s.days.toFixed(1)} days`);
  }
  if (armSteps.length > 0) console.log(`[check-supply] control arm: expired=${controlExpired.length} stamped=${controlStamped.length} pending=${armSteps.length - controlExpired.length - controlStamped.length} per_tick=${controlExpiryPerTick} node=${localNode}`);
  const keep =Math.floor(posNum(rhythm.body["settled_attempts_kept"], 200));
  const settledKeys = (): Row => (settledNow.length > 0 ? { settled_attempts: [...settledAttemptsOf(rhythm.body), ...settledNow].slice(-keep) } : {});
  const bookkeepingLine = (dispatch: "due" | "undue"): void => {
    const counts = `armed=${armed.length} outcomes=${outcomesSettled} unarmed=${unarmedOwnCheck.length} released=${released}`;
    // THE PASS MARKER: exactly one per pass that ran (a floored, in-progress, paused or rhythm-less call logs none).
    console.log(`[check-supply] bookkeeping: ${armed.length + outcomesSettled + unarmedOwnCheck.length + released === 0 ? "0 due " : ""}${counts} waiting=${outcomes.waiting.length} dispatch=${dispatch} node=${localNode}`);
  };
  if (!dispatchDue) {
    // NOT DUE: the bookkeeping is the whole pass. Its debits (a refused check, a failed or lost goal, once per attempt
    // by settled_attempts) are written as today's beta leg, which persists the accrued staleness, so the family's due
    // clock moves only by the debit itself; an arm earns no credit here (credit and staleness are answered by a fire).
    const leg = refused > 0 ? "beta" : null;
    // DEMAND MAKES THE FAMILY DUE (law 5: the rhythm paces the passes; one goal in flight is the throttle). Staleness is
    // the demand a fire has not answered, yet it accrued only by age, so after an arm reset it a family whose posterior
    // sank under debits came due 18 to 50 hours later while hundreds of rows waited and nothing of its own was in flight.
    // So an undue pass that finds a row the dispatch step could send now and fewer than max_per_tick of this node's goals
    // in flight writes the staleness at which the ONE formula (rhythmDueScore, unchanged) reads due: the conductor's next
    // pass fires the family as it fires any due family, and that fire claims its slot and dispatches as before. The bound
    // is the conductor's own threshold (1) or the body's due_threshold, whichever is higher, so both read it due.
    const sendable = (r: Row): boolean => {
      const id = String(r["id"]);
      if (touched.has(id) || checkSupplyDisposition(r) === null || checkSupplyRowArm(r, controlFraction) === "control") return false;
      const l = ledgerOf(metaOf(r));
      if (["armed", "exhausted", "goal_dispatched", SEND_PENDING, "no_anchor", "scope_excluded"].includes(String(l.state ?? ""))) return false;
      const n = Number(l.attempts ?? 0);
      if (n >= maxAttempts) return false;
      if (l.state === "non_attempt" || l.state === "send_refused") { const nb = Date.parse(String(l.not_before ?? "")); if (Number.isFinite(nb) && now < nb) return false; }
      else { const last = Date.parse(String(l.last_dispatch_at ?? "")); if (n > 0 && Number.isFinite(last) && now < last + backoffMs * 2 ** (n - 1)) return false; }
      return checkSupplyVessel(r) !== null;
    };
    const ready = inFlightMine < perTick ? open.filter(sendable).length : 0;
    let markedDue: number | null = null;
    if (ready > 0) {
      // Scored on the body as this pass stores it: a debit written beside the mark lowers the credit the formula reads.
      const stored = leg ? { ...rhythm.body, ...rhythmSettlementOverlay(leg, due.alpha, due.beta, 1) } : rhythm.body;
      const unit = rhythmDueScore({ ...stored, staleness: 1 }, nowIso, now).due_score;
      if (unit > 0) markedDue = Math.max(due.staleness, Math.max(threshold, 1) / unit);
    }
    if (!pointer.dry_run) {
      if (leg) await settleFamily(rhythm, leg, markedDue !== null ? { ...due, staleness: markedDue } : due, undefined, settledKeys());
      else if (markedDue !== null && !(await writeFamilyRhythm(rhythm, { staleness: markedDue }, "gap-check-supply-tick", rhythm.updated_at))) markedDue = null;
    }
    if (markedDue !== null) console.log(`[check-supply] demand: ready=${ready} in_flight=${inFlightMine} max_per_tick=${perTick}: rhythm marked due (staleness ${markedDue.toFixed(4)}) node=${localNode}`);
    bookkeepingLine("undue");
    return {
      shape: "gapCheckSupplyReport",
      body: {
        ...notDue,
        dispatch: "undue",
        settlement: leg ?? "none",
        demand: { ready, in_flight: inFlightMine, max_per_tick: perTick, marked_due: markedDue !== null },
        armed,
        not_armed: notArmed,
        refused,
        ...(regated.length ? { region_regated: regated } : {}),
        ...(resettled.length ? { resettled } : {}),
        ...(unarmedOwnCheck.length ? { unarmed_own_check: unarmedOwnCheck } : {}),
        ...(clearedInherited.length ? { cleared_inherited: clearedInherited } : {}),
        released,
        outcomes,
        dry_run: pointer.dry_run === true,
      },
    };
  }

  // 3. DISPATCH: one test-writing goal per treatment-arm needs-localization gap, fewest attempts and oldest first.
  // A settled attempt (failed or lost) past its backoff is a DUE RETRY: it goes ahead of fresh gaps, or a steady inflow
  // of fresh gaps starves it forever (the backoff and max_attempts already bound how often it can come back).
  const dueRetry = (r: Row): boolean => {
    const l = ledgerOf(metaOf(r));
    if (l.state === "non_attempt" || l.state === "send_refused") { const nb = Date.parse(String(l.not_before ?? "")); return !Number.isFinite(nb) || now >= nb; }
    if (l.state !== "dispatch_failed" && l.state !== "dispatch_lost") return false;
    const n = Number(l.attempts ?? 0);
    const last = Date.parse(String(l.last_dispatch_at ?? ""));
    return n > 0 && n < maxAttempts && (!Number.isFinite(last) || now >= last + backoffMs * 2 ** (n - 1));
  };
  const neverAttemptedSystemSited = (r: Row): boolean => {
    const v = checkSupplyVessel(r);
    return Number(ledgerOf(metaOf(r)).attempts ?? 0) === 0 && r["source"] === "substrate_detected" && Boolean(v && checkSupplySite(r, v));
  };
  console.log(`[check-supply] candidate_order=${eligibleFirst ? "eligible_never_attempted_first" : newestFirst ? "eligible_never_attempted_newest_first" : candidateOrder === undefined ? "default" : `default (unrecognised ${JSON.stringify(candidateOrder)})`}`);
  const ordered = open
    .filter((r) => !touched.has(String(r["id"])) && checkSupplyDisposition(r) !== null)
    .sort((a, b) => {
      // The band first (candidate_order above), then today's order within each band.
      if (eligibleFirst) { const ba = neverAttemptedSystemSited(a); const bb = neverAttemptedSystemSited(b); if (ba !== bb) return ba ? -1 : 1; }
      if (newestFirst) {
        const ba = neverAttemptedSystemSited(a); const bb = neverAttemptedSystemSited(b);
        if (ba !== bb) return ba ? -1 : 1;
        // Within the band, newest first: today's age key, reversed. A tie falls through to today's order.
        if (ba) { const age = String(b["first_detected_at"] ?? b["detected_at"] ?? "").localeCompare(String(a["first_detected_at"] ?? a["detected_at"] ?? "")); if (age !== 0) return age; }
      }
      const ra = dueRetry(a); const rb = dueRetry(b);
      if (ra !== rb) return ra ? -1 : 1;
      // Priority after attempts: writable (existing edit site in clone) > stated falsifier_spec > oldest first
      const ma = metaOf(a); const mb = metaOf(b);
      const la = ledgerOf(ma); const lb = ledgerOf(mb);
      const attemptDiff = Number(la.attempts ?? 0) - Number(lb.attempts ?? 0);
      if (attemptDiff !== 0) return attemptDiff;
      const va = checkSupplyVessel(a); const vb = checkSupplyVessel(b);
      const hasSiteA = Boolean(va && checkSupplySite(a, va));
      const hasSiteB = Boolean(vb && checkSupplySite(b, vb));
      if (hasSiteA !== hasSiteB) return hasSiteA ? -1 : 1; // existing edit site FIRST
      const hasFalsifierA = typeof ma["falsifier_spec"] === "string" && String(ma["falsifier_spec"]).trim().length > 0;
      const hasFalsifierB = typeof mb["falsifier_spec"] === "string" && String(mb["falsifier_spec"]).trim().length > 0;
      if (hasFalsifierA !== hasFalsifierB) return hasFalsifierA ? -1 : 1; // stated falsifier FIRST
      return String(a["first_detected_at"] ?? a["detected_at"] ?? "").localeCompare(String(b["first_detected_at"] ?? b["detected_at"] ?? ""));
    });
  // CHECK-WRITER TARGETING (user ruling): honest rows the lane could land get their check written first, then the other
  // honest rows, then the rest (landableBandOf, the baseline's bands), each band in the order above. Ordering only:
  // every candidate is still walked and the per-tick bound is unchanged. The scope is the tick's one read (scopeOnce,
  // which the scope skip below reuses), taken only when there is an honest row to band; unreadable, nothing is promoted.
  const twScope = ordered.some((r) => isSystemBornLineage(r, byIdAll)) ? await scopeOnce() : null;
  const candidates = byLandableBand(ordered, byIdAll, twScope);
  const anchorsOf = new Map<string, CheckAnchor[]>();
  const declCache = new Map<string, Set<string>>();
  /** With no edit site, a symbol resolves only if the vessel's own src declares it (cached per tick). */
  const vesselDeclarations = (vessel: string, reader: SrcReader): Set<string> => {
    const hit = declCache.get(vessel);
    if (hit) return hit;
    const names = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const rel of reader.list(dir)) {
        if (/\.(?:[cm]?[jt]sx?)$/.test(rel) && !/\.(?:test|check)\./.test(rel)) { const src = reader.read(rel); if (src) for (const n of declaredNames(src)) names.add(n); }
        else if (!/\.[A-Za-z0-9]+$/.test(rel)) walk(rel, depth + 1);
      }
    };
    walk("src", 0);
    declCache.set(vessel, names);
    return names;
  };
  let scopeUnread: string | null = null;
  // Goals placed on each peer this tick: debited from the free slots it reports (a peek, not a claim).
  const placedThisTick = new Map<string, number>();
  for (const row of candidates) {
    if (dispatched.length >= perTick && controlMarked.length >= perTick) break;
    const id = String(row["id"]);
    const meta = metaOf(row);
    const ledger = ledgerOf(meta);
    const holdable = !nonEmpty(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION;
    if (checkSupplyRowArm(row, controlFraction) === "control") {
      // CONTROL ARM: classified and recorded, never sent a goal. The mark carries its stamp (the time-box's clock).
      if (meta["gap_check_supply_arm"] === "control" || controlMarked.length >= perTick) continue;
      controlMarked.push(id);
      if (!pointer.dry_run) await writeMeta(row, { ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}), gap_check_supply_arm: "control", gap_check_supply_arm_at: nowIso });
      continue;
    }
    if (dispatched.length >= perTick) continue;
    if (ledger.state === "armed" || ledger.state === "exhausted") continue;
    // A goal in flight is settled by the OUTCOME step (read back, or lost past the bound), never by sending another.
    if (ledger.state === "goal_dispatched" || ledger.state === SEND_PENDING) continue;
    const attempts = Number(ledger.attempts ?? 0);
    const last = Date.parse(String(ledger.last_dispatch_at ?? ""));
    if (ledger.state === "non_attempt" || ledger.state === "send_refused") {
      const nb = Date.parse(String(ledger.not_before ?? ""));
      if (Number.isFinite(nb) && now < nb) continue; // its own shaped wait (CHANGE-30), not the attempt backoff
    } else if (attempts > 0 && Number.isFinite(last) && now < last + backoffMs * 2 ** (attempts - 1)) continue;
    if (attempts >= maxAttempts) {
      exhausted.push(id);
      const hist = settledHistory(ledger);
      const whys = hist.map((h) => String((h["outcome"] as Row | undefined)?.["lost_why"] ?? h["state"] ?? "?")).join(", ");
      if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, history: hist, state: "exhausted", reason: `${attempts} test-writing goals did not yield a red check${whys ? ` (attempts settled as: ${whys})` : ""}` } });
      continue;
    }
    const vessel = checkSupplyVessel(row);
    if (!vessel) { skipped.push({ id, reason: "no_vessel" }); continue; }
    // ALWAYS THE GAP'S OWN CHECK FILE (B′), never an existing test and never an older ledger's discovered *.test.ts:
    // an intended red in a file bun discovers reads as a regression in every whole-suite run.
    const site = checkSupplySite(row, vessel);
    const testFile = checkSupplyTestFile(id);
    // SCOPE: a goal whose target (the edit site, or the vessel, and the check file) the live autonomyScope excludes can
    // never land through the lane. No goal; one skip record. An absent or unreadable record decides nothing here (the
    // lane's admission is the containment) and is reported once per tick.
    const scope = await scopeOnce();
    if (!scope.readable && !scopeUnread) { scopeUnread = scope.reason; console.warn(`[gap-check-supply] scope not applied this tick: ${scope.reason}`); }
    const targets = checkSupplyScopeTargets(vessel, site, testFile);
    const hit = scope.readable ? targets.map((t) => ({ t, e: autonomyScopeExcludes(scope, t) })).find((x) => x.e !== null) : undefined;
    if (hit) {
      const reason = `target ${hit.t} is excluded by the autonomy scope (${hit.e}); the lane could never land it`;
      skipped.push({ id, reason });
      if (!pointer.dry_run && !(ledger.state === "scope_excluded" && ledger.reason === reason)) await writeMeta(row, { check_supply: { ...ledger, state: "scope_excluded", reason } });
      continue;
    }
    // I1: a gap that has its check and lacks only a site is LOCALIZED, never sent a test-writing goal.
    if (localizableBySupply(row)) {
      if (localized.length >= perTick) continue; // the same shaped per-tick bound as a dispatch (max_per_tick)
      const loc = await localizeForSupply(row, vessel, site);
      const locExcl = loc && scope.readable ? autonomyScopeExcludes(scope, loc.file) : null;
      if (!loc || locExcl) {
        const reason = !loc ? "no_site: no src file named by the gap's evidence exists, and the localizer found no confident one" : `localized site ${loc.file} is excluded by the autonomy scope (${locExcl})`;
        skipped.push({ id, reason });
        if (!loc && !pointer.dry_run) await noteGapLocalization({ caller: "check_supply", gap: row, answer: null });
        continue;
      }
      if (pointer.dry_run) { localized.push({ id, edit_site: loc.file, method: loc.method }); continue; }
      const record = { gap_id: id, file: loc.file, evidence: loc.evidence, method: loc.method, created_at: nowIso };
      const lw = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        gap: { id: row["id"], category: row["category"], source: row["source"], summary: row["summary"], detected_at: row["detected_at"], status: row["status"] ?? "open",
          classification_metadata: { edit_site: loc.file, localized_by: "gap-check-supply", localization_method: loc.method }, localization: record },
      } as never);
      if (lw.shape === "structuredError") { skipped.push({ id, reason: `localization write refused: ${JSON.stringify(lw.body).slice(0, 160)}` }); continue; }
      touched.add(id);
      localized.push({ id, edit_site: loc.file, method: loc.method });
      await noteGapLocalization({ caller: "check_supply", gap: row, answer: { file: loc.file, method: loc.method, description: loc.evidence[0]?.why } });
      continue;
    }
    const mode = "check_file";
    // The titles the check file already holds (a previous attempt's landed, refused check): only titles added after
    // this dispatch can arm the gap.
    let baselineTitles: string[] = [];
    try { baselineTitles = declaredTestTitles(readFileSync(join(clonesRoot(), vessel, testFile), "utf-8")); } catch { baselineTitles = []; }
    const summary = String(row["summary"] ?? "");
    const reader = srcReaderAt(join(clonesRoot(), vessel));
    const siteRel = vesselRelativeEditSite(site);
    const siteSrc = siteRel ? reader.read(siteRel) : null;
    // A CODE site needs a falsifiable anchor from the evidence, or from what its writers put on the row (checkSupplyAnchors);
    // never guess one (a config site's goal is built from the template it names). No anchor: no goal, one loud skip
    // record, re-read every tick in case the evidence grows.
    if (!configEditSite(siteRel, siteSrc)) {
      const anchors = checkSupplyAnchors(row, siteSrc, byIdAll, siteSrc === null ? vesselDeclarations(vessel, reader) : null).anchors;
      if (anchors.length === 0) {
        skipped.push({ id, reason: NO_ANCHOR_REASON });
        // Its own line once, when its ledger first records it; every pass counts it in the dispatch line below.
        if (!(ledger.state === "no_anchor" && ledger.reason === NO_ANCHOR_REASON)) {
          console.warn(`[gap-check-supply] ${id}: ${NO_ANCHOR_REASON}; no check goal (falsifier stays unknown)`);
          if (!pointer.dry_run) await writeMeta(row, { check_supply: { ...ledger, state: "no_anchor", reason: NO_ANCHOR_REASON } });
        }
        continue;
      }
      anchorsOf.set(id, anchors);
    }
    const goal = checkSupplyGoal(vessel, testFile, summary, site, reader, anchorsOf.get(id) ?? [], settledHistory(ledger), meta);
    if (pointer.dry_run) { dispatched.push({ id, goal, dispatch_id: null }); continue; }
    noteCauseAnchorGoal({ gapId: id, meta, siteSrc, siteRel });
    // RECORD BEFORE SEND (CHANGE-30): the in-flight record is written FIRST, without the goal text, so no send is ever
    // unrecorded. If even that write is refused, nothing is sent: a send this tick cannot record is a send the next
    // tick would repeat (the 455-a-day loop). A crash between this write and the send settles through the existing
    // send_pending path (OUTCOME recovers it as a send never confirmed), so the record is safe to leave. The record
    // before the send is send_pending, never goal_dispatched: goal_dispatched is written only with its dispatch id.
    // PLACEMENT (law 11, compose-placement.ts): with no free local slot of the class this compose is admitted as (a
    // supply compose is never armed: feature_compose's composeArmed), a peer that composes the vessel, sees the row,
    // admits the targets and has a free slot takes it. Decided before the record, so the record names where it went.
    const placement = await placeCompose({ gap_id: id, vessel, targets, armed: false }, localNode, placedThisTick, { arm: placementArmKnobs(rhythm.body) });
    const placed = placement.where === "peer" ? placement : null;
    if (placed) console.log(`[gap-check-supply] ${id}: placed on ${placed.node}: ${placed.why}`);
    // THE SEND NAMES THE CHECK FILE, IT DOES NOT HAVE ONE: intended_test_file. test_file is written by the arm step once
    // the file is at origin/dev; a prior attempt's is dropped here, so the record never claims a check this send has
    // not produced.
    const { goal: _priorGoal, not_before: _priorNotBefore, placed_by: _priorPlacedBy, placement: _priorPlacement, test_file: _priorTestFile, ...ledgerRest } = ledger;
    void _priorGoal; void _priorNotBefore; void _priorPlacedBy; void _priorPlacement; void _priorTestFile;
    const intent: Ledger = { ...ledgerRest, state: SEND_PENDING, attempts: attempts + 1, last_dispatch_at: nowIso, intended_test_file: testFile, vessel, mode,
      baseline_titles: baselineTitles, edit_site: site, dispatch_id: null, dispatch_node: placed ? placed.node : localNode, dispatch_host: placed ? placed.via : GOAL_HOST_ENDPOINT,
      ...(placed ? { placed_by: localNode, placement: placed.why } : {}), reason: "", outcome: {}, history: settledHistory(ledger) };
    const arm = { ...(holdable ? { disposition: CHECK_SUPPLY_DISPOSITION } : {}), gap_check_supply_arm: "treatment" };
    const iw = await writeMeta(row, { ...arm, check_supply: intent }, undefined, ledger);
    if (ledgerMoved(iw)) {
      // ANOTHER NODE RECORDED ITS OWN DISPATCH ON THIS ROW since this pass read it: nothing was written, nothing is sent.
      const reason = "not sent: another writer's check-supply record replaced the one this pass read (its dispatch stands)";
      skipped.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason}`);
      continue;
    }
    if (iw.shape === "structuredError") {
      const reason = `not sent: the in-flight record could not be written (${String((iw.body as Row)?.["detail"] ?? (iw.body as Row)?.["failure_mode"] ?? "").slice(0, 120)})`;
      skipped.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason}`);
      // A REFUSED WRITE MAY STILL LAND. On a node that forwards its gap store, "unreachable: The operation timed out"
      // is this side's timeout, not the holder's refusal: five rows were left at goal_dispatched with no dispatch id
      // and no goal for a send that never happened. Nothing was sent, so if the store now holds THIS pass's in-flight
      // record it is put back as it was read; if it does not, nothing is written (the store has no conditional write,
      // and a write here could only race a late intent). Either way an intent that lands late cannot stay: the next
      // pass's OUTCOME recovers a send_pending record as the non-attempt it is (send_unconfirmed), never as lost.
      const reread = await resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
      const stored = ledgerOf(metaOf((((reread.body ?? {}) as { gaps?: Row[] }).gaps ?? [])[0] ?? {}));
      if (stored.state === SEND_PENDING && !nonEmpty(stored.dispatch_id) && stored.last_dispatch_at === nowIso) {
        const back = await writeMeta(row, { check_supply: ledger }, undefined, intent);
        console.warn(`[gap-check-supply] ${id}: the unsent in-flight record had landed; ${back.shape === "structuredError" ? "it could not be put back, so the next pass recovers it as unconfirmed" : "put back as read"}`);
      }
      continue;
    }
    const send = { type: "dispatch_goal" as const, goal, variables: { gap_id: id, check_supply: true }, timeout_ms: 15_000 };
    const r = placed ? await dispatchGoalOnPeer(placed.via, send) : await resolveDispatchGoal(send);
    if (r.shape !== "goalDispatchResult") {
      // ONE classification of the send (CHANGE-30): a refusal or a non-attempt is recorded as what it is, with its wait;
      // only a genuine failed send is an attempt.
      const c = classifySendFailure(r);
      if (c.kind === "failed") {
        refused += 1;
        skipped.push({ id, reason: `dispatch failed: ${c.reason.slice(0, 120)}` });
        await writeMeta(row, { ...arm, check_supply: { ...intent, state: "dispatch_failed", reason: `dispatch failed: ${c.reason}`, outcome: { send_failed: true, http: c.http_status }, non_attempt_streak: 0 } }, undefined, intent);
      } else {
        const d = delayFor(c.kind, intent, c.retry_after_s);
        const held = nonAttemptLedger(intent, c.kind, `${c.kind === "refused" ? "send refused by the receiver" : "send not taken (non-attempt)"}: ${c.reason}`, d.ms, now, { send_failed: true, http: c.http_status, kind: c.kind }, d.streak);
        outcomes.not_attempts.push({ id, kind: c.kind, reason: String(held.reason), not_before: String(held.not_before) });
        skipped.push({ id, reason: String(held.reason).slice(0, 160) });
        console.warn(`[gap-check-supply] ${id}: ${held.state} (not charged; next not before ${held.not_before}): ${c.reason.slice(0, 160)}`);
        const hw = await writeMeta(row, { ...arm, check_supply: held }, undefined, intent);
        if (ledgerMoved(hw)) console.warn(`[gap-check-supply] ${id}: ${held.state} not written: another writer's record replaced this pass's in-flight record, so it stands`);
      }
      continue;
    }
    const dispatchId = ((r.body ?? {}) as { dispatch_id?: string | null }).dispatch_id ?? null;
    // A SEND THE GOAL-HOST ANSWERED WITH NO ID IS NEVER RECORDED IN FLIGHT: its outcome could never be read. It is a
    // failed send, refused and logged with what was sent; goal_dispatched is written only with an id.
    if (!nonEmpty(dispatchId)) {
      refused += 1;
      const reason = "dispatch failed: send_without_id: the goal-host accepted the goal and answered no dispatch id, so its outcome cannot be read";
      skipped.push({ id, reason });
      console.warn(`[gap-check-supply] ${id}: ${reason}`);
      await writeMeta(row, { ...arm, check_supply: { ...intent, state: "dispatch_failed", reason, goal, outcome: { send_failed: true, no_dispatch_id: true }, non_attempt_streak: 0 } }, undefined, intent);
      continue;
    }
    dispatched.push({ id, goal, dispatch_id: dispatchId });
    const sent: Ledger = { ...intent, state: "goal_dispatched", dispatch_id: dispatchId, goal };
    const w = await writeMeta(row, { ...arm, check_supply: sent }, undefined, intent);
    // The full record (with the goal text) refused: keep the dispatch id at least, so its outcome stays readable.
    if (ledgerMoved(w)) console.warn(`[gap-check-supply] ${id}: dispatch ${dispatchId} not recorded: another writer's record replaced this pass's in-flight record`);
    else if (w.shape === "structuredError") await writeMeta(row, { ...arm, check_supply: { ...intent, state: "goal_dispatched", dispatch_id: dispatchId } }, undefined, intent);
  }

  // A localized gap is work done this tick (I1), graded as a dispatch is.
  const leg = checkSupplySettlementLeg({ dispatched: dispatched.length + localized.length, armed: armed.length, refused });
  // The credit on the claimed pacing (scope-earn-in's credit leg): alpha or beta, and staleness stays reset. Settled on
  // the pre-claim staleness, a beta leg would write the family straight back to due.
  if (leg && !pointer.dry_run) await settleFamily({ ...rhythm, body: { ...rhythm.body, ...RAN_PACING } }, leg, { ...due, staleness: 0 }, undefined, settledKeys());
  bookkeepingLine("due");

  const after = await resolveSubstrateGap({ type: "substrateGap", limit: 1_000_000 } as never);
  const afterRows = ((after.body ?? {}) as { gaps?: Row[] }).gaps ?? [];
  // ONE COMPACT LINE PER DISPATCH PASS: what it sent and why the rest were not sent, by reason (each row's own reason
  // stays on its ledger and in the report's skipped list).
  const skipBy = new Map<string, number>();
  for (const s of skipped) { const k = skipReasonKey(s.reason); skipBy.set(k, (skipBy.get(k) ?? 0) + 1); }
  console.log(`[check-supply] dispatch pass: sent=${dispatched.length} localized=${localized.length} exhausted=${exhausted.length} control=${controlMarked.length} skipped=${skipped.length}${skipBy.size ? ` (${[...skipBy].map(([k, n]) => `${k}=${n}`).join(" ")})` : ""} node=${localNode}`);
  const measures = checkSupplyMeasures(afterRows, now - windowMs);
  const arms = { treatment: 0, control: 0 };
  for (const r of afterRows) {
    const a = metaOf(r)["gap_check_supply_arm"];
    if (a === "treatment" || a === "control") arms[a] += 1;
  }
  return {
    shape: "gapCheckSupplyReport",
    body: {
      fired: dispatched.length + armed.length + localized.length > 0,
      reason: leg === "alpha" ? "due" : leg === "beta" ? "refused" : "nothing_to_do",
      settlement: leg ?? "none",
      due_score: due.due_score,
      needs_localization: open.filter((r) => checkSupplyDisposition(r) !== null).length,
      dispatched,
      armed,
      not_armed: notArmed,
      refused,
      ...(regated.length ? { region_regated: regated } : {}),
      ...(resettled.length ? { resettled } : {}),
      exhausted,
      control_marked: controlMarked,
      localized,
      ...(unarmedOwnCheck.length ? { unarmed_own_check: unarmedOwnCheck } : {}),
      ...(testDefects.length ? { test_defects: testDefects } : {}),
      ...(clearedInherited.length ? { cleared_inherited: clearedInherited } : {}),
      outcomes,
      ...(scopeUnread ? { scope_unread: scopeUnread } : {}),
      arms,
      skipped: skipped.slice(0, 25),
      measures,
      dry_run: pointer.dry_run === true,
    },
  };
}
