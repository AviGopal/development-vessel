// Cooldown behaviour is tested through requeueAfterNonAttempt, which gap-to-feature.ts
// exports with the comment "Exported for unit test only" and which takes a fully
// injectable signature: the stamps map, the gap id, the compose callback body, and an
// options object carrying nowMs, cooldownMs and requeueMs. Testing it directly keeps the
// suite deterministic and avoids reaching into resolver-private state.
//
// An earlier version of this file read resolveGapToFeature.gapComposeLastAttemptAt, a
// property the implementation never defines, and passed a second injected callback to a
// single-parameter function. It failed all four of its tests from the day it was written.
// Do not reintroduce that approach: if new behaviour needs a seam, export one.
import { describe, expect, test } from "bun:test";
import { requeueAfterNonAttempt, isNonAttemptComposeResult } from "./gap-to-feature";

describe("requeueAfterNonAttempt", () => {
  const gapId = "test-gap-id";
  const opts = { nowMs: 1_000_000, cooldownMs: 300_000, requeueMs: 60_000 };
  const backdated = opts.nowMs - (opts.cooldownMs - opts.requeueMs);

  test("a BUSY result backdates the stamp so only the requeue window remains", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    expect(requeueAfterNonAttempt(stamps, gapId, { verdict: "BUSY" }, opts)).toBe(true);
    expect(stamps.get(gapId)).toBe(backdated);
  });

  test("an environment failure backdates identically", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    expect(requeueAfterNonAttempt(stamps, gapId, { failure_kind: "environment" }, opts)).toBe(true);
    expect(stamps.get(gapId)).toBe(backdated);
  });

  test("a capacity stage backdates identically", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    expect(requeueAfterNonAttempt(stamps, gapId, { stage: "capacity" }, opts)).toBe(true);
    expect(stamps.get(gapId)).toBe(backdated);
  });

  test("a genuine non-landing compose sustains the cooldown", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    expect(requeueAfterNonAttempt(stamps, gapId, { verdict: "UNFAVORABLE" }, opts)).toBe(false);
    expect(stamps.get(gapId)).toBe(999_000);
  });

  test("a missing callback body sustains the cooldown", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    expect(requeueAfterNonAttempt(stamps, gapId, null, opts)).toBe(false);
    expect(stamps.get(gapId)).toBe(999_000);
  });

  test("an unknown gap id is not stamped", () => {
    const stamps = new Map<string, number>();
    expect(requeueAfterNonAttempt(stamps, gapId, { verdict: "BUSY" }, opts)).toBe(false);
    expect(stamps.has(gapId)).toBe(false);
  });

  test("an empty gap id is refused", () => {
    const stamps = new Map<string, number>([["", 999_000]]);
    expect(requeueAfterNonAttempt(stamps, "", { verdict: "BUSY" }, opts)).toBe(false);
  });

  test("a requeue at least as long as the cooldown never extends the exclusion", () => {
    const stamps = new Map<string, number>([[gapId, 999_000]]);
    requeueAfterNonAttempt(stamps, gapId, { stage: "capacity" }, { nowMs: 1_000_000, cooldownMs: 60_000, requeueMs: 300_000 });
    expect(stamps.get(gapId)).toBe(1_000_000);
  });

  test("the non-attempt predicate covers environment, BUSY and capacity", () => {
    expect(isNonAttemptComposeResult({ failure_kind: "environment" })).toBe(true);
    expect(isNonAttemptComposeResult({ verdict: "BUSY" })).toBe(true);
    expect(isNonAttemptComposeResult({ stage: "capacity" })).toBe(true);
    expect(isNonAttemptComposeResult({ verdict: "UNFAVORABLE" })).toBe(false);
    expect(isNonAttemptComposeResult(null)).toBe(false);
  });
});