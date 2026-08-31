import { describe, it, expect } from "bun:test";
import {
  gapBackoffMs,
  gapIsBackedOff,
  GAP_BACKOFF_BASE_MS,
  GAP_BACKOFF_MAX_MS,
} from "../../src/resolvers/gap-to-feature.js";

// Pins the per-gap brake that hopeless() structurally cannot apply.
//
// hopeless() is category-grain and requires `r.lands !== 0` to return false, so a
// category that has EVER landed can never seal — however many attempts one member
// accumulates. Measured 2026-08-31 across 425 open gaps: 678 failed attempts,
// median 0, p90 4, max 58. That max is `route-edit-e32a5778`, category
// `edit_intent_route`, which lands routinely and is therefore unsealable. It landed a
// commit at 19:44, was never recorded as landed, and was composing again at 19:53.
//
// The property under test is RATE, not eligibility: no gap is ever removed from
// selection, because a hard ceiling is irreversible without an operator and silently
// abandons real work, while a wrong backoff only costs time.

const meta = (m: Record<string, unknown>) => ({ id: "g", classification_metadata: m });
const NOW = Date.parse("2026-08-31T20:00:00.000Z");
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

describe("gapBackoffMs", () => {
  it("does not penalise a gap that has never failed, or failed once", () => {
    // One failure is almost no evidence that a gap is unfixable. Slowing it would tax
    // the common case to punish the rare one.
    expect(gapBackoffMs(0)).toBe(0);
    expect(gapBackoffMs(1)).toBe(0);
  });

  it("doubles per failure from the second onward", () => {
    expect(gapBackoffMs(2)).toBe(GAP_BACKOFF_BASE_MS * 2);
    expect(gapBackoffMs(3)).toBe(GAP_BACKOFF_BASE_MS * 4);
    expect(gapBackoffMs(4)).toBe(GAP_BACKOFF_BASE_MS * 8);
  });

  it("caps at 24h so a runaway decays to daily, never to never", () => {
    expect(gapBackoffMs(58)).toBe(GAP_BACKOFF_MAX_MS);
    expect(gapBackoffMs(1_000_000)).toBe(GAP_BACKOFF_MAX_MS);
    // The clamp is on the EXPONENT, not just the result: an unclamped 2**58 is finite
    // but absurd, and 2**1e6 is Infinity — Math.min(cap, Infinity) is the cap, but
    // Math.min(cap, NaN) is NaN, which would compare false everywhere and silently
    // disable the brake.
    expect(Number.isFinite(gapBackoffMs(1_000_000))).toBe(true);
  });

  it("never yields NaN or a negative wait from junk input", () => {
    // failed_attempts is read from a store this code does not own. A NaN wait compares
    // false against every elapsed time, turning the brake off without a trace; a
    // negative one would back off forever.
    for (const junk of [NaN, -5, Infinity, -Infinity]) {
      const w = gapBackoffMs(junk as number);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("gapIsBackedOff", () => {
  it("holds a repeatedly-failing gap until its wait elapses, then releases it", () => {
    const g = meta({ failed_attempts: 4, last_failed_at: agoMs(GAP_BACKOFF_BASE_MS * 8 - 1000) });
    expect(gapIsBackedOff(g, NOW)).toBe(true);
    const older = meta({ failed_attempts: 4, last_failed_at: agoMs(GAP_BACKOFF_BASE_MS * 8 + 1000) });
    expect(gapIsBackedOff(older, NOW)).toBe(false);
  });

  it("still releases the 58-attempt runaway after a day — a brake, not a seal", () => {
    const g = meta({ failed_attempts: 58, last_failed_at: agoMs(GAP_BACKOFF_MAX_MS + 60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(false);
  });

  it("FAILS OPEN with no metadata, no timestamp, or an unparseable one", () => {
    // Most gaps in the store carry no such metadata. Excluding on absence would empty
    // the candidate pool and stop gap work entirely — the failure mode that looks like
    // a calm, healthy system.
    expect(gapIsBackedOff({ id: "g" }, NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9 }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9, last_failed_at: "not-a-date" }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 9, last_failed_at: null }), NOW)).toBe(false);
  });

  it("FAILS OPEN on a future timestamp rather than waiting forever", () => {
    // Clock skew between the writer and this reader must not be able to park a gap
    // permanently.
    const g = meta({ failed_attempts: 9, last_failed_at: agoMs(-60 * 60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(false);
  });

  it("never holds a gap at failed_attempts <= 1, whatever the timestamp", () => {
    expect(gapIsBackedOff(meta({ failed_attempts: 1, last_failed_at: agoMs(0) }), NOW)).toBe(false);
    expect(gapIsBackedOff(meta({ failed_attempts: 0, last_failed_at: agoMs(0) }), NOW)).toBe(false);
  });

  it("reads the DURABLE metadata, so a vessel restart cannot reset the brake", () => {
    // The in-process gapComposeLastAttemptAt map is cleared on every restart, and
    // mitosis cutovers restart this vessel several times a day. A backoff built on it
    // would zero out exactly when a runaway gap is at its worst. Nothing in this
    // function reads process state — the same gap object gives the same answer in a
    // freshly-started process.
    const g = meta({ failed_attempts: 30, last_failed_at: agoMs(60_000) });
    expect(gapIsBackedOff(g, NOW)).toBe(true);
  });
});
