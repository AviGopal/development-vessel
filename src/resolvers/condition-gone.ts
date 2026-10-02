/**
 * The condition-gone close verdict (slice Y, step Y3a): a gap whose failure SIGNATURE has
 * disappeared over a measured window may close with close_basis "condition_gone", and that
 * close is NEVER counted as a fix.
 *
 * Why: gaps outlive their failures. Every existing closer reads gap AGE
 * (gap-lifecycle-scan: expired_not_redetected, stale_low_value) or a LANDING (gap-to-feature:
 * landed_verified), so a failure that stopped is indistinguishable from one that did not. This
 * is the MEASUREMENT counterpart, as a pure verdict; the wiring (a pass in gap_lifecycle_scan) is
 * a separate step and this module writes nothing.
 *
 * Inputs are three windowed reads, each echoing the window it covered and the ADDRESS it was read
 * through (signature filter hash + org, see signalAddress):
 *   before  — the signature's count before the after-window;
 *   after   — the signature's count over the after-window;
 *   control — over the same after-window and address, the count of the POPULATION the signature
 *             is drawn from: failed rows that carry a class (a failure_class signature) or a
 *             failure_mode (a reason_contains signature). Raw traffic is not a control: rows
 *             flowing proves the address sees traffic, not that a failure carrying this signature
 *             could have been counted (class stamping that regressed, a dropped reason, or an
 *             org with traffic but no failures would all read as "gone").
 * A recorded baseline (the before count stamped while the before-window was still retained; the
 * trace store is capped) carries the address it was read through and stands in for an evicted
 * before-window only when that address equals this one.
 *
 * It refuses to close (fail closed) when:
 *   - the policy inputs are invalid (min_after_hours below 24, a non-integer min_before, no
 *     address, an unknown signature kind)                       → policy_invalid
 *   - any read is not measured (a failed query, a dead table, a non-number): a silent zero is
 *     not absence                                                → unmeasured
 *   - a read was taken through another address                 → address_mismatch
 *   - the after or control read did not cover exactly the caller's after-window
 *                                                                → window_mismatch
 *   - the control is not the signature's filtered population   → control_unfiltered
 *   - the control saw no such failures at all                  → control_saw_nothing
 *   - the after-window is shorter than the policy minimum      → after_window_too_short
 *   - the signature never matched before, and no same-address baseline >= min was recorded: the
 *     query may be mis-addressed, so its zero after says nothing → signature_never_matched
 *   - the signature is still present                           → still_present
 *
 * Only `landing:<sha>` counts as a fix, and only the landing sweep writes it: a landing sha
 * passed here does not change the verdict, and `counts_as_fix` is always false.
 */
import {
  measuredValue, readShapedPolicy, hoursSince, sameAddress, MAX_WINDOW_HOURS,
  type MeasuredCount, type PolicySpec, type ShapedPolicy, type SignalAddress,
} from "../lib/signal-window.js";

export interface ConditionGonePolicy {
  /** The after-window W the closer reads (hours). */
  window_hours: number;
  /** The shortest after-window that may close a gap (hours). */
  min_after_hours: number;
  /** Signature matches the before-window (or recorded baseline) must show, at least. */
  min_before: number;
}

/** `<live super-repo clone>/policies/conditionGonePolicy.json`. */
export const CONDITION_GONE_POLICY_NAME = "conditionGonePolicy";

/** No after-window shorter than a day may close a gap: daily cycles would read as "gone". */
export const MIN_AFTER_HOURS_FLOOR = 24;

export const DEFAULT_CONDITION_GONE_POLICY: Readonly<ConditionGonePolicy> = Object.freeze({
  window_hours: 72,
  min_after_hours: 72,
  min_before: 3,
});

export const CONDITION_GONE_POLICY_SPEC: PolicySpec<ConditionGonePolicy> = {
  window_hours: { kind: "int", min: MIN_AFTER_HOURS_FLOOR, max: MAX_WINDOW_HOURS },
  min_after_hours: { kind: "int", min: MIN_AFTER_HOURS_FLOOR, max: MAX_WINDOW_HOURS },
  min_before: { kind: "int", min: 1, max: 1_000_000 },
};

/** Reads conditionGonePolicy at use time. `ok: false` → the caller closes nothing. */
export function readConditionGonePolicy(env: Record<string, string | undefined> = process.env): Promise<ShapedPolicy<ConditionGonePolicy>> {
  return readShapedPolicy(CONDITION_GONE_POLICY_NAME, { ...DEFAULT_CONDITION_GONE_POLICY }, CONDITION_GONE_POLICY_SPEC, env);
}

/**
 * The before / after windows the closer reads, for a gap created at `createdAt`. The before-window
 * is NOT anchored at created_at (a signature can first appear days after the gap was filed): it
 * covers everything retained before the after-window. Null when created_at is unusable.
 */
export function conditionGoneWindows(createdAt: unknown, windowHours: number, now: number = Date.now()):
  { after: { window_hours: number }; before: { until_hours_ago: number; window_hours: number } } | null {
  const age = hoursSince(createdAt, now);
  if (age === null || !Number.isInteger(windowHours) || windowHours < 1 || windowHours > MAX_WINDOW_HOURS) return null;
  return {
    after: { window_hours: windowHours },
    before: { until_hours_ago: windowHours, window_hours: Math.min(MAX_WINDOW_HOURS, age + windowHours) },
  };
}

/** One windowed read: its count, the window it covered, and the address it was read through. */
export interface WindowRead extends MeasuredCount {
  window_hours?: number;
  address?: SignalAddress;
}

export type SignatureKind = "failure_class" | "reason_contains";
export type ControlPopulation = "failed_with_class" | "failed_with_failure_mode";

/** The population a signature of each kind is drawn from. */
export const CONTROL_POPULATION: Readonly<Record<SignatureKind, ControlPopulation>> = Object.freeze({
  failure_class: "failed_with_class",
  reason_contains: "failed_with_failure_mode",
});

export interface ConditionGoneInput {
  before: WindowRead;
  after: WindowRead;
  control?: WindowRead & { population?: string };
  /** The address every read must have been taken through. */
  address: SignalAddress;
  signature_kind: SignatureKind;
  min_before: number;
  min_after_hours: number;
  after_window_hours: number;
  /** The before count the gap recorded while its before-window was retained, with its address. */
  recorded_baseline?: { count: number; address: SignalAddress } | null;
  /** Accepted and ignored: a landing never turns a condition_gone close into a fix. */
  landing_sha?: string | null;
}

export type ConditionGoneReason =
  | "policy_invalid" | "unmeasured" | "address_mismatch" | "window_mismatch" | "control_unfiltered"
  | "control_saw_nothing" | "after_window_too_short" | "signature_never_matched" | "still_present"
  | "signature_absent";

export interface ConditionGoneVerdict {
  close: boolean;
  close_basis: "condition_gone" | null;
  closed_reason: "condition_gone" | null;
  /** Always false: only landing:<sha>, written by the landing sweep, counts as a fix. */
  counts_as_fix: false;
  reason: ConditionGoneReason;
  before_basis: "window" | "recorded_baseline" | null;
  /** The numbers the verdict was decided on, for the close record's falsifier_exercise. */
  before_count: number | null;
  after_count: number | null;
}

const intAtLeast = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Pure: whether the gap's signature is gone. See the header for every refusal. */
export function conditionGoneVerdict(i: ConditionGoneInput): ConditionGoneVerdict {
  const before = measuredValue(i?.before);
  const after = measuredValue(i?.after);
  const no = (reason: ConditionGoneReason): ConditionGoneVerdict => ({
    close: false, close_basis: null, closed_reason: null, counts_as_fix: false, reason, before_basis: null,
    before_count: before, after_count: after,
  });
  const kind = i?.signature_kind;
  if (
    !intAtLeast(i?.min_before, 1) || !intAtLeast(i?.min_after_hours, MIN_AFTER_HOURS_FLOOR) ||
    !intAtLeast(i?.after_window_hours, 1) || !sameAddress(i?.address, i?.address) ||
    (kind !== "failure_class" && kind !== "reason_contains")
  ) {
    return no("policy_invalid");
  }
  const control = measuredValue(i.control);
  if (before === null || after === null || control === null) return no("unmeasured");
  if (!sameAddress(i.before.address, i.address) || !sameAddress(i.after.address, i.address) || !sameAddress(i.control?.address, i.address)) {
    return no("address_mismatch");
  }
  if (i.after.window_hours !== i.after_window_hours || i.control?.window_hours !== i.after_window_hours) return no("window_mismatch");
  if (i.control?.population !== CONTROL_POPULATION[kind]) return no("control_unfiltered");
  if (control <= 0) return no("control_saw_nothing");
  if (i.after_window_hours < i.min_after_hours) return no("after_window_too_short");

  let basisCount = before;
  let basis: "window" | "recorded_baseline" = "window";
  const rb = i.recorded_baseline;
  const baseline = rb && typeof rb === "object" && typeof rb.count === "number" && Number.isFinite(rb.count) && sameAddress(rb.address, i.address) ? rb.count : null;
  if (basisCount < i.min_before && baseline !== null && baseline >= i.min_before) {
    basisCount = baseline;
    basis = "recorded_baseline";
  }
  if (basisCount < i.min_before) return no("signature_never_matched");
  if (after > 0) return no("still_present");
  return {
    close: true, close_basis: "condition_gone", closed_reason: "condition_gone", counts_as_fix: false,
    reason: "signature_absent", before_basis: basis, before_count: basisCount, after_count: after,
  };
}
