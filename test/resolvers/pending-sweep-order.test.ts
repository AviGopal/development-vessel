import { describe, expect, test } from "bun:test";
import { pendingCheckedStamp } from "../../src/resolvers/gap-to-feature";

// The pending sweep takes the LEAST recently checked gaps first. A new landing has never been examined, so
// marking it must not stamp it "just checked" (2026-09-30: verified landings waited 60+ min behind 103 gaps).
describe("a new landing sorts first in the pending sweep", () => {
  const now = "2026-09-30T13:40:00.000Z";
  test("a NEW sha leaves pending_last_checked_at empty", () => {
    expect(pendingCheckedStamp(undefined, "66e0c4b", now)).toBe("");
    expect(pendingCheckedStamp("aaaaaaa", "66e0c4b", now)).toBe("");
    // a FIRST pending mark with no commit sha (closeLandedGap passes undefined) is still never-examined (qa)
    expect(pendingCheckedStamp(undefined, undefined, now)).toBe("");
    expect(pendingCheckedStamp("", undefined, now)).toBe("");
  });
  test("a re-mark of the SAME sha, or an unspecified one, keeps the timestamp", () => {
    expect(pendingCheckedStamp("66e0c4b", "66e0c4b", now)).toBe(now);
    expect(pendingCheckedStamp("66e0c4b", undefined, now)).toBe(now);
  });
  test("empty sorts before any timestamp in the sweep's localeCompare ordering", () => {
    expect(["2026-09-30T12:00:00.000Z", ""].sort((a, b) => a.localeCompare(b))[0]).toBe("");
  });
});
