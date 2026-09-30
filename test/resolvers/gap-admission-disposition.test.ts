import { describe, expect, test } from "bun:test";
import { PARKING_DISPOSITIONS, isParkingDisposition } from "../../src/resolvers/gap-to-feature";

// Admission honours dispositions that park a gap for a human (2026-09-30: an unlocalized needs_information gap
// was picked; for a stale test its only green is changing src to match it). markPendingVerification keeps them.
describe("parking dispositions keep a gap out of autonomous work", () => {
  test("needs_information and awaiting_operator_review park a gap", () => {
    expect(isParkingDisposition("needs_information")).toBe(true);
    expect(isParkingDisposition("awaiting_operator_review")).toBe(true);
    expect(isParkingDisposition("needs_info")).toBe(true); // gap-lifecycle-scan's spelling
    expect([...PARKING_DISPOSITIONS].sort()).toEqual(["awaiting_operator_review", "needs_info", "needs_information"]);
  });
  test("working and cleared dispositions do not", () => {
    for (const d of ["pending_verification", "", "closed_measured", undefined, null, 1]) expect(isParkingDisposition(d)).toBe(false);
  });
});
