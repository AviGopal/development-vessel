// A CHECK THE SUPPLY REFUSED TO ARM DOES NOT ARM THE ROW.
//
// The check supply refused a landed check (check_supply.state arm_refused, class check_satisfied_by_gutting: deleting
// the behaviour turns it green) and the falsifier classifier then stamped falsifier class2 from an evidence_resolve on
// that SAME file. composeEligibilitySkipReason read only the falsifier class, so the row was armed for compose and the
// drafter grounded on the refused check. A row whose test_suite check is the file the supply refused is not armed; a
// different check file, a fresh arm, or no supply ledger still arms.
import { describe, it, expect } from "bun:test";
import { composeEligibilitySkipReason } from "../../src/judge/gap-eligibility.js";

const F = "test/checks/refused-check.check.ts";
const G = "test/checks/other-check.check.ts";
const SITE = "repos/development-vessel/src/resolvers/some-module.ts";

function row(checkSupply: Record<string, unknown> | undefined, testFile: string = F, falsifier: unknown = "class2"): Record<string, unknown> {
  return {
    id: "fixture-gap",
    status: "open",
    classification_metadata: {
      falsifier,
      edit_site: SITE,
      evidence_resolve: { shape: "test_suite", input: { vessel: "repos/development-vessel", test_file: testFile, only_tests: ["a title"] }, zero_field: "requested_not_passing" },
      ...(checkSupply ? { check_supply: checkSupply } : {}),
    },
  };
}
const refusedOn = (file: string): Record<string, unknown> => ({
  state: "arm_refused",
  test_file: file,
  vessel: "development-vessel",
  reason: "check_satisfied_by_gutting: a fix that removes the behaviour passes it",
});

describe("composeEligibilitySkipReason: a check-supply arm refusal on the row's own check", () => {
  it("[MUST-FAIL] class2 on file F with check_supply arm_refused on F is not armed", () => {
    expect(composeEligibilitySkipReason(row(refusedOn(F)))).toBe("unarmed");
  });

  it("[MUST-FAIL] the same with the falsifier as {class} and a repos/-prefixed ledger path", () => {
    expect(composeEligibilitySkipReason(row(refusedOn(`repos/development-vessel/${F}`), F, { class: "class2" }))).toBe("unarmed");
  });

  it("CONTROL: the same row with check_supply armed is armed", () => {
    expect(composeEligibilitySkipReason(row({ ...refusedOn(F), state: "armed" }))).toBeNull();
  });

  it("CONTROL: the same row with no check_supply ledger is armed", () => {
    expect(composeEligibilitySkipReason(row(undefined))).toBeNull();
  });

  it("CONTROL: arm_refused on F while evidence_resolve runs a different file G is armed", () => {
    expect(composeEligibilitySkipReason(row(refusedOn(F), G))).toBeNull();
  });

  it("CONTROL: arm_refused on F in another vessel is armed", () => {
    expect(composeEligibilitySkipReason(row({ ...refusedOn(F), vessel: "goal-host" }))).toBeNull();
  });

  it("CONTROL: a class1 row (no test_suite check) with an arm_refused ledger is armed", () => {
    const r = { id: "fixture-literal", status: "open", classification_metadata: { falsifier: "class1", edit_site: SITE, hardcoded_url: "http://fixture.invalid", check_supply: refusedOn(F) } };
    expect(composeEligibilitySkipReason(r)).toBeNull();
  });
});
