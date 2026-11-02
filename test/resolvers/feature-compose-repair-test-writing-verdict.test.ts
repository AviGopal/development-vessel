// A REFUSED TEST-WRITING CHECK REACHES ITS REPAIR AS WHAT IT IS: ITS STAGE, CAUSE AND FAILING TESTS.
//
// A test-writing compose runs no own check (`[fc-own-check] {"test_file":null,"ran":false,…}`); its verdict is the
// test-writing check's (`[fc-test-writing-check] {"stage":"test_writing_check_wrong_reason","cause":"non_assertion",…}`).
// The verify filed that refusal as stage own_check, so the repair round was prompted `FAILING STAGE: own_check` with no
// failing test (`[fc-repair] prompt {"stage":"own_check",…,"own_failing":0,…}`): blind to what was refused, it answered with
// a file outside the test-writing write scope, was refused, wrote nothing, and the compose ended verify_failed. Expected:
//   - REPLAY of a recorded refusal (the gap-env-gated-write-allowlist shape, as the verify reported it): the prompt names
//     the test-writing stage, its cause, what a fix must achieve for it and the check's red tests, and says the repair
//     edits the check file only (its write scope; the edit site line stays the check); its journal line carries the test-writing stage, not own_failing 0
//     (the must-fail; red at the parent, which has no such field);
//   - with the deciding run's output (testWritingRedOf): each red test carries its failure text, bounded;
//   - CONTROL: a fix-mode own_check failure prompts byte for byte as before;
//   - CONTROL: the unjudged own check (the blind-repair path) prompts byte for byte as before;
//   - CONTROL: a PASSING test-writing check adds nothing to the prompt (and a passing verify never enters repair).
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fc from "../../src/resolvers/feature-compose.js";
import { checkRunVerdict, classifyCheckRun } from "../../src/resolvers/retry-evidence.js";

// Measured at the parent tree (the prompt before this change), unchanged after it.
const PIN_FIX = "87285c3afc5bb454787ba6aee5ebd10a05a5c7a618c35bf41d9f25aa1ffd7c24";
const PIN_UNJUDGED = "3b6747d12e1ce3cb057aa3cd6bb4dadbda763f536fb5b5f57271cc38c530a36b";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let spy: ReturnType<typeof spyOn> | null = null;
let lines: string[] = [];
afterEach(() => { spy?.mockRestore(); spy = null; });
function prompt(fv: Record<string, unknown>, editSite: string | null, writeScope: string[] | null = null): { p: string; line: Record<string, unknown> | null } {
  lines = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  const p = fc.repairPromptLogged(fv as never, "", editSite, "gap-under-test", writeScope);
  spy.mockRestore(); spy = null;
  const l = lines.find((x) => x.startsWith("[fc-repair] prompt "));
  return { p, line: l ? JSON.parse(l.slice("[fc-repair] prompt ".length)) : null };
}

const V = "repos/development-vessel";
const CHECK = "test/checks/gap-env-gated-write-allowlist.check.ts";
const SCOPE = [`${V}/${CHECK}`];
const RED = [
  "env-gated capability: WRITE_ALLOWLIST in fs-write.ts > WRITE_ALLOWLIST is unset; refusing all writes to enforce explicit allowlisting (defect reproduces)",
  "env-gated capability: WRITE_ALLOWLIST in fs-write.ts > control: write succeeds when WRITE_ALLOWLIST is set and path is allowed",
];
const REASON = "run 1/1: a test in the check fails by throwing, not by an expect() assertion";
const DETAIL = `THE TEST-WRITING CHECK ${CHECK} IS REFUSED (test_writing_check_wrong_reason: non_assertion): ${REASON}`;
// The verify result as the parent's runVerify returned it for the recorded refusal: stage own_check, no own block.
const RECORDED = {
  vessel: V, errors: "verify", exit_code: 0, ok: false, stage: "own_check",
  output: `== install ==\nINSTALL_EXIT=0\n== typecheck ==\nTC_EXIT=0\n== tests ==\n${"(pass) suite > ok\n".repeat(300)} 300 pass\n 0 fail\n | ${DETAIL}`,
  test_writing: { ok: false, stage: "test_writing_check_wrong_reason", cause: "non_assertion", reason: REASON, check_file: CHECK, edit_site: "src/resolvers/fs-write.ts", runs: [{ verdict: "wrong_reason", keys: [], red: RED, unhandled: false }] },
  draft: { own_red: [], introduced: [], new_ts: [], gate_detail: DETAIL },
};
// The deciding run as bun printed it: both tests fail by throwing.
const RAW = [
  `${CHECK}:`,
  "error: WRITE_ALLOWLIST is unset; refusing all writes",
  "      at writeGuard (/vessel/src/resolvers/fs-write.ts:41:11)",
  `(fail) ${RED[0]} [1.20ms]`,
  "error: ENOENT: no such file or directory, open '/vessel/tmp/allowed.txt'",
  "      at writeGuard (/vessel/src/resolvers/fs-write.ts:52:9)",
  `(fail) ${RED[1]} [0.80ms]`,
  "",
  " 0 pass",
  " 2 fail",
  "Ran 2 tests across 1 file. [12.00ms]",
].join("\n");

describe("the repair prompt of a refused test-writing check", () => {
  it("[MUST-FAIL] replay of a recorded refusal: the prompt names the stage, cause, aim and red tests; the line is not own_failing 0", () => {
    const { p, line } = prompt(RECORDED, null, SCOPE);
    expect(p).toContain(`TEST-WRITING CHECK REFUSED (${CHECK}): test_writing_check_wrong_reason, cause non_assertion.`);
    expect(p).toContain("WHAT THE FIX MUST ACHIEVE: the red must come from an expect() assertion on the defect");
    for (const n of RED) expect(p).toContain(`  - ${n}`);
    expect(p).toContain(`The repair edits the check file ${CHECK} only; the gap's source src/resolvers/fs-write.ts is read-only context.`);
    expect(p).toContain(`EDIT SITE (where this gap's fix belongs; fix the code there, do not edit another test to make it pass): ${SCOPE[0]}`);
    expect(line).not.toBeNull();
    expect(line!.own_failing).toBeUndefined();
    expect(line!.test_writing).toEqual({ stage: "test_writing_check_wrong_reason", cause: "non_assertion", red: 2 });
    expect(line!.edit_site).toBe(SCOPE[0]);
  });

  it("[MUST-FAIL] with the deciding run's output, each red test carries its failure text (bounded)", () => {
    expect(checkRunVerdict(classifyCheckRun(RAW)).cause).toBe("non_assertion"); // the fixture is the recorded class
    const red = (fc as Record<string, any>).testWritingRedOf(RAW) as Array<{ name: string; cause?: string; error: string | null }>;
    expect(red.map((r) => r.name)).toEqual(RED);
    const long = (fc as Record<string, any>).testWritingRedOf(RAW.replace("refusing all writes", "x".repeat(5000)));
    expect(long[0].error.length).toBeLessThanOrEqual((fc as Record<string, any>).TEST_WRITING_RED_ERROR);
    const { p } = prompt({ ...RECORDED, stage: "test_writing", test_writing_red: red }, null, SCOPE);
    expect(p).toContain("FAILING STAGE: test_writing");
    expect(p).toContain(`  - ${RED[0]} [non_assertion]: `);
    expect(p).toContain("WRITE_ALLOWLIST is unset; refusing all writes");
  });

  it("[CONTROL] a fix-mode own_check failure prompts byte for byte as before", () => {
    const fv = {
      vessel: V, errors: "verify", exit_code: 0, ok: false, stage: "own_check",
      output: `== tests ==\n${"(pass) suite > ok\n".repeat(300)} 300 pass\n 0 fail\n | THE GAP'S OWN CHECK IS STILL RED on this draft`,
      own: { test_file: "test/x.test.ts", failing: [{ name: "x > reads the budget", expected: "4", received: "3" }] },
      draft: { own_red: ["x > reads the budget"], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK IS STILL RED on this draft (its test file run alone): x > reads the budget" },
    };
    const { p, line } = prompt(fv, `${V}/src/x.ts`);
    expect(sha(p)).toBe(PIN_FIX);
    expect(line!.own_failing).toBe(1);
    expect(line!.test_writing).toBeUndefined();
  });

  it("[CONTROL] the unjudged own check (the blind-repair path) prompts byte for byte as before", () => {
    const fv = {
      vessel: V, errors: "verify", exit_code: 0, ok: false, stage: "own_check", output: "== tests ==\n 1 pass\n 0 fail\n",
      own: { test_file: "test/x.test.ts", failing: [], unjudged: true, output_tail: "Killed\n", exit_code: 137 },
      draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK PRODUCED NO RESULT on this draft" },
    };
    const { p, line } = prompt(fv, `${V}/src/x.ts`);
    expect(sha(p)).toBe(PIN_UNJUDGED);
    expect(line!.own_unjudged).toBe(true);
    expect(fc.unjudgedNoEditRoundContinues([fv as never], 0, 4)).toBe(true);
  });

  it("[CONTROL] a passing test-writing check adds nothing to the prompt", () => {
    const fv = {
      vessel: V, errors: "verify", exit_code: 0, ok: false, stage: "own_check",
      output: `== tests ==\n${"(pass) suite > ok\n".repeat(300)} 300 pass\n 0 fail\n | THE GAP'S OWN CHECK IS STILL RED on this draft`,
      own: { test_file: "test/x.test.ts", failing: [{ name: "x > reads the budget", expected: "4", received: "3" }] },
      draft: { own_red: ["x > reads the budget"], introduced: [], new_ts: [], gate_detail: "THE GAP'S OWN CHECK IS STILL RED on this draft (its test file run alone): x > reads the budget" },
    };
    const passing = { ok: true, stage: null, reason: "the check is the same assertion red on 3 runs", check_file: CHECK, edit_site: "src/resolvers/fs-write.ts", runs: [{ verdict: "assertion_red", keys: ["k"], red: ["t"], unhandled: false }] };
    expect(prompt({ ...fv, test_writing: passing }, `${V}/src/x.ts`).p).toBe(prompt(fv, `${V}/src/x.ts`).p);
  });
});
