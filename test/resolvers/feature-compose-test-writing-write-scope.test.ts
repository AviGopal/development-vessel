// A TEST-WRITING COMPOSE IS PLANNED AGAINST THE SCOPE IT IS JUDGED BY (gap a-test-writing-compose-is-planned-against-
// its-gaps-src-edit-site-and-then-refused-for-writing-outside-its-check-file; REALIGNMENT §2.2, law 8).
//
// Measured 2026-10-23 15:00-17:45Z: 6 of 23 check-supply outcomes over two nodes were "check_supply compose refused at
// test_writing_diff_outside_tests": the refused plans edited the gaps' src edit sites. Mechanism: composeTargetFiles
// puts the gap's edit_site FIRST whatever the compose mode, and that list drives the grounding (a numbered target
// window) and the file-scope gate; only AFTER planning does testWritingDiffOutsideTests refuse every path but
// test/checks/<gap>.check.ts. The drafter was shown the src file as its target and refused for following it.
//
// Expected:
//   - MUST-FAIL (pure seam): check-supply-admission.ts testWritingWriteScope, in test_writing mode, returns the gap's
//     check file as the ONLY write target (by the refusal's own predicate, testWritingPathAllowed) and the src edit
//     site as read-only context; the check path comes from the target list (the supply's goal names it), else the
//     ledger's vessel, else the edit site's.
//   - MUST-FAIL (behaviour, the real resolveFeatureCompose over the drafter-split harness): a supply-admitted
//     test_writing compose of a gap whose edit_site is src/compute.ts shows compute.ts to the planner READ-ONLY (no
//     numbered target window), states the one-file write scope, and reports the check file as its only target.
//   - CONTROL: an ordinary (fix) compose keeps the edit_site first and numbered as a target; the helper returns null
//     outside test_writing mode.
// The plan-time refusal (testWritingDiffOutsideTests) is unchanged and stays the floor (test-writing-diff-scope.test.ts).
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-test-writing-write-scope", { superRepo: true, who: "test/resolvers/feature-compose-test-writing-write-scope.test.ts" });
const H_MOD = await import("../drafter-split/harness.js");
const { createHarness, VESSEL } = H_MOD;
const H = createHarness(ROOT, RUNTIME);
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
csa.__setCheckSupplyLedgerWaitForTests?.({ attempts: 1, delay_ms: 0, read_timeout_ms: 5_000 });
afterAll(() => { csa.__setCheckSupplyLedgerWaitForTests?.(null); H.restore(); });

type Row = Record<string, any>;
const SEAM_ABSENT = "red at the parent because the seam does not exist: the target list is composeTargetFiles' (edit_site first) in every mode";
const scopeOf = csa["testWritingWriteScope"] as undefined | ((mode: unknown, gapId: unknown, meta: Row, targets: string[]) => { targets: string[]; readonly: string[] } | null);

const SITE = `repos/${VESSEL}/src/compute.ts`;
const GAP = "tw-scope-gap";
const CHECK = `repos/${VESSEL}/${csa.checkSupplyCheckPath(GAP)}`;
const DISPATCH = "dispatch-tw-scope-1";
const SUMMARY = `compute in ${SITE} adds 1; it must add 2`;
// The supply's goal text names the check file, then the symptom (which names the src file).
const GOAL = `Write ONE failing test in ${CHECK} that reproduces: ${SUMMARY}. Its expect() assertion fails because of the defect, not because the file fails to load: Import the module the defect lives in as a namespace, import * as mod from "../../src/compute", and assert on it. No network, no services, no timers. Do not change src/ or any other file.`;
const LEDGER = { state: "goal_dispatched", dispatch_id: DISPATCH, vessel: VESSEL, test_file: csa.checkSupplyCheckPath(GAP), edit_site: SITE };

describe("testWritingWriteScope: the write targets are exactly the check file the refusal allows", () => {
  it("MUST-FAIL: test_writing mode, edit_site a src file: the check file is the only write target, the src file read-only", () => {
    expect(typeof scopeOf, SEAM_ABSENT).toBe("function");
    const s = scopeOf!("test_writing", GAP, { edit_site: SITE, check_supply: LEDGER }, [SITE, CHECK]);
    expect(s).toEqual({ targets: [CHECK], readonly: [SITE] });
    for (const t of s!.targets) expect(csa.testWritingDiffOutsideTests("test_writing", [t], GAP)).toEqual([]);
  });
  it("MUST-FAIL: the check path is derived from the ledger's vessel, else the edit site's, when the spec names none", () => {
    expect(typeof scopeOf, SEAM_ABSENT).toBe("function");
    expect(scopeOf!("test_writing", GAP, { edit_site: SITE, check_supply: LEDGER }, [SITE])).toEqual({ targets: [CHECK], readonly: [SITE] });
    expect(scopeOf!("test_writing", GAP, { edit_site: SITE }, [SITE])).toEqual({ targets: [CHECK], readonly: [SITE] });
    // Another gap's check is not this gap's write target: it stays read-only.
    const other = `repos/${VESSEL}/${csa.checkSupplyCheckPath("another-gap")}`;
    expect(scopeOf!("test_writing", GAP, { edit_site: SITE }, [SITE, other])).toEqual({ targets: [CHECK], readonly: [SITE, other] });
  });
  it("CONTROL: outside test_writing mode the target list is left alone (null)", () => {
    expect(typeof scopeOf, SEAM_ABSENT).toBe("function");
    expect(scopeOf!(undefined, GAP, { edit_site: SITE }, [SITE, CHECK])).toBeNull();
    expect(scopeOf!("fix", GAP, { edit_site: SITE }, [SITE])).toBeNull();
  });
});

// A numbered target window: groundingFileBlock prefixes each line of a TARGET file with its absolute line number.
const NUMBERED_SITE_LINE = /\n\d+\t {2}return base \+ 1;/;

let seq = 0;
async function compose(supply: boolean): Promise<{ prompt: string; body: Row; console: string }> {
  H.install();
  const fc = await import(`../../src/resolvers/feature-compose.ts?tw-write-scope=${++seq}`);
  const id = supply ? GAP : "tw-scope-fix-gap";
  const meta: Row = supply ? { edit_site: SITE, check_supply: LEDGER } : { edit_site: SITE };
  let body: Row = {};
  const rec = await H.run(fc, {
    name: supply ? "test_writing compose" : "fix compose",
    pointer: {
      spec: supply ? GOAL : `In ${SITE}, compute must add 2, not 1.`,
      // A fix compose that does not land skips admission (an unarmed fixture gap is not refused).
      verify_vessels: [`repos/${VESSEL}`], land: supply, skip_push: true, directed: false,
      gap: { id, summary: SUMMARY, classification_metadata: meta },
      ...(supply ? { check_supply: { gap_id: GAP, dispatch_id: DISPATCH }, authoring_execution_id: DISPATCH } : {}),
    },
    plan: "no_ops",
    store: [{ id, status: "open", category: "code_quality", summary: SUMMARY, classification_metadata: meta }],
    pool: { spendEnvelope: { uncapped: true } },
  }, (b) => { body = b; });
  return { prompt: rec.decompose_prompt, body, console: rec.console.join("\n") };
}

describe("resolveFeatureCompose: the test-writing drafter is shown its check file as the target, the src file read-only", () => {
  it("MUST-FAIL: a supply-admitted test_writing compose plans against the check file, not the src edit site", async () => {
    const { prompt, console: log } = await compose(true);
    expect(log, "the compose was admitted as test-writing work").toContain("compose_mode=test_writing");
    expect(prompt.length, `the planner was called (console: ${log.slice(-800)})`).toBeGreaterThan(0);
    expect(prompt).toContain(CHECK);
    expect(NUMBERED_SITE_LINE.test(prompt), "the src edit site is not given a numbered target window").toBe(false);
    expect(prompt).toContain(`----- ${SITE} (READ-ONLY`);
    expect(prompt).toContain(`writes exactly ONE file, the gap's check: ${CHECK}`);
    expect(log).toContain(`[fc-test-writing-scope] write target(s) [${CHECK}]; read-only context [${SITE}]`);
  }, 60_000);
  it("CONTROL: a fix compose keeps the edit_site first, as a numbered target window, and no write-scope block", async () => {
    const { prompt, console: log } = await compose(false);
    expect(prompt.length, `the planner was called (console: ${log.slice(-800)})`).toBeGreaterThan(0);
    expect(NUMBERED_SITE_LINE.test(prompt), "the edit site is a numbered target window").toBe(true);
    expect(prompt).not.toContain("TEST-WRITING COMPOSE, WRITE SCOPE");
    expect(log).not.toContain("[fc-test-writing-scope]");
  }, 60_000);
});
