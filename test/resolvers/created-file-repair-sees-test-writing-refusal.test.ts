// THE CREATED-FILE REPAIR OF A REFUSED CHECK IS TOLD WHY, AND WHAT THE MODULE EXPORTS.
//
// A test-writing compose CREATES its check, so the repair loop re-authors it whole (repairCreatedFile) before any
// surgical round. That prompt quoted the first 4000 chars of the verify output as "TYPECHECK OUTPUT", and the verify
// appends the refused check's reason at the END, past the pipeline log: a check refused
// check_references_missing_export was rewritten without its reason or the module's exported surface.
//
//   [MUST-FAIL] a created check refused check_references_missing_export, with a verify output over 4000 chars: the
//               created-file repair prompt carries the refusal reason and the EXPORTED SURFACE, ahead of the slice;
//   [MUST-FAIL] wiring: repairCreatedFile builds its prompt with createdFileRepairPrompt and passes the failing verify;
//   [CONTROL]   a created-file repair for a plain typecheck error is byte-identical to the prompt before.
// No LLM, no network.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("created-file-repair-tw", { who: "created-file-repair-sees-test-writing-refusal.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const REL = "repos/goal-host-vessel/test/checks/the-floor-hand-picked-tool-list-omits-the-shape-the-chooser.check.ts";
const CONTENT = `import { expect, test } from "bun:test";\nimport * as mod from "../../src/index";\ntest("t", () => { expect((mod as any).universalToolFallback?.("x") ?? []).toContain("shellResult"); });\n`;
const REASON = "check_references_missing_export:universalToolFallback: the check reads universalToolFallback from src/index.ts, which does not export it (it exports 3 names: runGroundedToolLoop, floorJudgedShapes, FLOOR_TOOL_MAX), so the check is red for the missing name on every tree, not for the defect";
const DETAIL = `THE TEST-WRITING CHECK test/checks/the-floor-hand-picked-tool-list-omits-the-shape-the-chooser.check.ts IS REFUSED (check_references_missing_export): ${REASON}`;
const SURFACE = "runGroundedToolLoop: function (goal: string, maxSteps: number): { tools: string[]; steps: number }\nfloorJudgedShapes: function (targetShapes: readonly string[], called: ReadonlySet<string>): string[]\nFLOOR_TOOL_MAX: const";
const passLines = Array.from({ length: 200 }, (_, i) => `(pass) unrelated suite > passing case number ${i} [0.12ms]`).join("\n");
const ERR = `== install ==\nok\n== typecheck ==\nTC_EXIT=0\n== tests ==\n${passLines}\n | ${DETAIL}`;
const FV = {
  test_writing: { ok: false, stage: "check_references_missing_export", reason: REASON, check_file: "test/checks/x.check.ts", edit_site: "src/index.ts", runs: [], exported_surface: { module: "src/index.ts", text: SURFACE } },
  draft: { own_red: [], introduced: [], new_ts: [], gate_detail: DETAIL },
};
/** The prompt repairCreatedFile built before this change, verbatim. */
const before = (rel: string, errText: string, cur: string): string =>
  `The file ${rel} was created by this change and fails \`bun run typecheck\`. Re-author it COMPLETELY and correctly.\n\n` +
  `TYPECHECK OUTPUT:\n${errText.slice(0, 4000)}\n\n` +
  `CURRENT CONTENT of ${rel}:\n${cur.slice(0, 24000)}\n\n` +
  `Emit the ENTIRE corrected file and nothing else — no prose, no code fences, no commentary. ` +
  `Preserve every export the rest of the vessel depends on. Change as little as the errors require.`;

describe("the created-file repair of a refused test-writing check", () => {
  it("[MUST-FAIL] carries the refusal reason and the exported surface ahead of the TYPECHECK OUTPUT slice", () => {
    expect(ERR.length).toBeGreaterThan(4000);
    expect(ERR.slice(0, 4000)).not.toContain("check_references_missing_export");
    expect(typeof fc["createdFileRepairPrompt"]).toBe("function");
    const p: string = fc["createdFileRepairPrompt"](REL, ERR, CONTENT, FV);
    expect(p).toContain("EXPORTED SURFACE of src/index.ts");
    for (const line of SURFACE.split("\n")) expect(p).toContain(line);
    expect(p).toContain(REASON);
    expect(p.indexOf("EXPORTED SURFACE")).toBeLessThan(p.indexOf("TYPECHECK OUTPUT:"));
    expect(p.indexOf(REASON)).toBeLessThan(p.indexOf("TYPECHECK OUTPUT:"));
  });

  it("[MUST-FAIL] wiring: repairCreatedFile builds its prompt with createdFileRepairPrompt and is handed the failing verify", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf8");
    expect(src).toContain("createdFileRepairPrompt(rel, errText, curContent, fv)");
    expect(src).toContain("repairCreatedFile(cabs, errText, fv)");
  });

  it("[CONTROL] a created-file repair for a plain typecheck error is byte-identical", () => {
    expect(typeof fc["createdFileRepairPrompt"]).toBe("function");
    const rel = "repos/development-vessel/src/new-module.ts";
    const err = "== typecheck ==\nsrc/new-module.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nTC_EXIT=2\n";
    const cur = "export const n: number = 'x';\n";
    const fv = { draft: { own_red: [], introduced: [], new_ts: ["src/new-module.ts(3,7): error TS2322"], gate_detail: "" } };
    expect(fc["createdFileRepairPrompt"](rel, err, cur, fv)).toBe(before(rel, err, cur));
    expect(fc["createdFileRepairPrompt"](rel, err, cur)).toBe(before(rel, err, cur));
  });
});
