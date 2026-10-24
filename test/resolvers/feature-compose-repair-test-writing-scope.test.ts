// IN TEST-WRITING MODE THE fc-repair LOOP STAYS IN THE COMPOSE'S WRITE SCOPE (gap in-test-writing-mode-the-fc-repair-
// loop-edits-src-outside-the-composes-write-scope-…).
//
// Measured (a check-supply compose on a live node): the compose's write scope was only the gap's check
// (test/checks/observe-mode-dispatches-still-mint-templates.check.ts), with src/index.ts shown read-only. Its repair
// round was prompted with the gap's src edit site (gapEditSiteOf) as "where this gap's fix belongs", answered with a
// replace_lines on src/index.ts, and repairTargetPath admitted it (it checked only the plan-path rule): the round
// wrote src, and the landing floor (testWritingDiffOutsideTests) then refused the whole compose for it.
//
// Expected:
//   - MUST-FAIL (replay): with that compose's write scope (testWritingWriteScope, the real helper), a repair target
//     src/index.ts is refused; the check file itself is admitted;
//   - MUST-FAIL: the repair prompt names the check file as its edit site, not src;
//   - MUST-FAIL (wiring): the repair loop passes testWritingScope's targets to both the prompt and the target check;
//   - CONTROL: a fix-mode repair (no write scope) on src is admitted, and its prompt is byte-identical to today's.
// No LLM, no network, no tool calls, no writes outside this file's temp root.
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT } = await isolateRuntimeRoot("fc-repair-tw-scope", { superRepo: true, who: "feature-compose-repair-test-writing-scope.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

const VESSEL = "development-vessel";
const GAP = "observe-mode-dispatches-still-mint-templates";
const SITE = `repos/${VESSEL}/src/index.ts`;
const CHECK = `repos/${VESSEL}/${csa.checkSupplyCheckPath(GAP)}`;
const LEDGER = { state: "goal_dispatched", dispatch_id: "dispatch-cs-1", vessel: VESSEL, test_file: csa.checkSupplyCheckPath(GAP), edit_site: SITE };
const SCOPE = csa.testWritingWriteScope(csa.CHECK_SUPPLY_COMPOSE_MODE, GAP, { edit_site: SITE, check_supply: LEDGER }, [SITE, CHECK]) as { targets: string[]; readonly: string[] };
const FV = {
  vessel: `repos/${VESSEL}`, errors: "verify", exit_code: 0, ok: false, stage: "test_writing",
  output: "== typecheck ==\nTC_EXIT=0\n== tests ==\n(pass) fixture > ok\n",
  draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "TEST-WRITING CHECK IS REFUSED: test_writing_check_not_red" },
};

describe("fc-repair in test_writing mode: the repair target and its prompt stay in the write scope", () => {
  it("the fixture is that compose's scope: only the check is writable, src/index.ts read-only", () => {
    expect(SCOPE).toEqual({ targets: [CHECK], readonly: [SITE] });
  });
  it("MUST-FAIL (replay): a replace_lines repair on src/index.ts is refused as outside the write scope", () => {
    expect(fc.repairTargetPath("src/index.ts", `repos/${VESSEL}`, SCOPE.targets)).toBeNull();
    expect(fc.repairTargetPath(SITE, `repos/${VESSEL}`, SCOPE.targets)).toBeNull();
    // The check file itself is the one admitted target, vessel-relative or as a repos path.
    expect(fc.repairTargetPath(csa.checkSupplyCheckPath(GAP), `repos/${VESSEL}`, SCOPE.targets)).toBe(CHECK);
    expect(fc.repairTargetPath(CHECK, `repos/${VESSEL}`, SCOPE.targets)).toBe(CHECK);
    // An empty scope (no check path could be derived) refuses every target.
    expect(fc.repairTargetPath(CHECK, `repos/${VESSEL}`, [])).toBeNull();
  });
  it("MUST-FAIL: the repair prompt's edit site is the check file, not src", () => {
    const p = fc.repairPromptLogged(FV, "", SITE, GAP, SCOPE.targets) as string;
    expect(p).toContain(`EDIT SITE (where this gap's fix belongs; fix the code there, do not edit another test to make it pass): ${CHECK}`);
    expect(p).not.toContain(`: ${SITE}`);
  });
  it("MUST-FAIL (wiring): the repair loop hands testWritingScope's targets to the prompt and to the target check", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    expect(src.includes("repairPromptLogged(fv, errorSiteWindow, gapEditSiteOf(pointer), pointer.gap?.id ?? null, testWritingScope?.targets ?? null),"), "the prompt call passes the write scope").toBe(true);
    expect(src.includes("const efNorm = repairTargetPath(ef, fv.vessel, testWritingScope?.targets ?? null) ?? \"\";"), "the target check passes the write scope").toBe(true);
  });
  it("CONTROL: a fix-mode repair on src is admitted, and its prompt is today's", () => {
    expect(fc.repairTargetPath("src/index.ts", `repos/${VESSEL}`)).toBe(SITE);
    expect(fc.repairTargetPath("src/index.ts", `repos/${VESSEL}`, null)).toBe(SITE);
    const today = fc.buildRepairPrompt(FV, "", SITE) as string;
    expect(fc.repairPromptLogged(FV, "", SITE, GAP)).toBe(today);
    expect(fc.repairPromptLogged(FV, "", SITE, GAP, null)).toBe(today);
    expect(today).toContain(`do not edit another test to make it pass): ${SITE}`);
  });
});
