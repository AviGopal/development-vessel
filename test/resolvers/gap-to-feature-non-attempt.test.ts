import { describe, it, expect } from "bun:test";
import { isNonAttemptComposeResult, clearCooldownIfNonAttempt } from "../../src/resolvers/gap-to-feature.js";

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
describe("clearCooldownIfNonAttempt", () => {
  const stampsWith = (id: string) => new Map<string, number>([[id, 1_700_000_000_000]]);

  it("releases the cooldown when the compose never ran", () => {
    // THE FIX. Without this the gap waits out five minutes for a compose the host refused
    // to start, and the highest-priority gap is penalised for the host being busy.
    const stamps = stampsWith("g1");
    expect(clearCooldownIfNonAttempt(stamps, "g1", { ok: false, verdict: "BUSY", stage: "capacity" })).toBe(true);
    expect(stamps.has("g1")).toBe(false);
  });

  it("releases it for an environment failure too — the other non-attempt kind", () => {
    const stamps = stampsWith("g1");
    expect(clearCooldownIfNonAttempt(stamps, "g1", { ok: false, failure_kind: "environment" })).toBe(true);
    expect(stamps.has("g1")).toBe(false);
  });

  it("KEEPS the cooldown after a genuine non-landing compose", () => {
    // THE OTHER DIRECTION, and the one that matters for not regressing: a real attempt must
    // still cool the gap, or the picker re-composes the same failing gap every tick — the
    // exact 17x/60min starvation GAP_COMPOSE_COOLDOWN_MS was introduced to stop.
    for (const cb of [
      { ok: false, verdict: "UNFAVORABLE" },
      { ok: false, verdict: "REFUSED", stage: "scope" },
      { ok: false, apply_failed: true },
    ]) {
      const stamps = stampsWith("g1");
      expect(clearCooldownIfNonAttempt(stamps, "g1", cb)).toBe(false);
      expect(stamps.has("g1")).toBe(true);
    }
  });

  it("KEEPS the cooldown after a successful compose", () => {
    const stamps = stampsWith("g1");
    expect(clearCooldownIfNonAttempt(stamps, "g1", { ok: true, verdict: "FAVORABLE" })).toBe(false);
    expect(stamps.has("g1")).toBe(true);
  });

  it("only releases the gap it was given, never a neighbour", () => {
    // The delete key must match the key the pick stamped — String(gap.id). A mismatch here
    // would be invisible: the cooldown would simply never clear, which is today's bug.
    const stamps = new Map<string, number>([["g1", 1], ["g2", 2]]);
    clearCooldownIfNonAttempt(stamps, "g1", { verdict: "BUSY" });
    expect(stamps.has("g1")).toBe(false);
    expect(stamps.has("g2")).toBe(true);
  });

  it("is null-safe and id-safe", () => {
    // The slice path passes a possibly-null lastBody, and a gap with no id must not
    // delete some other entry by stringifying to "".
    const stamps = stampsWith("g1");
    expect(clearCooldownIfNonAttempt(stamps, "g1", null)).toBe(false);
    expect(clearCooldownIfNonAttempt(stamps, "", { verdict: "BUSY" })).toBe(false);
    expect(stamps.has("g1")).toBe(true);
  });

  it("reports false when there was no cooldown to release", () => {
    // The call site logs this as "cooldown released" vs "not held"; a bare true would make
    // the log claim a release that never happened.
    const stamps = new Map<string, number>();
    expect(clearCooldownIfNonAttempt(stamps, "g1", { verdict: "BUSY" })).toBe(false);
  });
});
