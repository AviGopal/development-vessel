import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveGapToFeature } from "./gap-to-feature";
import { ResolverResult } from "./types";

const GAP_COMPOSE_COOLDOWN_MS = 300_000; // 5 minutes

describe("resolveGapToFeature cooldown logic", () => {
  const gapId = "test-gap-id";
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear the map before each test to ensure isolation
    // @ts-ignore - access private map for testing
    resolveGapToFeature.gapComposeLastAttemptAt.clear();
    process.env = { ...originalEnv, GAP_COMPOSE_COOLDOWN_MS: String(GAP_COMPOSE_COOLDOWN_MS) };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("a non-attempt compose result should clear the cooldown for immediate re-eligibility", async () => {
    // Simulate a genuine attempt
    // @ts-ignore - access private map for testing
    resolveGapToFeature.gapComposeLastAttemptAt.set(gapId, Date.now() - 1000); // Set a recent attempt

    const nonAttemptResult: ResolverResult = {
      shape: "vesselCapability",
      body: { gap_id: gapId, isNonAttemptComposeResult: true, success: false },
    };

    // @ts-ignore - mock the callback result
    await resolveGapToFeature({ gap_id: gapId }, async () => nonAttemptResult);

    // Expect cooldown to be cleared, so the gap is immediately re-eligible
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.has(gapId)).toBe(false);
  });

  test("a genuine non-landing compose should sustain cooldown", async () => {
    const initialAttemptTime = Date.now();
    // Simulate a genuine attempt
    // @ts-ignore - access private map for testing
    resolveGapToFeature.gapComposeLastAttemptAt.set(gapId, initialAttemptTime);

    const genuineNonLandingResult: ResolverResult = {
      shape: "vesselCapability",
      body: { gap_id: gapId, isNonAttemptComposeResult: false, success: false },
    };

    // @ts-ignore - mock the callback result
    await resolveGapToFeature({ gap_id: gapId }, async () => genuineNonLandingResult);

    // Expect cooldown to be sustained (entry still exists and is not too old)
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.has(gapId)).toBe(true);
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.get(gapId)).toBeGreaterThanOrEqual(initialAttemptTime);

    // Simulate time passing, but not past cooldown
    const futureTime = initialAttemptTime + GAP_COMPOSE_COOLDOWN_MS / 2; // Half the cooldown
    // @ts-ignore - Force internal clock for testing if resolveGapToFeature used Date.now() internally
    // For this test, we are checking the map state directly which is sufficient.

    const reEligibleResult: ResolverResult = {
      shape: "vesselCapability",
      body: { gap_id: gapId, isNonAttemptComposeResult: false, success: true }, // A successful landing after cooldown
    };

    // If enough time hasn't passed, it should still be considered in cooldown if we tried to get it
    // The actual resolveGapToFeature doesn't actively 'check' for cooldown to remove it, it just sets it.
    // The important part is that a non-attempt clears it, and a real attempt keeps it.
  });

  test("a successful compose should sustain cooldown", async () => {
    const initialAttemptTime = Date.now();
    // Simulate a genuine attempt
    // @ts-ignore - access private map for testing
    resolveGapToFeature.gapComposeLastAttemptAt.set(gapId, initialAttemptTime);

    const successfulResult: ResolverResult = {
      shape: "vesselCapability",
      body: { gap_id: gapId, isNonAttemptComposeResult: false, success: true },
    };

    // @ts-ignore - mock the callback result
    await resolveGapToFeature({ gap_id: gapId }, async () => successfulResult);

    // Expect cooldown to be sustained
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.has(gapId)).toBe(true);
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.get(gapId)).toBeGreaterThanOrEqual(initialAttemptTime);
  });

  test("gap without gap_id should not affect cooldown map", async () => {
    const initialSize = 0;
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.size).toBe(initialSize);

    const result: ResolverResult = {
      shape: "vesselCapability",
      body: { isNonAttemptComposeResult: true, success: false }, // No gap_id
    };

    // @ts-ignore - mock the callback result
    await resolveGapToFeature({ gap_id: undefined }, async () => result);

    // Expect map size to remain unchanged
    // @ts-ignore - access private map for testing
    expect(resolveGapToFeature.gapComposeLastAttemptAt.size).toBe(initialSize);
  });
});
