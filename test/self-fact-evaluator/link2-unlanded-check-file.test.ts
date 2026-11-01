// LINK 2 READS A CHECK, NOT A NAME. gap-check-supply wrote check_supply.test_file when it SENT the test-writing goal,
// before any check file existed, and the autonomy judge's link 2 (judgeCheckHonest, through ownCheckFile) read that
// name as "the row has an own check". A send whose check never landed was then judged on its birth verdict or read
// "unjudged" (its source unreadable at the fix), never "no own check".
//
// Expected:
//   - a check_supply.test_file known never added at origin/dev in its vessel's clone is no own check: link 2 says so,
//     and the closure names no check (MUST-FAIL);
//   - the absence is read in the LEDGER's vessel (check_supply.vessel), through the judge's own cloneOf/firstCommit,
//     only for a ledger the arm step has not judged; an unreadable history, no clone, or an armed/arm-judged ledger
//     decides nothing (MUST-FAIL, CONTROL);
//   - a row whose check_supply.test_file IS present still reports it (CONTROL);
//   - a row with no check_supply.test_file whose evidence_resolve names a present file reports that check, whatever
//     the absence flag says (CONTROL).
import { describe, expect, it } from "bun:test";
import * as sfr from "../../src/resolvers/self-fact-reconcile.js";

const NOW = Date.parse("2034-03-01T00:00:00.000Z");
type Row = Record<string, unknown>;
const ABSENT = "test/checks/unlanded-name.check.ts";
const PRESENT = "test/checks/landed.check.ts";
const sentRow = (): Row => ({
  id: "fixture:sent-unlanded", status: "open", source: "substrate_detected",
  classification_metadata: { edit_site: "repos/fixture-vessel/src/fixture.ts", check_supply: { state: "goal_dispatched", vessel: "fixture-vessel", test_file: ABSENT, dispatch_id: "d-1" } },
});
// Shaped like a narrowed child the supply never wrote to: no check_supply.test_file, the check through evidence_resolve
// in ANOTHER vessel than the judge's own.
const evidenceOnlyRow = (): Row => ({
  id: "fixture:evidence-only", status: "open", source: "substrate_detected",
  classification_metadata: {
    edit_site: "repos/other-vessel/src/services/thing.ts", check_supply: { test_file: null },
    evidence_resolve: { shape: "test_suite", input: { vessel: "repos/other-vessel", test_file: "src/services/thing.test.ts", only_tests: ["thing > works"] }, zero_field: "requested_not_passing" },
    predicate_birth_verdict: "present",
  },
});
const commit = { sha: "e".repeat(40), author: "Substrate Autonomous", at: "2034-01-01T00:00:00.000Z", lane: true, files: [PRESENT] };

describe("link 2: a check_supply.test_file that never landed is no own check", () => {
  it("MUST-FAIL a sent-but-unlanded row reports NO own check", () => {
    const h = sfr.judgeCheckHonest(sentRow() as never, null, null, true);
    expect(h.value).toBe(false);
    expect(h.reason).toStartWith("no own check on the row");
  });

  it("MUST-FAIL the closure names no check for it", () => {
    const base = sfr.repairControlInputs(NOW, false);
    const row = sentRow();
    const j = sfr.judgeRepairClosure({ ...base, row: row as never, byId: new Map([[String(row["id"]), row as never]]), landing: { ...base.landing, gap_id: String(row["id"]) }, checkSupplyFileAbsent: true });
    expect(j.check).toBeNull();
    expect(j.check_honest.reason).toStartWith("no own check on the row");
  });

  it("MUST-FAIL absence is read in the ledger's vessel through cloneOf/firstCommit; unreadable decides nothing", () => {
    const asked: string[] = [];
    const deps = (first: (dir: string, p: string) => unknown) => ({
      cloneOf: (v: string) => { asked.push(v); return v === "fixture-vessel" ? "/clones/fixture-vessel" : null; },
      firstCommit: first as never,
    });
    expect(sfr.checkSupplyFileAbsentIn(sentRow() as never, "repos/edit-vessel/src/x.ts", deps(() => undefined))).toBe(true);
    expect(asked).toEqual(["fixture-vessel"]);
    expect(sfr.checkSupplyFileAbsentIn(sentRow() as never, "", deps(() => null))).toBe(false); // history unreadable
    expect(sfr.checkSupplyFileAbsentIn(sentRow() as never, "", deps(() => commit))).toBe(false); // added on origin/dev
    expect(sfr.checkSupplyFileAbsentIn(evidenceOnlyRow() as never, "repos/other-vessel/src/services/thing.ts", deps(() => undefined))).toBe(false); // no check_supply.test_file
    // an armed (or arm-judged) ledger's test_file was read at origin/dev by the arm step: this clone's history decides nothing
    for (const state of ["armed", "arm_refused", "green_at_head", "existence_only"]) {
      const r = sentRow(); ((r["classification_metadata"] as Row)["check_supply"] as Row)["state"] = state;
      expect(sfr.checkSupplyFileAbsentIn(r as never, "", deps(() => undefined))).toBe(false);
    }
  });

  it("CONTROL a row whose check file IS present still reports its check", () => {
    const base = sfr.repairControlInputs(NOW, false);
    expect(sfr.ownCheckFile(base.row, false)).toBe("test/fixture.check.ts");
    const j = sfr.judgeRepairClosure({ ...base, checkSupplyFileAbsent: false });
    expect(j.check).toBe("test/fixture.check.ts");
    expect(j.check_honest.value).toBe(true);
    expect(sfr.judgeRepairClosure(base).verdict).toBe("counted");
  });

  it("CONTROL a row with no check_supply.test_file reports its evidence_resolve check, flag or not", () => {
    for (const flag of [false, true]) {
      expect(sfr.ownCheckFile(evidenceOnlyRow() as never, flag)).toBe("src/services/thing.test.ts");
      expect(sfr.judgeCheckHonest(evidenceOnlyRow() as never, null, null, flag).reason).not.toStartWith("no own check");
    }
  });
});
