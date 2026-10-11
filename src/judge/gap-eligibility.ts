/**
 * GAP ELIGIBILITY (gap-judge-core, closed). The pure predicates every admission, eligibility nudge, hold and
 * attempt-credit decision reads: whether a gap row is compose work (composeEligibilitySkipReason), which holds park
 * it, whether a compose outcome was an attempt at all (isNonAttemptComposeResult, isInfraRefusalBody,
 * isTerminalRefusalResult) and whether a landing verdict is a measurement (landVerdictIsMeasured).
 *
 * Moved verbatim out of src/resolvers/gap-to-feature.ts (the gap-to-feature judge split, BOUNDARY.md 1.1): a judge
 * must not live in the file whose changes it judges. Leaf module: it imports nothing, so every closed reader
 * (substrate-gap, vessel-mitosis-cutover, feature-compose, check-supply-admission) can depend on it without
 * pulling in the lane.
 */

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

/** A gap with no check of its own whose failing test the substrate is writing (gap-check-supply): written on the
 *  row when the tick dispatches that test's edit goal, and cleared ("") by the write that arms the gap from it.
 *  Not a parking disposition: no human is waited on, the supply tick is. The eligibility predicate holds it. */
export const CHECK_SUPPLY_DISPOSITION = "needs_localization";

/** A landed gap held for its verdict: disposition pending_verification (markPendingVerification) with nothing yet
 *  saying the landing failed. regressed_by or a BEHAVIORAL VERIFICATION FAILED summary means it did not fix the
 *  gap, so the gap is work again; the sweep's not-resolved verdict lifts the disposition (liftLandVerificationHold). */
export function isAwaitingLandVerification(gap: Record<string, unknown>): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  if (meta.disposition !== "pending_verification") return false;
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return false;
  if (String(gap.summary ?? "").includes("BEHAVIORAL VERIFICATION FAILED")) return false;
  return true;
}

/** Why a gap row is not compose work, or null when it is: THE ONE ELIGIBILITY PREDICATE shared by the autonomous
 *  picker's admission, the drain observer's compose nudge and the gap-write path's compose nudge, so a nudge never
 *  fires for a gap the picker cannot take and the two cannot drift. Eligible = open, armed (falsifier class1/class2,
 *  as a string or {class}), naming an edit site (edit_site, file_path, change_site, suspected_real_location or a
 *  row-level file_path), and not held (operator_hold, a parking disposition, a check being supplied (CHECK_SUPPLY_DISPOSITION), a landing awaiting its verdict). */
export type ComposeEligibilitySkipReason = "not_open" | "unarmed" | "no_edit_site" | "held";
export function composeEligibilitySkipReason(row: Record<string, unknown>): ComposeEligibilitySkipReason | null {
  if (String(row["status"] ?? "open") !== "open") return "not_open";
  const rawMeta = row["classification_metadata"] ?? row["metadata"];
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const rawFalsifier = meta["falsifier"];
  const falsifierClass = String((rawFalsifier && typeof rawFalsifier === "object" ? (rawFalsifier as { class?: unknown }).class : rawFalsifier) ?? "").toLowerCase();
  if (falsifierClass !== "class1" && falsifierClass !== "class2") return "unarmed";
  if (!(meta["edit_site"] || meta["file_path"] || meta["change_site"] || meta["suspected_real_location"] || row["file_path"])) return "no_edit_site";
  if (meta["operator_hold"] === true || isParkingDisposition(meta["disposition"]) || meta["disposition"] === CHECK_SUPPLY_DISPOSITION || isAwaitingLandVerification(row)) return "held";
  return null;
}

/** The metadata that releases a pending_verification hold ("" because the gap store carries omitted keys
 *  forward), or null when there is no such hold: parking dispositions are a human's to lift, and a null lets the
 *  sweep write once rather than every tick. */
export function liftLandVerificationHold(meta: Record<string, unknown>): Record<string, unknown> | null {
  return meta.disposition === "pending_verification" ? { ...meta, disposition: "" } : null;
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
  return false;
}
