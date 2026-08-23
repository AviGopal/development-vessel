// Per-resolver test for computeNewlyFailing — the set-difference at the heart of post-land
// test attribution and the future pre-cutover gate. Gating on this set (not a raw pass/fail
// COUNT) is what lets a cutover survive a suite flaky in the 81-94 band: a test that already
// failed at baseline is never held against a new commit. See gap
// cutover-suite-observes-but-does-not-gate.

import { describe, it, expect } from "bun:test";
import { computeNewlyFailing } from "../../src/resolvers/vessel-mitosis-cutover.js";

describe("computeNewlyFailing", () => {
  it("returns [] on first observation (no baseline) — nothing is attributable yet", () => {
    expect(computeNewlyFailing(null, ["a", "b"])).toEqual([]);
  });
  it("reports only failures absent from the baseline", () => {
    expect(computeNewlyFailing(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
  });
  it("ignores pre-existing failures — the flaky-baseline case", () => {
    // 186 failing at baseline, same 186 failing now → nothing new, cutover not blamed.
    const base = Array.from({ length: 186 }, (_, i) => `t${i}`);
    expect(computeNewlyFailing(base, base)).toEqual([]);
  });
  it("catches a genuine regression amid a large standing-red suite", () => {
    const base = Array.from({ length: 186 }, (_, i) => `t${i}`);
    const now = [...base, "regressed-by-this-commit"];
    expect(computeNewlyFailing(base, now)).toEqual(["regressed-by-this-commit"]);
  });
  it("de-duplicates and is order-stable", () => {
    expect(computeNewlyFailing(["x"], ["c", "c", "a", "a", "b"])).toEqual(["c", "a", "b"]);
  });
  it("returns [] when the suite went green", () => {
    expect(computeNewlyFailing(["a", "b"], [])).toEqual([]);
  });
});
