// A FAILED COMPOSE'S LESSON REASON IS THE DRAFT'S OWN FAILURE (gap compose-lesson-reason-is-the-suites-first-
// failing-line-so-a-parent-red-test-becomes-every-gaps-lesson).
//
// The reason was the first error lines of the WHOLE suite log, so in development-vessel every gap recorded
// test/long-running-in-flight.test.ts (another gap's falsifier, red on the parent by design) as its own lesson, and
// identical_repeated_failure then excluded the gap-drain root on that foreign line. The reason is now, in order: the
// gap's own check, the failures the gate found the draft introduced (net of the parent tree), then a generic reason;
// a line red on the parent is never it. The chain below is the compose's (feature-compose.ts, lessonReason).

import { describe, it, expect } from "bun:test";
import { composeAttemptEvidence, draftFailureReason, lessonDiag, type VerifyResult } from "../../src/resolvers/feature-compose.js";
import { identicalRepeatedFailure } from "../../src/judge/gap-eligibility.js";

const PARENT_RED = "in-flight counting: an llm_completion_dispatch call is in flight";
// The full verify log as runVerify captures it: the suite's FIRST failure is the parent-red falsifier.
const suiteLog = (extra = "") => `== install ==
== resolve ==
DRYRUN_EXIT=0
== typecheck ==
$ tsc --noEmit
TC_EXIT=0
== shape-dispatch ==
SD_EXIT=0
== tests ==
bun test v1.3.14 (0d9b296a)

test/long-running-in-flight.test.ts:
34 | describe("${PARENT_RED}", () => {
36 |     expect(typeof counts).toBe("function");
error: expect(received).toBe(expected)

Expected: "function"
Received: "undefined"
(fail) ${PARENT_RED} > countsTowardInFlight counts llm_completion_dispatch in both envelope spellings [0.20ms]
(fail) ${PARENT_RED} > src/index.ts counts in_flight with countsTowardInFlight, not with the drain predicate [0.05ms]
${extra}
 2654 pass
 21 fail
Ran 2695 tests across 301 files. [63.25s]`;

const OWN_FILE = "test/gap-drain-backoff.test.ts";
const OWN_TEST = "gap drain > a 200 non-attempt does not reset backoff";
const NEW_TEST = "(fail) gap-drain-observer > parks a held gap";

/** The compose's chain (apply detail aside), then what appendComposeLesson stores as `reason`. */
function storedReason(v: VerifyResult): string {
  const { ownReason } = composeAttemptEvidence([{ ok: true }], [], [v], false, null);
  const lessonReason = String(ownReason ?? draftFailureReason(v.ok ? undefined : v) ?? "semantic");
  return lessonDiag(lessonReason).slice(0, 200);
}
const failed = (over: Partial<VerifyResult>): VerifyResult => ({ vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, output: suiteLog(), ...over });
const draft = (over: Partial<NonNullable<VerifyResult["draft"]>>): NonNullable<VerifyResult["draft"]> => ({ own_red: [], introduced: [], new_ts: [], gate_detail: "", ...over });
const noParentRed = (r: string) => { expect(r).not.toContain("in-flight"); expect(r).not.toContain("countsTowardInFlight"); expect(r).not.toContain("typeof counts"); };

describe("lesson reason: the gap's own check first", () => {
  it("a draft that fails only its own check records that check, not the parent-red suite head", () => {
    // own check red, its run parsed no Expected/Received (a requested test that did not run): own.failing is empty.
    const detail = `THE GAP'S OWN CHECK IS STILL RED on this draft (its test file run alone): ${OWN_TEST} (not run). A draft that leaves its own check red does not land; finish every site the check names.`;
    const v = failed({ stage: "own_check", output: suiteLog() + " | " + detail, own: { test_file: OWN_FILE, failing: [] }, draft: draft({ own_red: [`${OWN_TEST} (not run)`], gate_detail: detail }) });
    const r = storedReason(v);
    expect(r).toContain(OWN_TEST);
    expect(r).toContain(OWN_FILE);
    noParentRed(r);
  });

  it("the own check outranks introduced failures when both are red (stage is tests)", () => {
    const v = failed({ stage: "tests", output: suiteLog(NEW_TEST), own: { test_file: OWN_FILE, failing: [{ name: OWN_TEST, expected: "Expected: 0", received: "Received: 1" }] }, draft: draft({ own_red: [OWN_TEST], introduced: [NEW_TEST] }) });
    const r = storedReason(v);
    expect(r).toContain(`(fail) ${OWN_TEST}`);
    expect(r).toContain("Expected: 0");
    expect(r).not.toContain("parks a held gap");
    noParentRed(r);
  });
});

describe("lesson reason: failures the draft introduced", () => {
  it("records the test the draft broke, not the suite's first (fail)", () => {
    const v = failed({ stage: "tests", output: suiteLog(NEW_TEST + " [1.00ms]"), draft: draft({ introduced: [NEW_TEST] }) });
    const r = storedReason(v);
    expect(r).toBe(NEW_TEST);
  });
});

describe("lesson reason: a parent-red line is never the reason", () => {
  const cases: Array<[string, VerifyResult]> = [
    ["pass count regressed", failed({ stage: "tests", draft: draft({ gate_detail: "PASSING TESTS DISAPPEARED: 2654 -> 2650 (a draft must not delete coverage or break module load to go green)" }) })],
    ["no summary", failed({ stage: "tests", draft: draft({ gate_detail: "TEST SUITE PRODUCED NO SUMMARY on two runs (baseline passed 2654; retry rc 124 = timed out or killed): this draft cannot be verified" }) })],
    ["contract breach", failed({ stage: "own_check", own: { test_file: OWN_FILE, failing: [] }, draft: draft({ gate_detail: "THE GAP'S CHECK CANNOT CERTIFY THIS DRAFT: the check is already green on the parent tree. Fix what the check measures; do not remove or weaken its assertions." }) })],
    ["stray test edit", failed({ stage: "own_check", draft: draft({ gate_detail: "EDITS A TEST FILE THIS GAP DOES NOT NAME: test/long-running-in-flight.test.ts. A draft must not change another test's assertions" }) })],
    ["only parent-red failures and no gate detail", failed({ stage: "tests", draft: draft({}) })],
    ["a result without the draft record", failed({ stage: "tests" })],
  ];
  for (const [name, v] of cases) {
    it(name, () => {
      const r = storedReason(v);
      expect(r.length).toBeGreaterThan(0);
      expect(r).not.toContain("typeof counts");
      expect(r).not.toContain("countsTowardInFlight counts");
      expect(r).not.toContain(`(fail) ${PARENT_RED}`);
    });
  }

  it("a gate sentence survives the stored diag filter whole", () => {
    const sentence = "THE GAP'S CHECK CANNOT CERTIFY THIS DRAFT: the check is already green on the parent tree.";
    expect(storedReason(failed({ stage: "own_check", draft: draft({ gate_detail: sentence }) }))).toBe(sentence);
  });

  it("typecheck: the draft's new tsc errors, not the parent's", () => {
    const out = "== typecheck ==\n$ tsc --noEmit\nsrc/old.ts(3,1): error TS2304: Cannot find name 'parentBroke'.\nsrc/services/gap-drain-observer.ts(9,2): error TS2304: Cannot find name 'nudge'.\nTC_EXIT=2\n== tests ==\nSKIPPED_TYPECHECK_FAILED";
    const r = storedReason(failed({ stage: "typecheck", exit_code: 2, output: out, draft: draft({ new_ts: ["src/services/gap-drain-observer.ts: error TS2304: Cannot find name 'nudge'."] }) }));
    expect(r).toContain("nudge");
    expect(r).not.toContain("parentBroke");
  });

  it("typecheck red only with parent errors says so instead of quoting them", () => {
    const out = "== typecheck ==\nsrc/old.ts(3,1): error TS2304: Cannot find name 'parentBroke'.\nTC_EXIT=2\n== tests ==\nSKIPPED_TYPECHECK_FAILED";
    const r = storedReason(failed({ stage: "typecheck", exit_code: 2, output: out, draft: draft({}) }));
    expect(r).not.toContain("parentBroke");
    expect(r).toContain("TC_EXIT=2");
  });

  it("a constraint refusal (no suite, no draft record) keeps its sentence", () => {
    const out = "== constraint == | CONSTRAINT UNMET: must_be_called(nudge) introduced in src/services/gap-drain-observer.ts has no live caller";
    expect(storedReason(failed({ stage: "constraint", output: out }))).toBe(out);
  });

  it("a passing verify yields no draft reason", () => {
    expect(draftFailureReason({ vessel: "v", errors: 0, exit_code: 0, ok: true, output: suiteLog() })).toBeUndefined();
    expect(draftFailureReason(undefined)).toBeUndefined();
  });
});

describe("identical_repeated_failure (one predicate, was three copies)", () => {
  const L = (reason: string) => ({ class: "verify_failed", reason });
  const own = "(fail) gap drain > a 200 non-attempt does not reset backoff\nExpected: 0\nReceived: 1";
  it("control: N genuinely identical own failures still exclude, labelled with the count", () => {
    expect(identicalRepeatedFailure([L(own), L(own), L(own)])).toBe("identical_repeated_failure(3)");
  });
  it("digits and hashes are masked before comparing", () => {
    expect(identicalRepeatedFailure([L("anchor not found at line 12 of deadbeef01"), L("anchor not found at line 40 of cafebabe99"), L("anchor not found at line 7 of 0123456789")])).toBe("identical_repeated_failure(3)");
  });
  it("an install-log reason breaks the first predicate but is dropped by the second (bare label)", () => {
    expect(identicalRepeatedFailure([L(own), L(own), L(own), L("== install ==\nINSTALL_EXIT=0 and a long dump")])).toBe("identical_repeated_failure");
  });
  it("three install-log reasons are not evidence", () => {
    const inst = L("== install ==\nINSTALL_EXIT=0 and a long dump");
    expect(identicalRepeatedFailure([inst, inst, inst])).toBeNull();
  });
  it("different reasons, too few reasons, or no array admit", () => {
    expect(identicalRepeatedFailure([L(own), L(own), L("(fail) another test entirely in this vessel")])).toBeNull();
    expect(identicalRepeatedFailure([L(own), L(own)])).toBeNull();
    expect(identicalRepeatedFailure(undefined)).toBeNull();
    expect(identicalRepeatedFailure("x")).toBeNull();
  });
});

describe("runVerify hands the lesson the gate's parent-net sets", () => {
  it("the draft record is built from confirmedNewTest, newTs and ownRed, never the raw failure set", async () => {
    const src = await Bun.file(new URL("../../src/resolvers/feature-compose.ts", import.meta.url)).text();
    const rec = src.match(/draft: \{ own_red: (\w+), introduced: (\w+), new_ts: (\w+), gate_detail: detail\b/);
    expect(rec?.slice(1)).toEqual(["ownRed", "confirmedNewTest", "newTs"]);
    expect(src).toMatch(/\?\? ownReason\s*\n\s*\?\? draftFailureReason\(failedVerify\)/);
  });
});
