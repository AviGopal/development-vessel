// verify_failure_reason IS THE DRAFT'S OWN FAILURE (gap verify-failure-reason-takes-the-logs-first-error-so-a-parent-
// error-is-fed-back-as-the-drafts).
//
// The writer took the first `file.ts(l,c): error TSnnnn` anywhere in the verify log, else a gate sentence from a list that
// omitted NEW test failures / PASSING TESTS DISAPPEARED, else the log's last 900 characters. A tsc error printed by a
// test red on the parent, or the suite tail, was then shown to the next drafter as "Verify failure from prior attempt"
// (priorAttemptFeedbackBlock). It is now written from the gate's DraftFailures record (verifyFailureReason).

import { describe, it, expect } from "bun:test";
import { verifyFailureReason, priorAttemptFeedbackBlock, draftFailureReason, lessonDiag, composeAttemptEvidence, type VerifyResult } from "../../src/resolvers/feature-compose.js";

const PARENT_TS = "src/legacy/old.ts(3,1): error TS2304: Cannot find name 'parentBroke'.";
const PARENT_FAIL = "(fail) typecheck fixtures > the legacy fixture compiles";
const OWN_FILE = "test/gap-drain-backoff.test.ts";
const OWN_TEST = "gap drain > a 200 non-attempt does not reset backoff";
// A parent-red test prints a tsc error into the suite log; the draft's typecheck is clean.
const LOG = `== install ==
== resolve ==
DRYRUN_EXIT=0
== typecheck ==
$ tsc --noEmit
TC_EXIT=0
== shape-dispatch ==
SD_EXIT=0
== tests ==
test/legacy-fixture.test.ts:
${PARENT_TS}
error: expect(received).toBe(expected)
${PARENT_FAIL} [12.00ms]
 2654 pass
 21 fail`;
const OWN_RED = `THE GAP'S OWN CHECK IS STILL RED on this draft (its test file run alone): ${OWN_TEST}. A draft that leaves its own check red does not land; finish every site the check names.`;
const ownOnly = (): VerifyResult => ({
  vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, stage: "own_check", output: `${LOG} | ${OWN_RED}`,
  own: { test_file: OWN_FILE, failing: [{ name: OWN_TEST, expected: "Expected: 0", received: "Received: 1" }] },
  draft: { own_red: [OWN_TEST], introduced: [], new_ts: [], gate_detail: OWN_RED },
});
const parentFree = (r: string) => { expect(r).not.toContain("parentBroke"); expect(r).not.toContain("legacy"); expect(r).not.toContain("2654 pass"); };

describe("verify_failure_reason", () => {
  it("a draft failing only its own check names the own check, not a parent tsc error in the log", () => {
    const r = verifyFailureReason(ownOnly());
    expect(r).toContain(OWN_TEST);
    expect(r.startsWith("THE GAP'S OWN CHECK IS STILL RED")).toBe(true);
    parentFree(r);
  });

  it("typecheck: only the draft's new errors, with their line:col", () => {
    const out = `== typecheck ==\n$ tsc --noEmit\n${PARENT_TS}\nsrc/services/gap-drain-observer.ts(9,2): error TS2304: Cannot find name 'nudge'.\nTC_EXIT=2\n== shape-dispatch ==\nSKIPPED_TYPECHECK_FAILED\n== tests ==\nSKIPPED_TYPECHECK_FAILED`;
    const v: VerifyResult = { vessel: "development-vessel", errors: "verify", exit_code: 2, ok: false, stage: "typecheck", output: out, draft: { own_red: [], introduced: [], new_ts: ["src/services/gap-drain-observer.ts: error TS2304: Cannot find name 'nudge'."], gate_detail: "" } };
    expect(verifyFailureReason(v)).toBe("src/services/gap-drain-observer.ts(9,2): error TS2304: Cannot find name 'nudge'.");
  });

  for (const sentence of [
    "NEW test failures introduced by this draft, REPRODUCED on a second run (1): (fail) gap-drain-observer > parks a held gap",
    "PASSING TESTS DISAPPEARED: 2654 -> 2650 (a draft must not delete coverage or break module load to go green)",
  ]) {
    it(`the gate sentence, never the suite tail: ${sentence.slice(0, 30)}`, () => {
      const v: VerifyResult = { vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, stage: "tests", output: `${LOG} | ${sentence}`, draft: { own_red: [], introduced: sentence.startsWith("NEW") ? ["(fail) gap-drain-observer > parks a held gap"] : [], new_ts: [], gate_detail: sentence } };
      const r = verifyFailureReason(v);
      expect(r).toBe(sentence);
      parentFree(r);
    });
  }

  it("a constraint refusal (no draft record, no suite) keeps its sentence", () => {
    const out = "== constraint == | CONSTRAINT UNMET: must_be_called(nudge) introduced in src/services/gap-drain-observer.ts has no live caller";
    expect(verifyFailureReason({ vessel: "v", errors: "constraint", exit_code: null, ok: false, stage: "constraint", output: out })).toBe(out);
  });

  it("a failed result without the draft record is not given the suite tail", () => {
    const r = verifyFailureReason({ vessel: "development-vessel", errors: "verify", exit_code: 0, ok: false, stage: "tests", output: LOG });
    expect(r.length).toBeGreaterThan(0);
    parentFree(r);
    expect(r).not.toContain("(fail)");
  });

  it("no failed verify writes nothing; the reason is capped at 900", () => {
    expect(verifyFailureReason(undefined)).toBe("");
    expect(verifyFailureReason({ vessel: "v", errors: 0, exit_code: 0, ok: true, output: LOG })).toBe("");
    const long = "THE GAP'S CHECK CANNOT CERTIFY THIS DRAFT: " + "x".repeat(2000);
    expect(verifyFailureReason({ ...ownOnly(), draft: { own_red: [], introduced: [], new_ts: [], gate_detail: long } }).length).toBe(900);
  });
});

describe("the next draft's prior-attempt block", () => {
  it("shows the draft's own failure, not the parent error", () => {
    const v = ownOnly();
    const { record, ownReason } = composeAttemptEvidence([{ ok: true }], [], [v], false, null);
    const diag = lessonDiag(String(ownReason ?? draftFailureReason(v)));
    const meta = { verify_failure_reason: verifyFailureReason(v), failure_lessons: [{ at: "2026-10-01T00:00:00Z", class: "verify_failed", reason: diag.slice(0, 200), raw_excerpt: diag.slice(0, 1500), ...record }] };
    const block = priorAttemptFeedbackBlock(meta);
    const vline = block.split("\n").find((l) => l.startsWith("- Verify failure from prior attempt:")) ?? "";
    expect(vline).toContain(OWN_TEST);
    expect(block).toContain("PRIOR ATTEMPT RECORD");
    parentFree(block);
  });
});

describe("wiring", () => {
  it("the compose writes verify_failure_reason from verifyFailureReason, with no log scrape left", async () => {
    const src = await Bun.file(new URL("../../src/resolvers/feature-compose.ts", import.meta.url)).text();
    expect(src).toMatch(/const firstTscError = verifyFailureReason\(verify\.find\(\(v\) => !v\.ok\)\);/);
    expect(src).not.toContain("raw.slice(-900)");
    expect(src).toMatch(/verify_failure_reason: firstTscError/);
  });
});
