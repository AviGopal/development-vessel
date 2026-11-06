/**
 * GAP ELIGIBILITY (gap-judge-core, closed). The pure predicates every admission, eligibility nudge, hold and
 * attempt-credit decision reads: whether a gap row is compose work (composeEligibilitySkipReason), which holds park
 * it, whether a compose outcome was an attempt at all (isNonAttemptComposeResult, isInfraRefusalBody,
 * isTerminalRefusalResult) and whether a landing verdict is a measurement (landVerdictIsMeasured).
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.1): a judge
 * must not live in the file whose changes it judges. It imports only node builtins and gap-policy (another core module,
 * for the own-check freshness predicate's clone root and edit-site rule), so every closed reader (substrate-gap,
 * vessel-mitosis-cutover, feature-compose, check-supply-admission) can depend on it without pulling in the lane.
 */
import { join, posix } from "node:path";
import { editSitePath, vesselsCloneRoot } from "./gap-policy.js";

/**
 * The file a gap says it is about, in the order the rest of this file already trusts:
 * `edit_site` first, then the legacy aliases, then a top-level field.
 *
 * `gap.file_path` alone is not enough — measured 2026-08-10 over the live store, 0 of
 * 360 gaps carried a top-level `file_path` while 104 carried
 * `classification_metadata.edit_site`. Reading only the former handed `undefined`
 * downstream and threw.
 */
export function gapEditSite(gap: Record<string, unknown>, meta: Record<string, unknown>): string | undefined {
  for (const f of ["edit_site", "file_path", "change_site", "path"] as const) {
    const v = meta?.[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const top = gap?.["file_path"];
  return typeof top === "string" && top.trim() ? top.trim() : undefined;
}

/**
 * (E4) The admission exclusion for a gap whose recorded attempts all failed for the same reason, after lowercasing
 * and masking digits and hex runs (first 120 chars), or null. Measured 2026-09-12: 20-27 of ~1460 open gaps qualify.
 * Two predicates, kept from what were three copies of this block (the second was the first verbatim, so it never
 * fired): (1) at least 3 reasons over 20 chars and one distinct key, where an "== install" build-log reason counts
 * as a key of its own, so it breaks identity; labelled with the lesson count. (2) at least 3 keys over 20 chars once
 * "== install" reasons are dropped, all identical; that dump is the same for every failure, so it is not evidence.
 */
export function identicalRepeatedFailure(lessons: unknown): string | null {
  if (!Array.isArray(lessons)) return null;
  const reason = (l: unknown): string => String((l as Record<string, unknown> | null | undefined)?.["reason"] ?? "");
  const key = (r: string): string => r.toLowerCase().replace(/[0-9a-f]{8,}/g, "H").replace(/[0-9]+/g, "N").slice(0, 120);
  if (lessons.filter((l) => reason(l).trim().length > 20).length >= 3
    && new Set(lessons.map((l, i) => reason(l).toLowerCase().startsWith("== install") ? "undistilled-build-log-placeholder-" + i : key(reason(l))).filter((s) => s.length > 20)).size === 1) {
    return "identical_repeated_failure(" + lessons.length + ")";
  }
  const keys = lessons.map((l) => key(reason(l))).filter((s) => s.length > 20 && !s.startsWith("== install"));
  return keys.length >= 3 && new Set(keys).size === 1 ? "identical_repeated_failure" : null;
}

/**
 * Non-empty string, else null. Empty string counts as ABSENT deliberately: it is the only
 * way to retire a bad predicate, because substrate-gap.ts:522-524 carries any key omitted
 * from a write forward from the existing row — gap metadata cannot be deleted.
 */
export function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Infrastructure refusal: the host could not ground or admit the compose, so no draft ran and
// the outcome carries zero evidence about the gap class. Covers everything
// isNonAttemptComposeResult exempts, plus grounding/guard REFUSED (e.g. Grounding window (0 bytes)), and a target
// vessel this node cannot isolate (feature-compose composeIsolationVessels; it was a grounding refusal before).
export function isInfraRefusalBody(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  if (isNonAttemptComposeResult(cb)) return true;
  const stage = String(cb.stage ?? "");
  // live_tree_writes_held: patch_with_tools refused at entry under the operator hold on live-tree writes
  // (lib/operator-hold.ts). No draft ran and nothing was touched, so it says nothing about the class.
  return (stage === "grounding" || stage === "guard" || stage === "target_vessel_not_isolated" || stage === "live_tree_writes_held") && String(cb.verdict ?? "") === "REFUSED";
}

/**
 * A compose that never RAN is not a compose that FAILED.
 *
 * feature-compose returns `verdict: "BUSY"` / `stage: "capacity"` when the slot cap is
 * hit, and its own comment marks the distinction as load-bearing: "BUSY, not REFUSED.
 * Capacity is TRANSIENT — the work is fine, the host is full — whereas REFUSED means
 * this should not be done." goal-host honours it (backs off 45s and retries). This file
 * did not: the word BUSY appeared nowhere in it, so a capacity refusal fell through as
 * a plain `ok:false` into bumpFailedAttempts, which BOTH decays the gap's score and
 * calls updateCalibration(category, false). Since hopeless() excludes a category at
 * attempts >= 8 with lands === 0, a run of capacity refusals could seal an ENTIRE
 * CATEGORY without a single compose ever having run — a non-attempt recorded as a
 * failed attempt.
 *
 * Measured 2026-08-29: `reach_grounding_gap` went from absent (attempts 0) to
 * attempts=5 / lands=0 in ~6h on refusals alone, three short of sealing, while five
 * gaps sat at failed_attempts=2 with `approach_decisions[].outcome.joined_at` within
 * 200-800ms of the pick — orders of magnitude too fast for a compose to have run.
 *
 * `environment` was already excluded at the main call site for exactly this reason;
 * capacity is the same class, so both live here and every call site asks one question.
 */
/** A TERMINAL refusal (feature-compose op10): the gap is closed, or its own check is already GREEN on the
 *  parent tree. Unlike a non-attempt the compose DID run, so it keeps its full cooldown; unlike a failure no
 *  repair can change it, so it never bumps failed_attempts, never narrows and never decomposes (those spawn
 *  the redispatches that re-composed a fixed gap for 40 min on 2026-09-30). */
export function isTerminalRefusalResult(cb: Record<string, unknown> | null | undefined): boolean {
  return String(cb?.failure_kind ?? "") === "terminal_refusal";
}

/** Hours an OPEN gap whose own check was found GREEN on the parent stays out of admission. The check passing
 *  without a fix means the gap is already fixed (the sweep will close it) or its check is wrong (an operator
 *  must look); re-picking it every cooldown can do neither. */
export const OWN_GREEN_ADMISSION_TTL_MS = 6 * 60 * 60 * 1000;
export function greenOnParentFresh(meta: Record<string, unknown>, nowMs: number = Date.now()): boolean {
  const m = meta.own_check_green_on_parent as { at?: unknown } | undefined;
  const at = typeof m?.at === "string" ? Date.parse(m.at) : NaN;
  return Number.isFinite(at) && nowMs - at < OWN_GREEN_ADMISSION_TTL_MS;
}

/** Dispositions that park a gap OUT of autonomous work until a human acts: needs_information (waiting for a fact
 *  or a localization) and awaiting_operator_review (a landing waiting for review). Admission reads them, and
 *  generic writers must not overwrite them (markPendingVerification clobbered awaiting_operator_review within
 *  40 s on 2026-09-30); a human answer clears needs_information (escalation-disposition-apply). */
// "needs_info" is the spelling gap-lifecycle-scan writes when it parks a chronic re-emitter (qa, 2026-09-30).
export const PARKING_DISPOSITIONS: readonly string[] = ["needs_information", "needs_info", "awaiting_operator_review"];
export function isParkingDisposition(d: unknown): boolean {
  return typeof d === "string" && PARKING_DISPOSITIONS.includes(d);
}
/** The parks that wait for a fact (needs_information, needs_info): what a fact can lift (escalation-disposition-apply's
 *  human answer; admission's needs_information drain). awaiting_operator_review waits for a review, never a fact. */
export const INFORMATION_PARKS: readonly string[] = PARKING_DISPOSITIONS.filter((d) => d !== "awaiting_operator_review");

/** Categories resolveGapToFeature routes to a resolver other than feature_compose (trace-store reconcile seed,
 *  doc_drift_fix, author_producer). The compose gate does not judge them. A test pins that every category branch in
 *  resolveGapToFeatureOnce is listed here (read through gap-admission, which re-exports it). */
export const NON_COMPOSE_ROUTE_CATEGORIES: ReadonlySet<string> = new Set(["trace_store_reconciliation", "documentation_drift", "unreachable_producer", "orphaned_capability"]);

/** Whether a route other than feature_compose acts on `row` with no check and no site: a NON_COMPOSE_ROUTE_CATEGORIES
 *  category, an orphan producer named by its id (gap-admission composeAdmissionExclusion's orphan route), or a
 *  goal-walk capability gap (targetedComposeExclusion's exemption). Read by the write seam's detector rule
 *  (substrate-gap.ts A DETECTOR ROW NOTHING CAN ARM), which marks no such row. */
export function routedOffCompose(row: Record<string, unknown>): boolean {
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  return NON_COMPOSE_ROUTE_CATEGORIES.has(String(row["category"] ?? "")) || /orphaned[_-]capability/i.test(String(row["id"] ?? "")) || String(meta["kind"] ?? "") === "capability_gap";
}

/** A gap with no check of its own whose failing test the substrate is writing (gap-check-supply): written on the
 *  row when the tick dispatches that test's edit goal, and cleared ("") by the write that arms the gap from it.
 *  Not a parking disposition: no human is waited on, the supply tick is. The eligibility predicate holds it. */
export const CHECK_SUPPLY_DISPOSITION = "needs_localization";

/** The landed sha a row is held for, or null: pending_outcome_verification as a string of length >= 7 (the rule
 *  pendingSweepCandidates and pickSkipPending read it by) that the sweep has not released (pending_released_sha, the
 *  stamp a not-resolved release let go of). A cleared "" stamp holds nothing; a NEW sha after a release holds again.
 *  A release made before the marker existed (disposition cleared to "", stamp kept, no pending_released_sha) cannot be
 *  told apart from a re-landing over it, so it is HELD, by design (qa ruling): the sweep's next pass releases it. */
export function landedShaHold(meta: Record<string, unknown>): string | null {
  const sha = meta.pending_outcome_verification;
  return typeof sha === "string" && sha.length >= 7 && sha !== meta.pending_released_sha ? sha : null;
}

/** A landed gap held for its verdict: disposition pending_verification (markPendingVerification), OR a landed-sha
 *  stamp the sweep has not released (landedShaHold), with nothing yet saying the landing failed. The cutover's
 *  stampPendingLand writes only the sha (pending_outcome_verification, pending_set_at, the landed_unverified fields)
 *  and NO disposition, so keyed on the disposition alone the hold never held a cutover-stamped row and it could be
 *  composed and re-landed. regressed_by or a BEHAVIORAL VERIFICATION FAILED summary means it did not fix the gap, so
 *  the gap is work again; the sweep's not-resolved verdict lifts the hold (liftLandVerificationHold). The parity
 *  contract with boredom-vessel's mirror (src/goal-generation.ts isAwaitingLandVerification) is the fixture set
 *  test/fixtures/land-verification-hold-fixtures.json, read byte for byte by both vessels' tests. */
export function isAwaitingLandVerification(gap: Record<string, unknown>): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  if (meta.disposition !== "pending_verification" && landedShaHold(meta) === null) return false;
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return false;
  if (String(gap.summary ?? "").includes("BEHAVIORAL VERIFICATION FAILED")) return false;
  return true;
}

/** The stage, compose skip reason and falsifier_unresolvable_reason prefix of a gap whose edit site is its own check. */
export const EDIT_SITE_IS_OWN_CHECK = "edit_site_is_own_check";
/**
 * A path as one vessel's repo-relative file: `:line` and backslashes dropped, leading "./" and "/" stripped, and a
 * repos/<vessel>/ prefix (or an absolute clone path ending in repos/<vessel>/ or vessels/<vessel>/) taken off and
 * kept as the vessel. Case is kept as stored. null for an empty path.
 */
export function vesselFileOf(path: unknown, vesselHint?: unknown): { vessel: string | null; rel: string } | null {
  if (typeof path !== "string" || !path.trim()) return null;
  let s = path.trim().replace(/\\/g, "/").replace(/:\d+.*$/, "");
  let vessel: string | null = null;
  const m = /^(?:\/?(?:[^/]+\/)*?)(?:repos|vessels)\/([^/]+)\/(.+)$/.exec(s.replace(/^(?:\.\/)+/, ""));
  if (m && /^(?:src|test|tests|scripts)\//.test(m[2]!)) { vessel = m[1]!; s = m[2]!; }
  s = s.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!vessel && typeof vesselHint === "string" && vesselHint.trim()) vessel = vesselHint.trim().replace(/^repos\//, "").replace(/\/+$/, "") || null;
  return s ? { vessel, rel: s } : null;
}
/**
 * A GAP WHOSE EDIT SITE IS ITS OWN CHECK CAN ONLY BE CLOSED BY SELF-CERTIFICATION. When the file the lane edits is the
 * test file its check runs (evidence_resolve test_suite's input.test_file, or the supply's check file by name),
 * the only edit that greens the check is editing the check. The semantic gate vetoes that edit every time, so the row
 * loops until its lineage cap (recommit-route-edit-7ffa6330-step-2-*: edit_site == test_file ==
 * src/resolvers/substrate-gap.test.ts, about 5 composes in 2 h on two nodes). Paths are compared repo-relative after
 * vesselFileOf; two named vessels that differ are different files. Returns the site and the check it equals, or null.
 */
export function editSiteIsOwnCheck(row: Record<string, unknown>): { site: string; check: string } | null {
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const rawSite = gapEditSite(row, meta);
  const site = vesselFileOf(rawSite);
  if (!site || !rawSite) return null;
  // A TEST-DEFECT ROW names its test file as the site on purpose (gap-check-supply testDefectLocalizationDecision): its
  // defect is in a child script the test runs, and a draft of that file is admitted only by a check DISTINCT from the
  // row's own (the child-parse certifier, feature-compose test-defect admission). Exempt only when the record's
  // certifier names this same file; the own check still closes the row.
  const td = meta["test_defect"] as { certifier?: { shape?: unknown; test_file?: unknown; vessel?: unknown } } | null | undefined;
  const cert = td && typeof td === "object" ? td.certifier : undefined;
  if (cert && cert.shape === "test_defect_child_parse") {
    const f = vesselFileOf(cert.test_file, cert.vessel);
    if (f && f.rel === site.rel && (!f.vessel || !site.vessel || f.vessel === site.vessel)) return null;
  }
  const checks: Array<{ path: unknown; vessel: unknown }> = [];
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: { test_file?: unknown; vessel?: unknown } } | null | undefined;
  if (er && typeof er === "object" && er.shape === "test_suite" && er.input && typeof er.input === "object") checks.push({ path: er.input.test_file, vessel: er.input.vessel });
  // The supply's check file by NAME (the file its goal writes), landed or not: an edit site that is that file is the
  // same loop before the check lands. intended_test_file at send; test_file on older records and once landed.
  const ledger = meta["check_supply"] as { test_file?: unknown; intended_test_file?: unknown; vessel?: unknown } | null | undefined;
  if (ledger && typeof ledger === "object") for (const path of [ledger.intended_test_file, ledger.test_file]) if (path !== undefined) checks.push({ path, vessel: ledger.vessel });
  for (const c of checks) {
    const f = vesselFileOf(c.path, c.vessel);
    if (f && f.rel === site.rel && (!f.vessel || !site.vessel || f.vessel === site.vessel)) return { site: rawSite, check: String(c.path) };
  }
  return null;
}

/** The metadata write that un-arms an own-check row: the decision, recorded on it. The write seam re-labels the check
 *  unresolvable (substrate-gap classifyFalsifier) on the same write. One record for every writer (the pick, the supply). */
export function ownCheckUnarmMeta(own: { site: string; check: string }, at: string): Record<string, unknown> {
  return { own_check_unarmed: { at, site: own.site, check: own.check, reason: EDIT_SITE_IS_OWN_CHECK } };
}

/** Why a gap row is not compose work, or null when it is: THE ONE ELIGIBILITY PREDICATE shared by the autonomous
 *  picker's admission, the drain observer's compose nudge and the gap-write path's compose nudge, so a nudge never
 *  fires for a gap the picker cannot take and the two cannot drift. Eligible = open, armed (falsifier class1/class2,
 *  as a string or {class}, on a check the supply did not refuse: checkSupplyRefusedOwnCheck), naming an edit site
 *  (edit_site, file_path, change_site, suspected_real_location or a row-level file_path) that is not its own check (editSiteIsOwnCheck), and not held (operator_hold, a parking disposition, a check being supplied (CHECK_SUPPLY_DISPOSITION), a landing awaiting its verdict). */
export type ComposeEligibilitySkipReason = "not_open" | "edit_site_is_own_check" | "unarmed" | "no_edit_site" | "held";

/** The held-from-compose predicate composeEligibilitySkipReason's own "held" branch uses: operator_hold, a parking
 *  disposition, a check being supplied (CHECK_SUPPLY_DISPOSITION), or a landing awaiting its verdict
 *  (isAwaitingLandVerification). Exported so a caller with no armed/edit-site notion of its own — the drain
 *  observer's dispatchable path, which dispatches gaps composeEligibilitySkipReason was never meant to gate — can
 *  apply the SAME hold without duplicating it or drifting from the picker's. */
export function isAdmissionHeld(row: Record<string, unknown>): boolean {
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  return meta["operator_hold"] === true || isParkingDisposition(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION || isAwaitingLandVerification(row);
}

/**
 * A HOLD COVERS ITS LINEAGE. A derived gap (recommit-<id>-<cls>, <id>-narrowed, <id>-dissent-narrowed, a decomposed
 * step) carries its parent's intent and edit site, so a hold read only on its own row was defeated by the system's
 * own retry machinery: a held gap's recommit child was picked, leased and admitted 42 min after the hold, and its
 * failed compose minted an unheld grandchild. A row's parents are the lineage keys it records (derived_from,
 * parent_gap_id, source_gap_id, root_gap_id) and one id layer stripped (a recommit- prefix with one trailing
 * -<snake_class>, or a -dissent-narrowed / -narrowed suffix), walked to the root.
 */
export function lineageParentIds(row: Record<string, unknown>): string[] {
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["derived_from", "parent_gap_id", "source_gap_id", "root_gap_id"]) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  out.push(...idLineageParents(String(row["id"] ?? "")));
  return out;
}
function idLineageParents(id: string): string[] {
  const out: string[] = [];
  if (id.startsWith("recommit-")) out.push(id.slice("recommit-".length).replace(/-[a-z][a-z0-9_]*$/, ""));
  if (id.endsWith("-dissent-narrowed")) out.push(id.slice(0, -"-dissent-narrowed".length));
  else if (id.endsWith("-narrowed")) out.push(id.slice(0, -"-narrowed".length));
  return out.filter((p) => p && p !== id);
}
/** The lineage lookup: the stored rows for an id ([] = the store holds none), or null when the store could not be
 *  read for it. */
export type LineageLookup = (id: string) => Record<string, unknown>[] | null;
/**
 * The held ancestor of a row, or null. FAIL CLOSED: an ancestor whose read fails counts as held (why "unreadable").
 * An ancestor the store holds no row for is not held, and the walk continues past it on its id, so a pruned
 * intermediate does not unhold a grandchild. The row's own hold is not read here (isAdmissionHeld reads it).
 */
export function heldLineageAncestor(row: Record<string, unknown>, lookup: LineageLookup): { id: string; why: "operator_hold" | "unreadable" } | null {
  const seen = new Set<string>([String(row["id"] ?? "")]);
  const queue = lineageParentIds(row);
  for (let n = 0; queue.length > 0 && n < 32; n++) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rows = lookup(id);
    if (rows === null) return { id, why: "unreadable" };
    for (const r of rows) {
      const rawMeta = r["classification_metadata"] ?? r["metadata"];
      if (rawMeta && typeof rawMeta === "object" && (rawMeta as Record<string, unknown>)["operator_hold"] === true) return { id, why: "operator_hold" };
      queue.push(...lineageParentIds(r));
    }
    queue.push(...idLineageParents(id));
  }
  return null;
}
/** The hold fields a derived gap is born with: its parent's operator_hold, reason and stamp, and the row the hold was set
 *  on (operator_hold_inherited_from), so a release can find every row the hold reached. Empty for an unheld parent. */
export function inheritedOperatorHold(parentId: string, parentMeta: Record<string, unknown>): Record<string, unknown> {
  if (parentMeta["operator_hold"] !== true) return {};
  const from = parentMeta["operator_hold_inherited_from"];
  return {
    operator_hold: true,
    ...(typeof parentMeta["operator_hold_reason"] === "string" ? { operator_hold_reason: parentMeta["operator_hold_reason"] } : {}),
    ...(typeof parentMeta["operator_hold_at"] === "string" ? { operator_hold_at: parentMeta["operator_hold_at"] } : {}),
    operator_hold_inherited_from: typeof from === "string" && from ? from : parentId,
  };
}

/** The row's evidence_resolve test_suite check as a vessel file (vesselFileOf), or null. */
function testSuiteCheckOf(meta: Record<string, unknown>): { vessel: string | null; rel: string } | null {
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: { test_file?: unknown; vessel?: unknown } } | null | undefined;
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || !er.input || typeof er.input !== "object") return null;
  return vesselFileOf(er.input.test_file, er.input.vessel);
}
const sameVesselFile = (a: { vessel: string | null; rel: string }, b: { vessel: string | null; rel: string }): boolean =>
  a.rel === b.rel && (!a.vessel || !b.vessel || a.vessel === b.vessel);

/** A CHECK THE SUPPLY REFUSED TO ARM DOES NOT ARM THE ROW. check_supply.state arm_refused on the very file the row's
 *  evidence_resolve test_suite runs (paths as editSiteIsOwnCheck compares them) means the supply judged that check unfit
 *  (e.g. check_satisfied_by_gutting: deleting the behaviour turns it green); a falsifier class re-stamped from the same
 *  evidence_resolve does not overrule it. A different check file, or a fresh arm (state armed), still arms. */
function checkSupplyRefusedOwnCheck(meta: Record<string, unknown>): boolean {
  const ledger = meta["check_supply"] as { state?: unknown; test_file?: unknown; vessel?: unknown } | null | undefined;
  if (!ledger || typeof ledger !== "object" || ledger.state !== "arm_refused") return false;
  const refused = vesselFileOf(ledger.test_file, ledger.vessel);
  const check = testSuiteCheckOf(meta);
  return !!refused && !!check && sameVesselFile(refused, check);
}

/** One open row's check-supply arm refusal: the refused check file, the row that carries it, and the content it judged
 *  (judged_inputs.check_sha256, "" when the record has none). */
export type RefusedSupplyCheck = { vessel: string | null; rel: string; gap_id: string; check_sha256: string };
/**
 * EVERY OPEN ROW'S ARM REFUSALS, built ONCE per pass by a caller that lists the rows (the auto-pick admission). A row
 * reads only its own check_supply, but the supply's check path is per gap id truncated (check-supply-admission
 * checkSupplyCheckPath), so a derived row (-narrowed, a recommit) runs its parent's file: the parent's refusal of that
 * file then arms the child, whose own row carries no ledger. Keyed by the vessel-relative file. The row's own
 * refusal stays decided on the row (checkSupplyRefusedOwnCheck); the current content at the file is the supply's to
 * re-judge (a changed check re-opens the parent's judgement, which drops it from the next pass's set).
 */
export type RefusedSupplyChecks = ReadonlyMap<string, readonly RefusedSupplyCheck[]>;
export function refusedSupplyChecks(rows: Iterable<Record<string, unknown>>): RefusedSupplyChecks {
  const out = new Map<string, RefusedSupplyCheck[]>();
  for (const row of rows) {
    if (String(row["status"] ?? "open") !== "open") continue;
    const rawMeta = row["classification_metadata"] ?? row["metadata"];
    const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
    const ledger = meta["check_supply"] as { state?: unknown; test_file?: unknown; vessel?: unknown; judged_inputs?: { check_sha256?: unknown } } | null | undefined;
    if (!ledger || typeof ledger !== "object" || ledger.state !== "arm_refused") continue;
    const f = vesselFileOf(ledger.test_file, ledger.vessel);
    if (!f) continue;
    const sha = ledger.judged_inputs && typeof ledger.judged_inputs === "object" && typeof ledger.judged_inputs.check_sha256 === "string" ? ledger.judged_inputs.check_sha256 : "";
    const list = out.get(f.rel) ?? [];
    list.push({ vessel: f.vessel, rel: f.rel, gap_id: String(row["id"] ?? ""), check_sha256: sha });
    out.set(f.rel, list);
  }
  return out;
}
/** Another open row's arm refusal of the file this row's test_suite check runs, or null (an empty set: always null). The
 *  auto-pick admission asks it of every row the predicate admits (gap-admission refusedCheckExclusion). */
export function refusedSupplyCheckFor(row: Record<string, unknown>, refused?: RefusedSupplyChecks): RefusedSupplyCheck | null {
  if (!refused || refused.size === 0) return null;
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const check = testSuiteCheckOf((rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>);
  if (!check) return null;
  const id = String(row["id"] ?? "");
  return refused.get(check.rel)?.find((r) => r.gap_id !== id && sameVesselFile(r, check)) ?? null;
}

export function composeEligibilitySkipReason(row: Record<string, unknown>): ComposeEligibilitySkipReason | null {
  if (String(row["status"] ?? "open") !== "open") return "not_open";
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  // Before "unarmed": an own-check site is never compose work, armed or not, and an un-armed one keeps saying why.
  if (editSiteIsOwnCheck(row)) return "edit_site_is_own_check";
  const rawFalsifier = meta["falsifier"];
  const falsifierClass = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
  if (falsifierClass !== "class1" && falsifierClass !== "class2") return "unarmed";
  if (checkSupplyRefusedOwnCheck(meta)) return "unarmed";
  if (!(meta["edit_site"] || meta["file_path"] || meta["change_site"] || meta["suspected_real_location"] || row["file_path"])) return "no_edit_site";
  if (isAdmissionHeld(row)) return "held";
  return null;
}

/** The metadata that releases a pending_verification hold ("" because the gap store carries omitted keys
 *  forward), or null when there is no such hold: parking dispositions are a human's to lift, and a null lets the
 *  sweep write once rather than every tick. */
/** The release of a land-verification hold, or null when there is none to lift: the pending_verification disposition
 *  is cleared to "" (the store carries omitted keys forward), and a held landed-sha stamp is LEFT AS IS and recorded as
 *  released (pending_released_sha), so the row stops being held for that landing and a later landing's new sha holds
 *  it again. */
export function liftLandVerificationHold(meta: Record<string, unknown>): Record<string, unknown> | null {
  // A human or supply hold set meanwhile (a parking or check-supply disposition) is not the sweep's to lift.
  if (typeof meta.disposition === "string" && meta.disposition !== "" && meta.disposition !== "pending_verification") return null;
  const sha = landedShaHold(meta);
  if (meta.disposition !== "pending_verification" && sha === null) return null;
  return { ...meta, ...(meta.disposition === "pending_verification" ? { disposition: "" } : {}), ...(sha !== null ? { pending_released_sha: sha } : {}) };
}

/** Whether the verifier's 'present' for this gap is a MEASUREMENT (class 1 literal, class 1b expected literal,
 *  class 2 resolver behaviour) rather than class-3 provenance, where 'present' only means "landed twice" and goes
 *  to a human. Mirrors the predicate order in verifyGapConditionAsync. */
export function landVerdictIsMeasured(meta: Record<string, unknown>): boolean {
  if (meta.evidence_resolve !== undefined || meta.verify_shape !== undefined) return true;
  const editSite = typeof meta.file_path === "string" ? meta.file_path : (typeof meta.edit_site === "string" ? meta.edit_site : "");
  if (!editSite) return false;
  return nonEmptyStr(meta.hardcoded_url) !== null || nonEmptyStr(meta.expected_literal) !== null;
}

export function isNonAttemptComposeResult(cb: Record<string, unknown> | null | undefined): boolean {
  if (!cb) return false;
  if (String(cb.failure_kind ?? "") === "environment") return true;
  if (String(cb.verdict ?? "") === "BUSY") return true;
  if (String(cb.stage ?? "") === "capacity") return true;
  // feature_compose's admission refusal (stage "ineligible": not compose work, nothing started). Its own comment
  // calls it a non-attempt; graded as a failure it bumped failed_attempts on every drain tick, which narrowed and
  // escalated the gap again each time (gap-lane livelock, 2026-10-10).
  if (String(cb.verdict ?? "") === "REFUSED" && String(cb.stage ?? "") === "ineligible") return true;
  // A report that says so itself: gap-to-feature's targeted refusals (targetedComposeExclusion's compose_ineligible_*,
  // the pick brakes' pick_refused_*) answer HTTP 200 with non_attempt:true and nothing started. Unrecognised here, the
  // drain observer cleared its backoff on every such 200 and re-dispatched the gap on the next scan.
  if (cb.non_attempt === true) return true;
  return false;
}

// ── the own-check baseline, read back (resolvers/own-check-baseline.ts writes it) ────────────────────────────────────────────────────────────────────────────────────────────────
/** The check's vessel (bare) from a gap row's evidence_resolve, or "" when it has no test_suite check. */
export function ownCheckVesselOf(meta: Record<string, unknown>): string {
  const er = meta["evidence_resolve"] as { shape?: unknown; input?: { vessel?: unknown; test_file?: unknown } } | undefined;
  if (!er || er.shape !== "test_suite" || typeof er.input?.test_file !== "string" || !er.input.test_file) return "";
  return typeof er.input.vessel === "string" ? er.input.vessel.replace(/^repos\//, "") : "";
}

export function sweepGitOut(cloneDir: string, args: string[]): string | null {
  let out: string | null = null;
  try {
    const p = Bun.spawnSync(["git", "-C", cloneDir, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (p.exitCode === 0) out = new TextDecoder().decode(p.stdout).trim();
  } catch { /* spawn failed: no output */ }
  return out;
}

/** The files `fromSha..toSha` changed in a vessel's clone (the clone vesselOriginDevSha reads), vessel-relative, or null
 *  when `fromSha` is not a commit there (unknown, a shallow clone, gc'd) or git fails. One diff per distinct (clone,
 *  from, to): a diff between two commits never changes, so a result is kept across passes (bounded). A failed lookup
 *  is kept for ONE PASS only (failedOwnCheckLookups), so a transient git failure is asked again in the next pass. */
const changedFilesMemo = new Map<string, string[]>();
const CHANGED_FILES_MEMO_MAX = 4096;
/** Failed own-check lookups (an unreachable sha, a git failure) of the current pass, by memo key. A PASS is delimited by
 *  its start: newOwnCheckLookupPass() clears the set, and it is called by every per-pass head reader (originDevShaOnce:
 *  admission, the pick, the landability order) and at the start of the check-supply tick's baseline dispatch. A pass
 *  that overlaps another's start only asks git once more. */
const failedOwnCheckLookups = new Set<string>();
export function newOwnCheckLookupPass(): void { failedOwnCheckLookups.clear(); }
export function vesselChangedFiles(vessel: string, fromSha: string, toSha: string): string[] | null {
  const dir = join(vesselsCloneRoot(), vessel);
  const key = `diff\0${dir}\0${fromSha}\0${toSha}`;
  const hit = changedFilesMemo.get(key);
  if (hit) return hit;
  if (failedOwnCheckLookups.has(key)) return null;
  // --no-renames: a renamed file is listed under its old name too, so a guarded file moved away is a change to it.
  const out = sweepGitOut(dir, ["cat-file", "-e", `${fromSha}^{commit}`]) === null ? null : sweepGitOut(dir, ["diff", "--no-renames", "--name-only", fromSha, toSha]);
  if (out === null) { failedOwnCheckLookups.add(key); return null; }
  const files = out.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
  if (changedFilesMemo.size >= CHANGED_FILES_MEMO_MAX) changedFilesMemo.clear();
  changedFilesMemo.set(key, files);
  return files;
}

/** The DIRECT RELATIVE imports of a vessel file at `sha` (static import/export … from "./x" | "../y", and import("./z")
 *  with a literal), each as the vessel-relative paths it can resolve to (the spec itself, .js/.mjs read as .ts/.tsx,
 *  an extensionless spec as .ts, .tsx or /index.ts): a candidate that exists at neither end is in no diff, so listing
 *  every candidate only tightens. [] when the file is not in the tree at `sha`; null when git fails (a failed lookup,
 *  kept for the pass). One read per distinct (clone, file, sha), kept like the diff memo. */
const relativeImportsMemo = new Map<string, string[]>();
export function vesselRelativeImports(vessel: string, file: string, sha: string): string[] | null {
  const dir = join(vesselsCloneRoot(), vessel);
  const key = `imports\0${dir}\0${file}\0${sha}`;
  const hit = relativeImportsMemo.get(key);
  if (hit) return hit;
  if (failedOwnCheckLookups.has(key)) return null;
  const listed = sweepGitOut(dir, ["ls-tree", "--name-only", sha, "--", file]);
  const text = listed === null ? null : listed === "" ? "" : sweepGitOut(dir, ["show", `${sha}:${file}`]);
  if (text === null) { failedOwnCheckLookups.add(key); return null; }
  const specs = [...text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["'](\.{1,2}\/[^"'\n]+)["']/g), ...text.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g)].map((m) => m[1]!);
  const out: string[] = [];
  for (const spec of specs) {
    const p = posix.normalize(posix.join(posix.dirname(file), spec));
    if (p.startsWith("../") || p === "..") continue;
    const stem = p.replace(/\.m?js$/, "");
    const cands = /\.(ts|tsx)$/.test(p) ? [p] : /\.m?js$/.test(p) ? [p, `${stem}.ts`, `${stem}.tsx`] : [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`];
    for (const c of cands) if (!out.includes(c)) out.push(c);
  }
  if (relativeImportsMemo.size >= CHANGED_FILES_MEMO_MAX) relativeImportsMemo.clear();
  relativeImportsMemo.set(key, out);
  return out;
}

/**
 * THE OWN-CHECK READING'S FRESHNESS (user ruling, "Both, freshness first"): a reading taken at `base_sha` S is fresh at
 * the vessel's origin/dev H iff S == H, or `git diff S..H` in that vessel's clone touches none of the files the reading
 * rests on: the check's test file, the reading's call_path files, and the gap's edit site (gapEditSite through
 * editSitePath); when the reading's call_path is EMPTY, also the edit site's direct relative imports read at H
 * (vesselRelativeImports; user ruling "Yes, add direct imports"; a non-empty call path does not use them), each
 * compared vessel-relative (a repos/<vessel>/ prefix is cut; a path in another vessel cannot be in
 * this vessel's diff). An unknown or unreachable S is stale, and so is a reading whose imports cannot be read. ACCEPTED
 * RISK: a change to a file the check runs that is on none of those paths (a transitive import, or a dependency of a
 * non-empty call path's files) can change the check's result without staling the reading.
 */
export function ownCheckReadingFresh(meta: Record<string, unknown>, b: OwnCheckBaselineKey, headSha: string): boolean {
  if (b.base_sha === headSha) return true;
  const vessel = ownCheckVesselOf(meta);
  if (!vessel || !/^[A-Za-z0-9_.-]+$/.test(vessel) || !/^[0-9a-f]{40}$/.test(b.base_sha) || !/^[0-9a-f]{40}$/.test(headSha)) return false;
  const changed = vesselChangedFiles(vessel, b.base_sha, headSha);
  if (!changed) return false;
  const prefix = `repos/${vessel}/`;
  const rel = (p: string): string | null => {
    const q = p.replace(/^\.?\/+/, "").split(/[\s(]/)[0] ?? "";
    if (q.startsWith(prefix)) return q.slice(prefix.length);
    return q.startsWith("repos/") || q.length === 0 ? null : q;
  };
  const site = gapEditSite({}, meta);
  const callPath = Array.isArray(b.call_path) ? (b.call_path as Array<{ path?: unknown }>).map((e) => (typeof e?.path === "string" ? editSitePath(e.path) : "")) : [];
  const siteRel = site ? rel(editSitePath(site)) : null;
  const guarded = [typeof b.test_file === "string" ? rel(b.test_file) : null, ...callPath.map(rel), siteRel].filter((g): g is string => !!g);
  if (callPath.length === 0 && siteRel && /\.(ts|tsx)$/.test(siteRel)) {
    const imports = vesselRelativeImports(vessel, siteRel, headSha);
    if (!imports) return false;
    guarded.push(...imports);
  }
  return !changed.some((f) => guarded.some((g) => f === g || f.startsWith(g.endsWith("/") ? g : `${g}/`)));
}

/**
 * The baseline on a gap row, only when it is FRESH at `currentSha` (the vessel's origin/dev now; ownCheckReadingFresh)
 * and for the check the row names now (same file and titles). A stale baseline decides nothing.
 */
/** The fields a reader keys a reading on (the whole record is resolvers/own-check-baseline.ts OwnCheckBaseline). */
export type OwnCheckBaselineKey = { base_sha: string; test_file: string; only_tests?: string[]; call_path?: unknown };
export function ownCheckBaselineFor<T extends OwnCheckBaselineKey>(meta: Record<string, unknown>, currentSha: string | null): T | null {
  const b = meta["own_check_baseline"] as T | undefined;
  if (!b || typeof b !== "object" || !currentSha || typeof b.base_sha !== "string") return null;
  const er = meta["evidence_resolve"] as { input?: { test_file?: unknown; only_tests?: unknown } } | undefined;
  const only = Array.isArray(er?.input?.only_tests) ? (er!.input!.only_tests as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  if (er?.input?.test_file !== b.test_file || JSON.stringify(only) !== JSON.stringify(b.only_tests ?? [])) return null;
  return ownCheckReadingFresh(meta, b, currentSha) ? b : null;
}
