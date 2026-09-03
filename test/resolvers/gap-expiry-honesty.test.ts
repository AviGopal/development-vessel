import { describe, it, expect } from "bun:test";
import { effectiveExpiryHours, preservedDetectedAt } from "../../src/resolvers/gap-lifecycle-scan.js";

// Pins two defects in the expiry write path, both measured on the live store 2026-09-02.
//
// (1) LATENCY WAS UNCOMPUTABLE. The expiry write set `detected_at: new Date()`, so every
//     one of the 703 expired gaps reported an age of ~0 and law 7's metric #2 (detection ->
//     close latency) could not be computed from the field that names it. I first read the
//     ~2ms deltas as "gaps are being killed at birth" — a writer artefact, not a fact. The
//     true ages survived only in classification_metadata.first_detected: median 168h,
//     min exactly 120.0h.
//
// (2) THE STATED TTL WAS FALSE. The record says "not re-detected within ${expireHours}h
//     TTL" — 336h by default. But the predicate that actually fires is `isDetectorStale`,
//     which uses detectorExpireHours (120h), is unconditional, and is OR'd FIRST:
//
//        isDetectorStale = t < detectorExpireBefore                               // 120h, all gaps
//        isExpireStale   = t < (source==='substrate_detected' ? detectorExpireBefore
//                                                            : expireBefore)      // 120h or 336h
//        return (isDetectorStale || isExpireStale || ...)
//
//     Any gap old enough for 336h is also old enough for 120h, so `expireHours` is
//     UNREACHABLE and 336 is dead code in the verdict — while being the number printed
//     onto the record. Measured min age at expiry: 120.0h, exactly the detector threshold.
//     A closure record that misstates its own rule is worse than a terse one: it teaches
//     the wrong TTL to anyone who reads it, including the substrate.

describe("effectiveExpiryHours — report the threshold that ACTUALLY fires", () => {
  const OPTS = { expireHours: 336, detectorExpireHours: 120 };

  it("is 120h for a substrate_detected gap (both branches use the detector threshold)", () => {
    expect(effectiveExpiryHours("substrate_detected", OPTS)).toBe(120);
  });

  it("is STILL 120h for any other source — isDetectorStale is unconditional and OR'd first", () => {
    // This is the case the old message got wrong: it printed 336.
    expect(effectiveExpiryHours("operator_detected", OPTS)).toBe(120);
    expect(effectiveExpiryHours(undefined, OPTS)).toBe(120);
  });

  it("tracks whichever threshold is earlier, so it stays honest if the config changes", () => {
    expect(effectiveExpiryHours("operator_detected", { expireHours: 48, detectorExpireHours: 120 })).toBe(48);
    expect(effectiveExpiryHours("substrate_detected", { expireHours: 48, detectorExpireHours: 120 })).toBe(120);
  });
});

describe("preservedDetectedAt — never destroy the original detection time", () => {
  it("keeps created_at so detection->close latency stays computable", () => {
    const g = { created_at: "2026-08-20T10:00:00.000Z", updated_at: "2026-08-28T10:00:00.000Z" };
    expect(preservedDetectedAt(g)).toBe("2026-08-20T10:00:00.000Z");
  });

  it("falls back to updated_at when created_at is absent", () => {
    expect(preservedDetectedAt({ updated_at: "2026-08-28T10:00:00.000Z" })).toBe("2026-08-28T10:00:00.000Z");
  });

  it("only stamps NOW when the row carries no timestamp at all", () => {
    const before = Date.now();
    const got = Date.parse(preservedDetectedAt({}));
    expect(got).toBeGreaterThanOrEqual(before - 1000);
  });

  it("ignores unparseable timestamps rather than propagating them", () => {
    const got = preservedDetectedAt({ created_at: "not-a-date" });
    expect(Number.isFinite(Date.parse(got))).toBe(true);
  });
});
