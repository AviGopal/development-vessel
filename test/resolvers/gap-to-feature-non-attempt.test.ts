import { describe, it, expect } from "bun:test";
import { isNonAttemptComposeResult, requeueAfterNonAttempt, GAP_BUSY_REQUEUE_MS } from "../../src/resolvers/gap-to-feature.js";

// Pins the BUSY/capacity distinction at the gap layer.
//
// feature-compose returns verdict:"BUSY" / stage:"capacity" when the compose slot cap is
// hit, and its own comment calls the distinction load-bearing: "BUSY, not REFUSED.
// Capacity is TRANSIENT — the work is fine, the host is full." goal-host honours it
// (backs off 45s and retries). gap-to-feature did not — the string BUSY appeared nowhere
// in it — so a refusal became a plain ok:false and reached bumpFailedAttempts, which BOTH
// decays the gap score and calls updateCalibration(category, false). hopeless() then
// excludes the category at attempts>=8/lands==0, so a run of refusals could seal a whole
// category with no compose ever having run.
//
// Measured 2026-08-29: reach_grounding_gap went 0 -> 5 attempts / 0 lands in ~6h on
// refusals alone; five gaps sat at failed_attempts=2 with outcome.joined_at 200-800ms
// after the pick — far too fast for a compose.
describe("isNonAttemptComposeResult", () => {
  it("treats a BUSY verdict as a non-attempt", () => {
    expect(isNonAttemptComposeResult({ ok: false, verdict: "BUSY", stage: "capacity" })).toBe(true);
  });

  it("treats stage=capacity as a non-attempt even without the verdict", () => {
    // The two are set together today, but neither should be load-bearing alone.
    expect(isNonAttemptComposeResult({ ok: false, stage: "capacity" })).toBe(true);
  });

  it("keeps excluding environment failures, which were already exempt", () => {
    // This was the pre-existing carve-out at the main call site; folding it in here must
    // not change its behaviour.
    expect(isNonAttemptComposeResult({ ok: false, failure_kind: "environment" })).toBe(true);
  });

  it("does NOT exempt a genuine compose failure", () => {
    // The whole point: real failures must still bump, or a gap that cannot be fixed
    // would be retried forever and the calibration would never learn anything.
    expect(isNonAttemptComposeResult({ ok: false, verdict: "UNFAVORABLE" })).toBe(false);
    expect(isNonAttemptComposeResult({ ok: false, verdict: "REFUSED", stage: "scope" })).toBe(false);
    expect(isNonAttemptComposeResult({ ok: false, apply_failed: true })).toBe(false);
  });

  it("does NOT exempt a success", () => {
    expect(isNonAttemptComposeResult({ ok: true, verdict: "FAVORABLE" })).toBe(false);
  });

  it("is null-safe — a missing body is not an excuse to skip the bump", () => {
    // The slice path passes `lastBody`, which is null when the loop never ran. Treating
    // null as a non-attempt would silently stop bumping on an unrelated path.
    expect(isNonAttemptComposeResult(null)).toBe(false);
    expect(isNonAttemptComposeResult(undefined)).toBe(false);
    expect(isNonAttemptComposeResult({})).toBe(false);
  });

  it("distinguishes REFUSED from BUSY — the distinction the fix exists to preserve", () => {
    // REFUSED means "this should not be done" and MUST count against the gap.
    // BUSY means "the host is full" and must not.
    expect(isNonAttemptComposeResult({ verdict: "REFUSED" })).toBe(false);
    expect(isNonAttemptComposeResult({ verdict: "BUSY" })).toBe(true);
  });
});

// The SAME predicate, now governing SELECTION as well as credit.
//
// The exemption above kept a never-run compose out of failed_attempts and out of the
// category calibration, but the compose COOLDOWN was left burning: it is stamped at
// PICK-START, before feature_compose is called, and nothing cleared it on BUSY. So a
// capacity refusal cost the gap a full GAP_COMPOSE_COOLDOWN_MS of exclusion from the
// auto-pick candidate set for work the host had declined to start.
//
// Measured 2026-08-29 on the live substrate: one gap was picked at 19:26:31.9 / 19:31:46.5 /
// 19:36:52.6 / 19:41:56.7 / 19:47:01.5 — deltas 5:14.6, 5:06.1, 5:04.1, 5:04.8, cooldown-
// limited to the second rather than tick-limited — and every one of those picks logged
// verdict=BUSY stage=capacity. Zero composes ran in that window.
//
// REQUEUE, NOT RELEASE (2026-08-30). The first fix DELETED the stamp. That over-corrected:
// this map is the ONLY rotation pressure in the auto-picker, and with one autonomous slot
// BUSY is the MAJORITY outcome (45 of ~80 composes, 56%, over a measured 4h window), so
// releasing on the majority path disabled rotation entirely — the top-ranked gap took 73 of
// 83 picks (88%) in 40 minutes while 62 never-attempted substrate-detected findings queued.
// Both extremes starve the backlog: the full cooldown cools gaps that were never tried, and
// no cooldown lets one gap monopolise every tick. A non-attempt now costs a SHORT requeue.
describe("requeueAfterNonAttempt", () => {
  const COOLDOWN = 300_000;
  const NOW = 1_700_000_000_000;
  const stampsWith = (id: string) => new Map<string, number>([[id, NOW]]);
  // Remaining exclusion implied by a stamp, given the cooldown window.
  const remaining = (stamps: Map<string, number>, id: string) =>
    COOLDOWN - (NOW - (stamps.get(id) ?? 0));

  it("requeues a BUSY gap to the SHORT delay, not the full cooldown", () => {
    const stamps = stampsWith("g1");
    expect(requeueAfterNonAttempt(stamps, "g1", { verdict: "BUSY", stage: "capacity" },
      { nowMs: NOW, cooldownMs: COOLDOWN, requeueMs: 45_000 })).toBe(true);
    expect(remaining(stamps, "g1")).toBe(45_000);
  });

  it("does NOT release the gap outright — that is what caused the 88% monopoly", () => {
    // The regression guard. An entry must still be present and still exclude for a while,
    // or the top-ranked gap is re-admitted on the very next tick.
    const stamps = stampsWith("g1");
    requeueAfterNonAttempt(stamps, "g1", { verdict: "BUSY" }, { nowMs: NOW, cooldownMs: COOLDOWN });
    expect(stamps.has("g1")).toBe(true);
    expect(remaining(stamps, "g1")).toBeGreaterThan(0);
  });

  it("requeues an environment failure the same way", () => {
    const stamps = stampsWith("g1");
    expect(requeueAfterNonAttempt(stamps, "g1", { failure_kind: "environment" },
      { nowMs: NOW, cooldownMs: COOLDOWN, requeueMs: 45_000 })).toBe(true);
    expect(remaining(stamps, "g1")).toBe(45_000);
  });

  it("KEEPS the full cooldown after a genuine non-landing compose", () => {
    // A real attempt must still cool the gap, or the picker re-composes the same failing gap
    // every tick — the starvation GAP_COMPOSE_COOLDOWN_MS exists to stop.
    for (const cb of [
      { ok: false, verdict: "UNFAVORABLE" },
      { ok: false, verdict: "REFUSED", stage: "scope" },
      { ok: false, apply_failed: true },
      { ok: true, verdict: "FAVORABLE" },
    ]) {
      const stamps = stampsWith("g1");
      expect(requeueAfterNonAttempt(stamps, "g1", cb, { nowMs: NOW, cooldownMs: COOLDOWN })).toBe(false);
      expect(remaining(stamps, "g1")).toBe(COOLDOWN);
    }
  });

  it("never EXTENDS an exclusion when the requeue exceeds the cooldown", () => {
    // Clamped at 0: a misconfigured requeue must not make a non-attempt cost MORE than a
    // real failure — the failure mode of a wrong constant must be less penalty, never more.
    const stamps = stampsWith("g1");
    requeueAfterNonAttempt(stamps, "g1", { verdict: "BUSY" },
      { nowMs: NOW, cooldownMs: COOLDOWN, requeueMs: 999_000 });
    expect(remaining(stamps, "g1")).toBeLessThanOrEqual(COOLDOWN);
  });

  it("only touches the gap it was given, never a neighbour", () => {
    const stamps = new Map<string, number>([["g1", NOW], ["g2", NOW]]);
    requeueAfterNonAttempt(stamps, "g1", { verdict: "BUSY" }, { nowMs: NOW, cooldownMs: COOLDOWN });
    expect(remaining(stamps, "g1")).toBeLessThan(COOLDOWN);
    expect(remaining(stamps, "g2")).toBe(COOLDOWN);
  });

  it("is null-safe, id-safe, and does not invent a stamp that was never held", () => {
    const stamps = stampsWith("g1");
    expect(requeueAfterNonAttempt(stamps, "g1", null)).toBe(false);
    expect(requeueAfterNonAttempt(stamps, "", { verdict: "BUSY" })).toBe(false);
    expect(remaining(stamps, "g1")).toBe(COOLDOWN);
    // A gap with no cooldown held must report false rather than claim a requeue.
    expect(requeueAfterNonAttempt(new Map(), "g1", { verdict: "BUSY" })).toBe(false);
  });

  it("ships a requeue shorter than the cooldown and aligned to goal-host's BUSY backoff", () => {
    expect(GAP_BUSY_REQUEUE_MS).toBeGreaterThan(0);
    expect(GAP_BUSY_REQUEUE_MS).toBeLessThan(COOLDOWN);
  });
});
