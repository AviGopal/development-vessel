// THE BASE RE-READ'S "ENVIRONMENT" LINE SPEAKS FOR THE PASS COUNT ONLY (agf_4ukvuyt3mad9).
//
// On 2026-10-26 both green own-check drafts were journalled "the pass drop was the environment, not this draft" and
// then went to repair at stage=tests. That was right: each broke a sibling test red on both draft runs and green on the
// fresh base (light-dispatch "[CONTROL] resolved:false WITHOUT the budget flag is a success"; concept-db two
// "[MUST-FAIL]"s of "the resolve route reads the shape from pointer.type only"). The line cleared only the pass-count
// drop, but read as a verdict that the draft was clean.
//
// What attributes a failure to the environment is deterministic and unchanged: a "new" failure that is ALSO red on the
// untouched base, run now in the same environment, is dropped (feature-compose.ts, the base re-read); one that is green
// there stays this draft's and refuses it.
//
//   [MUST-FAIL] with introduced failures remaining, the line names them and does not call the drop the environment.
//   [CONTROL]   with none remaining, the line says the pass-count drop alone does not refuse.
//   [MUST-FAIL] wiring: the base re-read uses this line; the base-red predicate and the tests verdict are as described.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-base-reread-pass-count-line", { who: "feature-compose-base-reread-pass-count-line.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

describe("the base re-read's pass-count line", () => {
  it("[MUST-FAIL] introduced failures remaining are named, and the drop is not called the environment", () => {
    const line: string = fc["passCountClearedLine"]?.("repos/light-dispatch-vessel", 61, 61, 52, 53, 53, 1);
    expect(line).toContain("draft executed 61 tests >= fresh base 61 (pass 52 vs 53, cached 53)");
    expect(line).toContain("1 failure(s) red on both draft runs and green on the fresh base remain this draft's");
    expect(line).not.toContain("the pass drop was the environment");
  });

  it("[CONTROL] with none remaining, only the pass-count drop is cleared", () => {
    const line: string = fc["passCountClearedLine"]("repos/goal-host-vessel", 3417, 3417, 3388, 3390, 3390, 0);
    expect(line).toContain("the pass-count drop alone does not refuse this draft");
    expect(line).not.toContain("remain this draft's");
  });

  it("[MUST-FAIL] wiring: the re-read journals this line; base-red failures drop, the rest refuse at stage tests", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(src).not.toContain("cached ${String(basePass)}) — the pass drop was the environment, not this draft`);");
    expect(src).toContain("console.log(passCountClearedLine(v, draftExecuted, baseExecutedNow, curPass, basePassNow, basePass, confirmedNewTest.length));");
    expect(src).toContain("confirmedNewTest = confirmedNewTest.filter((t) => !baseNow.has(t));");
    expect(src).toContain("const testOk = confirmedNewTest.length === 0 && !passRegressed && !summaryMissing;");
    expect(src).toContain(': !testOk ? "tests" : "own_check";');
  });
});
