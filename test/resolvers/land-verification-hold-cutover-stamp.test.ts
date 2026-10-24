// THE LAND-VERIFICATION HOLD HOLDS A CUTOVER-STAMPED LANDING, AND A RELEASE LETS IT GO (row the-land-verification-hold-
// predicate-keys-only-on-the-pending-verification-disposition-so-a-cutover-stamped-landing-is-never-held-and-can-be-re-
// landed; qa ruling (b), pending_released_sha). The cutover's stampPendingLand writes pending_outcome_verification=<sha>
// and NO disposition, so a hold keyed on the disposition never held it.
// THE CONTRACT is test/fixtures/land-verification-hold-fixtures.json, shared byte for byte with boredom-vessel's mirror.
// MUST-FAIL: the cutover-exact fixtures, the row the REAL stampPendingLand writes, and a re-landing with a NEW sha after a
//   release are held; a released stamp is not.
// CONTROL: a cleared or short stamp, regressed_by, a BEHAVIORAL VERIFICATION FAILED summary and a pre-marker release are
//   not held; the disposition form holds as before; a human hold is never lifted by the release.
import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { isAwaitingLandVerification, composeEligibilitySkipReason, liftLandVerificationHold } from "../../src/judge/gap-eligibility.js";
import { releasedRow } from "../../src/judge/gap-landing-verdict.js";
import * as cut from "../../src/resolvers/vessel-mitosis-cutover.js";

type Fx = { summary: string; classification_metadata: Record<string, unknown>; expected_held: boolean };
const FIX = JSON.parse(readFileSync(new URL("../fixtures/land-verification-hold-fixtures.json", import.meta.url).pathname, "utf8")) as Record<string, Fx | string>;
const cases = Object.entries(FIX).filter((e): e is [string, Fx] => typeof e[1] === "object");
const armed = { falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: "test/x.test.ts", only_tests: ["x"] } } };
const row = (f: Fx) => ({ id: "hold-fixture", category: "systematic_failure", source: "substrate_detected", status: "open", summary: f.summary, classification_metadata: { ...armed, ...f.classification_metadata } });
const SHA = "e".repeat(40);

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; (cut as any).__setOwnCheckDepsForTests?.(null); });

describe("the land-verification hold, against the shared fixture contract", () => {
  it("the contract file carries the cases the ruling names", () => {
    for (const k of ["cutover_stamp_verified_arm", "cutover_stamp_unverified_arm", "released_after_not_resolved", "relanded_new_sha_after_release", "cleared_stamp"]) expect(k in FIX).toBe(true);
  });
  for (const [name, f] of cases) {
    it(`${f.expected_held ? "MUST-FAIL" : "CONTROL"}: ${name} -> held=${f.expected_held}`, () => {
      expect(isAwaitingLandVerification(row(f))).toBe(f.expected_held);
      if (f.expected_held) expect(composeEligibilitySkipReason(row(f))).toBe("held");
    });
  }
  it("MUST-FAIL: the row the real stampPendingLand writes is held; releasing it lets it go; a new landing's sha holds it again", async () => {
    spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
    const writes: Array<Record<string, unknown>> = [];
    let stored: Record<string, unknown> = row({ summary: "fixture", classification_metadata: { edit_site: "repos/development-vessel/src/x.ts" }, expected_held: false });
    (cut as any).__setOwnCheckDepsForTests({
      readGap: async () => ({ shape: "substrateGap", body: { gaps: [stored] } }),
      writeGap: async (p: Record<string, unknown>) => { writes.push(p.gap as Record<string, unknown>); return { shape: "substrateGap_write", body: {} }; },
    });
    await cut.stampPendingLand({ gapId: "hold-fixture", newSha: SHA, appliedAt: "2026-10-23T23:00:00.000Z", vessel_name: "development-vessel", hostRepoRoot: "/nonexistent-clone", gitCmd: "git", landedUnverifiedReason: null });
    stored = writes[writes.length - 1]!;
    expect(isAwaitingLandVerification(stored)).toBe(true);
    const released = releasedRow(stored, "measured present")!;
    expect(released).not.toBeNull();
    const rm = released.classification_metadata as Record<string, unknown>;
    expect({ stamp: rm.pending_outcome_verification, released: rm.pending_released_sha, held: isAwaitingLandVerification(released) }).toEqual({ stamp: SHA, released: SHA, held: false });
    expect(releasedRow(released, "again")).toBeNull();
    stored = released;
    await cut.stampPendingLand({ gapId: "hold-fixture", newSha: "f".repeat(40), appliedAt: "2026-10-24T01:00:00.000Z", vessel_name: "development-vessel", hostRepoRoot: "/nonexistent-clone", gitCmd: "git", landedUnverifiedReason: null });
    expect(isAwaitingLandVerification(writes[writes.length - 1]!)).toBe(true);
  });
  it("CONTROL: a human or supply hold is never lifted by the release", () => {
    for (const d of ["awaiting_operator_review", "needs_information", "needs_info", "needs_localization"]) {
      expect(liftLandVerificationHold({ disposition: d, pending_outcome_verification: SHA })).toBeNull();
    }
  });
});
