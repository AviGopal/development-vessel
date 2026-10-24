// A TEST-WRITING (CHECK-ONLY) LANDING LEAVES ITS GAP OPEN, CARRYING THE CHECK, WITH NO FIX CLOSE.
//
// A check-supply compose (compose_mode test_writing) lands one file, the gap's test/checks/<gap>.check.ts, red by
// design. The semantic gate now judges it by the test-writing contract (verifyPatchAddressesGap, skipped
// "test_writing", verified:true), so it is worth pinning that nothing downstream reads that landing as the gap's fix:
// the gap closes only when its own check (the falsifier) flips. The existing arming-only pins
// (test/judge-split/arming-only-landing.test.ts) drive an ALREADY-ARMED row; the test-writing landing itself lands
// on an UNARMED row, whose only link to the check is its check_supply ledger.
//
// Expected:
//   (1) the real pending-land stamp (vessel-mitosis-cutover.ts stampPendingLand) writes nothing for an unarmed gap
//       whose landing is only its supply check: no pending_outcome_verification, no close, no human ask;
//   (2) the row the check supply's arm step then leaves (evidence_resolve on that check, check_supply.state armed,
//       status as it was) is open, has no closed_reason, and is admitted for the fix compose (not held pending);
//   (3) the sweep backstop (gap-landing-verdict.ts armingLandingReleasedRow) on a row an arming-only landing stamped
//       keeps it open, keeps the check, clears the stamp, and writes no closed_reason;
//   CONTROL: a landing that also changes src is a fix landing and is stamped pending (the falsifier then decides).
// No network, no live store: the cutover's own-check deps seam is a fixture; nothing is written outside the temp root.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT } = await isolateRuntimeRoot("tw-landing-open", { superRepo: true, who: "test-writing-landing-leaves-gap-open.test.ts" });
const cut = (await import("../../src/resolvers/vessel-mitosis-cutover.js")) as Record<string, any>;
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
const lv = (await import("../../src/judge/gap-landing-verdict.js")) as Record<string, any>;
const { composeEligibilitySkipReason } = await import("../../src/judge/gap-eligibility.js");
const { pickSkipPending } = await import("../../src/judge/gap-admission.js");
const savedClone = process.env["MITOSIS_PUSH_CLONE_DIR"];
afterEach(() => { cut.__setOwnCheckDepsForTests?.(null); if (savedClone === undefined) delete process.env["MITOSIS_PUSH_CLONE_DIR"]; else process.env["MITOSIS_PUSH_CLONE_DIR"] = savedClone; });
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

type Row = Record<string, any>;
const VESSEL = "development-vessel";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const GAP = "observe-mode-dispatches-still-mint-templates";
const CHECK = csa.checkSupplyCheckPath(GAP) as string;
const SITE = `repos/${VESSEL}/src/index.ts`;
const LEDGER = { state: "goal_dispatched", dispatch_id: "dispatch-cs-1", vessel: VESSEL, test_file: CHECK, edit_site: SITE };
const EVIDENCE = { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: CHECK, only_tests: ["observe mode > does not mint a template"] }, zero_field: "requested_not_passing" };
/** The gap as a test-writing compose lands on it: open, unarmed (no evidence_resolve), its supply ledger dispatched. */
const unarmedRow = (): Row => ({
  id: GAP, status: "open", category: "systematic_failure", source: "substrate_detected", summary: `observe-mode dispatches still mint templates (${SITE})`,
  detected_at: "2026-10-01T00:00:00.000Z", classification_metadata: { edit_site: SITE, check_supply: { ...LEDGER } },
});
/** The row the arm step leaves (gap-check-supply.ts writeMeta keeps the row's status): the check as its falsifier. */
const armedRow = (extra: Row = {}): Row => {
  const r = unarmedRow();
  return { ...r, classification_metadata: { ...r.classification_metadata, evidence_resolve: EVIDENCE, falsifier: "class2", check_supply: { ...LEDGER, state: "armed", armed_at: "2026-10-01T01:00:00.000Z", red_at_head: true }, ...extra } };
};

async function stamp(row: Row, files: string[]): Promise<{ writes: Row[]; asks: Row[] }> {
  const writes: Row[] = [], asks: Row[] = [];
  delete process.env["MITOSIS_PUSH_CLONE_DIR"];
  cut.__setOwnCheckDepsForTests({
    readGap: async () => ({ shape: "substrateGap", body: { gaps: [row] } }),
    writeGap: async (p: Row) => { writes.push(p); return { shape: "substrateGapWriteResult", body: { id: row.id, action: "updated" } }; },
    ask: async (p: Row) => { asks.push(p); return { shape: "uiQuestion_write", body: { ok: true } }; },
  });
  await cut.stampPendingLand({ gapId: row.id, newSha: SHA, appliedAt: "2026-10-01T02:00:00.000Z", vessel_name: VESSEL, hostRepoRoot: join(ROOT, "no-such-repo"), gitCmd: "git", landedUnverifiedReason: null, stagedFiles: files });
  return { writes, asks };
}

describe("a test-writing (check-only) landing is not a fix", () => {
  it("(1) the pending-land stamp writes nothing for an unarmed gap whose landing is only its supply check", async () => {
    for (const files of [[CHECK], [`repos/${VESSEL}/${CHECK}`]]) {
      const { writes, asks } = await stamp(unarmedRow(), files);
      expect({ files, writes: writes.length, asks: asks.length }).toEqual({ files, writes: 0, asks: 0 });
    }
  });
  it("(2) the armed row it leaves is open, unclosed, carries the check, and is admitted for the fix compose", () => {
    const r = armedRow();
    expect(r.status).toBe("open");
    expect(r.classification_metadata.closed_reason).toBeUndefined();
    expect(r.classification_metadata.pending_outcome_verification).toBeUndefined();
    expect(r.classification_metadata.evidence_resolve.input.test_file).toBe(CHECK);
    expect(composeEligibilitySkipReason(r)).toBeNull();
    expect(pickSkipPending(r, [r], new Map())).toBe(false);
  });
  it("(3) the sweep backstop keeps a check-only-stamped row open with its check, clears the stamp, and closes nothing", () => {
    const stamped = armedRow({ pending_outcome_verification: SHA });
    expect(csa.armingOnlyLanding([CHECK], stamped, VESSEL)).toBe(true);
    const out = lv.armingLandingReleasedRow(stamped, SHA, "2026-10-01T03:00:00.000Z") as Row;
    expect(out.status).toBe("open");
    expect(out.classification_metadata.closed_reason).toBeUndefined();
    expect(out.classification_metadata.pending_outcome_verification).toBe("");
    expect(out.classification_metadata.pending_released.reason).toBe(lv.ARMING_ONLY_LANDING);
    expect(out.classification_metadata.evidence_resolve).toEqual(EVIDENCE);
  });
  it("CONTROL: a landing that also changes src is a fix landing and is stamped pending", async () => {
    const { writes } = await stamp(armedRow(), [CHECK, "src/index.ts"]);
    expect(writes.length).toBeGreaterThan(0);
    const g = writes.at(-1)!["gap"] as Row;
    expect(g.classification_metadata.pending_outcome_verification).toBe(SHA);
    expect(g.status).toBe("open");
  });
});
