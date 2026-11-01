// AN EDIT SITE THAT IS THE SUPPLY'S CHECK FILE IS SELF-CERTIFICATION BEFORE THE CHECK LANDS TOO. The send now records
// the check file as check_supply.intended_test_file (test_file only once the check is at origin/dev), so
// editSiteIsOwnCheck reads the name from either field.
//
// Expected: a row sited at its intended check file is edit_site_is_own_check (CONTROL against the send's new field);
// an older row's test_file still counts (CONTROL); a row sited at a src module does not (CONTROL).
import { describe, expect, it } from "bun:test";
import { editSiteIsOwnCheck } from "../../src/judge/gap-eligibility.js";

const CHECK = "test/checks/own-site.check.ts";
const row = (site: string, ledger: Record<string, unknown>) => ({ id: "g-own-site", classification_metadata: { edit_site: site, check_supply: { vessel: "fixture-vessel", ...ledger } } });

describe("editSiteIsOwnCheck reads the supply's check file by name", () => {
  it("CONTROL a site equal to intended_test_file (sent, not landed) is its own check", () => {
    expect(editSiteIsOwnCheck(row(`repos/fixture-vessel/${CHECK}`, { state: "goal_dispatched", intended_test_file: CHECK }))).toEqual({ site: `repos/fixture-vessel/${CHECK}`, check: CHECK });
  });
  it("CONTROL an older row's test_file still counts", () => {
    expect(editSiteIsOwnCheck(row(`repos/fixture-vessel/${CHECK}`, { state: "goal_dispatched", test_file: CHECK }))?.check).toBe(CHECK);
  });
  it("CONTROL a src site is not its own check", () => {
    expect(editSiteIsOwnCheck(row("repos/fixture-vessel/src/widget.ts", { state: "armed", test_file: CHECK, intended_test_file: CHECK }))).toBeNull();
  });
});
