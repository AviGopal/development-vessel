// THE REPAIR ROUND IS SHOWN THE FILE IT MUST QUOTE (agf_4ukvuyt3mad9).
//
// The repair prompt carried file bytes only as the window around a tsc `file(line,col)` (or the shape-dispatch
// switch). A draft that typechecks and then fails its tests or its own check has neither, so the round was asked for a
// verbatim substring of a file it was never shown. Measured on one node, 2026-10-26: 77 of 80 "old_string not found"
// refusals followed a tests or own_check prompt; one of them sent `resolved === false` for a file that reads
// `p["resolved"] === false`.
//
//   [MUST-FAIL] a tests-stage failure with no tsc site: the window shows the region the draft changed, numbered, from
//               the file as it is now, and the prompt built with it quotes the real line.
//   [MUST-FAIL] a large file the draft changed deep inside: only that region (with context) is shown.
//   [CONTROL]   a large file the draft did not change is not shown (no 20k-line window); a small one is shown whole.
//   [MUST-FAIL] wiring: the repair round builds this window when no tsc site grounded it, from a read made in the round.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-repair-grounds-current-region", { who: "feature-compose-repair-grounds-current-region.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const BASE = Array.from({ length: 76 }, (_, i) => `// line ${i + 1}`);
BASE[37] = `  const r = { ...(refusal ? { refusal } : {}), ...(p["resolved"] === false ? { resolvedFalse: true as const } : {}) };`;
BASE[49] = `  if (p["resolved"] === false && p["dispatch_budget_exhausted"] === true) {`;
const DRAFT = [...BASE];
DRAFT[50] = `    return { ok: false, error: "budget", refusal: "budget_exhausted" }; // drafted`;

describe("the repair round is shown the current bytes of the file it must quote", () => {
  it("[MUST-FAIL] a tests-stage failure with no tsc site: the changed region, numbered, from the file now", () => {
    const win = fc["repairRegionWindow"]?.("src/failure-type.ts", DRAFT.join("\n"), BASE.join("\n"));
    expect(win).toBeTruthy();
    expect(win.lo).toBe(51 - 25);
    expect(win.hi).toBe(51 + 25);
    expect(win.text).toContain(`   50| ${BASE[49]}`);
    expect(win.text).toContain(`   51| ${DRAFT[50]}`);
    expect(win.text).toContain(`   38| ${BASE[37]}`);
    expect(win.text).toContain(`"kind":"replace_lines","path":"src/failure-type.ts"`);
    expect(win.text).not.toContain("   25| ");
    const fv = {
      vessel: "repos/light-dispatch-vessel", errors: "verify", exit_code: 0, ok: false, stage: "tests",
      output: "== typecheck ==\nTC_EXIT=0\n== tests ==\n(fail) a budget refusal is typed by its structured field > [CONTROL] resolved:false WITHOUT the budget flag is a success",
      draft: { own_red: [], introduced: ["(fail) a budget refusal is typed by its structured field > [CONTROL] resolved:false WITHOUT the budget flag is a success"], new_ts: [], gate_detail: "NEW test failures introduced by this draft, REPRODUCED on a second run (1)" },
    };
    const p: string = fc["buildRepairPrompt"](fv, win.text, "repos/light-dispatch-vessel/src/failure-type.ts");
    expect(p).toContain(`p["resolved"] === false && p["dispatch_budget_exhausted"] === true`);
  });

  it("[MUST-FAIL] a large file changed deep inside: only that region is shown", () => {
    const big = Array.from({ length: 21000 }, (_, i) => `const v${i} = ${i};`);
    const draft = [...big];
    draft[9999] = "const v9999 = 'drafted';";
    const win = fc["repairRegionWindow"]?.("src/index.ts", draft.join("\n"), big.join("\n"));
    expect(win).toBeTruthy();
    expect(win.lo).toBe(10000 - 25);
    expect(win.hi).toBe(10000 + 25);
    expect(win.text).toContain(`10000| const v9999 = 'drafted';`);
    expect(win.text).not.toContain("const v0 = 0;");
  });

  it("[CONTROL] an unchanged large file is not shown; an unchanged small file is shown whole", () => {
    const big = Array.from({ length: 21000 }, (_, i) => `const v${i} = ${i};`).join("\n");
    expect(fc["repairRegionWindow"]("src/index.ts", big, undefined)).toBeNull();
    expect(fc["repairRegionWindow"]("src/index.ts", big, big)).toBeNull();
    const small = fc["repairRegionWindow"]("test/checks/x.check.ts", BASE.join("\n"), undefined);
    expect(small.lo).toBe(1);
    expect(small.hi).toBe(76);
    expect(small.text).toContain("the whole file");
  });

  it("[MUST-FAIL] wiring: an ungrounded repair round reads the file in the round and shows its region", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    const loop = src.slice(src.indexOf("C-window-1 RE-GROUND INSIDE THE ATTEMPT"), src.indexOf("const fix = parseJsonObject(await llmCallWithFailover("));
    expect(loop).toContain("if (!errorSiteWindow) {");
    expect(loop).toContain('callTool(toolsEndpoint, "fs_read", { path: abs })');
    expect(loop).toContain("repairRegionWindow(rel, gc, preEditContent.get(abs))");
    expect(loop).toContain("errorSiteWindow = win.text;");
  });
});
