import { describe, expect, it } from "bun:test";
import { joinDecisionOutcome } from "../../src/resolvers/gap-to-feature";

/**
 * A LANDING THAT NOBODY RECORDS.
 *
 * `joinDecisionOutcome` walks the decision list backwards looking for an entry with no
 * `outcome` key and writes there. If every entry is already joined it used to fall out of
 * the loop having written NOTHING — silently.
 *
 * That is not a rare corner. `recordApproachDecision` pushes a fresh unjoined entry on every
 * PICK, so the ordinary compose path always has somewhere to write. The mitosis-cutover sweep
 * closes gaps in BULK with no pick, so it never has an unjoined entry and its `landed: true`
 * write was a no-op every single time.
 *
 * Measured on the live store 2026-09-04: of 32 store-confirmed-landed gaps that carried
 * `approach_decisions`, 25 (78%) had EVERY decision reading `landed: false`. The consumer at
 * gap-to-feature.ts ~3119 reads exactly that field to classify a gap as a
 * `high_confidence_miss` and route it to investigation instead of compose — so a gap that
 * failed once and then LANDED kept looking like a miss forever.
 */
describe("joinDecisionOutcome records the outcome in all cases", () => {
  it("fills the last unjoined entry, leaving joined entries untouched", () => {
    const meta: Record<string, unknown> = {
      approach_decisions: [
        { at: "2026-09-01T00:00:00.000Z", predicted_p: 0.9, outcome: { landed: false } },
        { at: "2026-09-02T00:00:00.000Z", predicted_p: 0.8 },
      ],
    };

    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "abc123" });

    const decs = meta.approach_decisions as Array<Record<string, unknown>>;
    expect(decs).toHaveLength(2);
    // the already-joined entry is preserved verbatim
    expect(decs[0]!.outcome).toEqual({ landed: false });
    const filled = decs[1]!.outcome as Record<string, unknown>;
    expect(filled.landed).toBe(true);
    expect(filled.commit).toBe("abc123");
    expect(typeof filled.joined_at).toBe("string");
  });

  it("APPENDS when every entry is already joined, instead of dropping the outcome", () => {
    // This is the sweep's shape: two prior failed attempts, both joined, then a bulk landing
    // with no intervening recordApproachDecision.
    const meta: Record<string, unknown> = {
      approach_decisions: [
        { at: "2026-09-01T00:00:00.000Z", predicted_p: 0.9, outcome: { landed: false } },
        { at: "2026-09-02T00:00:00.000Z", predicted_p: 0.8, outcome: { landed: false } },
      ],
    };

    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "deadbee" });

    const decs = meta.approach_decisions as Array<Record<string, unknown>>;
    expect(decs).toHaveLength(3);
    const appended = decs[2]!.outcome as Record<string, unknown>;
    expect(appended.landed).toBe(true);
    expect(appended.commit).toBe("deadbee");
    // the two failures are still on the record — appending must not erase history
    expect((decs[0]!.outcome as Record<string, unknown>).landed).toBe(false);
    expect((decs[1]!.outcome as Record<string, unknown>).landed).toBe(false);
  });

  it("the landing is visible to the high_confidence_miss consumer after appending", () => {
    // gap-to-feature.ts ~3119 reads ONLY the last entry:
    //   highConfMiss = last.predicted_p >= 0.7 && last.outcome.landed === false
    // Before the fix the last entry stayed a high-confidence failure forever.
    const meta: Record<string, unknown> = {
      approach_decisions: [{ at: "2026-09-01T00:00:00.000Z", predicted_p: 0.95, outcome: { landed: false } }],
    };
    const readMiss = (m: Record<string, unknown>): boolean => {
      const decs = m.approach_decisions as Array<Record<string, unknown>>;
      const last = decs[decs.length - 1];
      const out = last?.outcome as Record<string, unknown> | undefined;
      return !!(last && Number(last.predicted_p ?? 0) >= 0.7 && out && out.landed === false);
    };

    expect(readMiss(meta)).toBe(true); // before the landing: correctly a miss

    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "cafe01" });

    expect(readMiss(meta)).toBe(false); // after the landing: no longer a miss
  });

  it("honours the same 5-entry cap recordApproachDecision applies", () => {
    const meta: Record<string, unknown> = {
      approach_decisions: Array.from({ length: 5 }, (_, i) => ({
        at: `2026-09-0${i + 1}T00:00:00.000Z`,
        predicted_p: 0.5,
        outcome: { landed: false, seq: i },
      })),
    };

    joinDecisionOutcome(meta, { landed: true, commit: "capped1" });

    const decs = meta.approach_decisions as Array<Record<string, unknown>>;
    expect(decs).toHaveLength(5);
    // oldest dropped, newest carries the landing
    expect((decs[0]!.outcome as Record<string, unknown>).seq).toBe(1);
    expect((decs[4]!.outcome as Record<string, unknown>).landed).toBe(true);
  });

  /**
   * THE ABSENT-KEY CASE — the shape the mitosis-cutover sweep actually produces.
   *
   * Measured on the live store 2026-09-05: of 44 gaps closed with a landed reason, 12 had no
   * `approach_decisions` key at all — including `route-edit-1b6eee04`, which landed via
   * mitosis cutover at 04:44:24Z. The `!Array.isArray` guard returned before anything could
   * be written, so those landings left no per-decision evidence whatsoever.
   */
  it("initialises the list and records the outcome when the key is absent entirely", () => {
    const meta: Record<string, unknown> = {};

    joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "sweep01" });

    const decs = meta.approach_decisions as Array<Record<string, unknown>>;
    expect(Array.isArray(decs)).toBe(true);
    expect(decs).toHaveLength(1);
    const out = decs[0]!.outcome as Record<string, unknown>;
    expect(out.landed).toBe(true);
    expect(out.commit).toBe("sweep01");
    expect(decs[0]!.appended_by).toBe("joinDecisionOutcome");
  });

  it("records the outcome on an empty list rather than dropping it", () => {
    const meta: Record<string, unknown> = { approach_decisions: [] };

    joinDecisionOutcome(meta, { landed: true, commit: "empty01" });

    const decs = meta.approach_decisions as Array<Record<string, unknown>>;
    expect(decs).toHaveLength(1);
    expect((decs[0]!.outcome as Record<string, unknown>).commit).toBe("empty01");
  });

  it("still does not throw on a non-array approach_decisions", () => {
    const meta: Record<string, unknown> = { approach_decisions: "not-an-array" };
    expect(() => joinDecisionOutcome(meta, { landed: true })).not.toThrow();
  });
});
