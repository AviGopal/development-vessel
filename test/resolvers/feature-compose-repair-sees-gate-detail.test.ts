// THE REPAIR ROUND SEES WHY THE DRAFT FAILED (CHANGE-33/R1).
//
// A failed verify's `output` is raw + detail: the whole pipeline log (install, a passing typecheck, thousands of
// "(pass)" lines) with the gate's own reason APPENDED. The repair prompt quoted only its first 4000 chars and called
// every failure "fails bun run lint", so for any failure past the typecheck the model never saw the reason. Measured:
// 25 of 33 "wrote nothing" rounds; and on 2026-10-16 05:52Z the lane's attempt on a system-detected gap (its own check:
// "5.2.4: Circuit breaker should open after consecutive failures", "5.2.5: …health score…") edited an unrelated test
// while the check stayed red.
//
//   [MUST-FAIL] an own_check failure whose reason lies past char 4000 of the raw output: the prompt carries the stage,
//               the gate's detail, the failing test names with Expected/Received and the gap's edit site, as fields
//               of their own AHEAD of the raw slice, and the slice is no bigger than before.
//   [CONTROL]   a typecheck failure whose error is at the head of the log: the prompt is today's, byte for byte.
//   [MUST-FAIL] wiring: the repair round's LLM call is built by buildRepairPrompt, and a missed old_string is logged.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("fc-repair-sees-gate-detail", { who: "feature-compose-repair-sees-gate-detail.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;

const NAMES = ["5.2.4: Circuit breaker should open after consecutive failures", "5.2.5: health score drops below the threshold under load"];
const EDIT_SITE = "repos/activity-api/src/lib/circuit-breaker.ts";
const passLines = Array.from({ length: 400 }, (_, i) => `(pass) unrelated suite > passing case number ${i} [0.12ms]`).join("\n");
const reason = ` | OWN CHECK IS STILL RED (test/phase5-integration.test.ts): ${NAMES.join(" ; ")}`;

describe("the repair round is shown the gate's own reason", () => {
  it("[MUST-FAIL] an own_check failure past char 4000: stage, gate detail, failing tests and edit site lead the prompt", () => {
    const build = fc["buildRepairPrompt"];
    expect(typeof build).toBe("function");
    const output = `== install ==\nok\n== typecheck ==\nTC_EXIT=0\n== tests ==\n${passLines}\n${reason}`;
    expect(output.indexOf(NAMES[0]!)).toBeGreaterThan(4000);
    const fv = {
      vessel: "repos/activity-api", errors: "verify", exit_code: 0, ok: false, output, stage: "own_check",
      own: { test_file: "test/phase5-integration.test.ts", failing: [{ name: NAMES[0], expected: "\"open\"", received: "\"closed\"" }, { name: NAMES[1], error: "expected 40 to be less than 30" }] },
      draft: { own_red: NAMES, introduced: [], new_ts: [], gate_detail: reason.replace(/^ \| /, "") },
    };
    const p: string = build(fv, "", EDIT_SITE);
    expect(p).toContain("FAILING STAGE: own_check");
    expect(p).toContain("GATE DETAIL");
    for (const n of NAMES) expect(p).toContain(n);
    expect(p).toContain('expected "open", received "closed"');
    expect(p).toContain(EDIT_SITE);
    // the evidence is AHEAD of the raw slice
    expect(p.indexOf(NAMES[0]!)).toBeLessThan(p.indexOf("== install =="));
    // and the slice is no bigger than before: the raw text past char 4000 is not quoted
    expect(p).not.toContain("passing case number 399");
    expect(p).not.toContain("fails `bun run lint`");
  });

  it("[CONTROL] a typecheck failure at the head of the log keeps today's prompt, byte for byte", () => {
    const output = "src/x.ts(3,5): error TS2304: Cannot find name 'widgt'.\nTC_EXIT=2";
    const fv = { vessel: "repos/activity-api", errors: "verify", exit_code: 2, ok: false, output, stage: "typecheck", draft: { own_red: [], introduced: [], new_ts: ["src/x.ts(3,5): error TS2304: Cannot find name 'widgt'."], gate_detail: "src/x.ts(3,5): error TS2304: Cannot find name 'widgt'." } };
    const win = "\n\nCURRENT CONTENT of src/x.ts lines 1-5 (the first error is at line 3).";
    const today = `A change to vessel repos/activity-api fails \`bun run lint\` (strict tsc + shape-dispatch agreement: every advertised shape in src/config.ts MUST have a matching case in src/routes/impulses.ts and vice-versa). Lint output:\n\n${output}${win}\n\nPick the SINGLE most-blocking error and emit ONE JSON object {"file":"repos/activity-api/<subpath>","old_string":"<a SHORT verbatim UNIQUE substring of that file's CURRENT content>","new_string":"<corrected replacement>"} that fixes it, changing as little else as possible. For a missing dispatch case, copy the shape into the switch next to a sibling case. old_string MUST appear verbatim. No prose, no fences. Escape newlines as \\n.`;
    expect(fc["buildRepairPrompt"](fv, win, EDIT_SITE)).toBe(today);
  });

  it("[MUST-FAIL] wiring: the repair LLM call is built by buildRepairPrompt, and a missed old_string is logged", () => {
    const src = readFileSync(new URL("../../src/resolvers/feature-compose.ts", import.meta.url), "utf8");
    expect(src).toMatch(/(buildRepairPrompt|repairPromptLogged)\(fv, errorSiteWindow, gapEditSiteOf\(pointer\)/);
    expect(src).not.toContain("Lint output:\\n\\n${errText.slice(0, 4000)}${errorSiteWindow}");
    expect(src).toContain("old_string not found in the file's current content");
  });

  it("[R1b] a repair round whose prompt R1 changed journals it; an unchanged round adds no line", () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => { logs.push(String(m)); };
    try {
      const fv = { vessel: "repos/activity-api", errors: "verify", exit_code: 0, ok: false, output: "x".repeat(5000) + " | OWN CHECK IS STILL RED: 5.2.4", stage: "own_check", own: { test_file: "t.test.ts", failing: [{ name: "5.2.4: z" }] }, draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "OWN CHECK IS STILL RED: 5.2.4" } };
      fc["repairPromptLogged"](fv, "", "repos/activity-api/src/a.ts", "gap-1");
      fc["repairPromptLogged"]({ ...fv, output: "src/x.ts(1,1): error TS2304: x", stage: "typecheck", own: undefined, draft: { own_red: [], introduced: [], new_ts: [], gate_detail: "" } }, "", null, "gap-2");
    } finally { console.log = orig; }
    const lines = logs.filter((l) => l.startsWith("[fc-repair] prompt "));
    // the changed (evidence) round is journalled; today's (lint) round adds no line, so its console is as before
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!.slice("[fc-repair] prompt ".length))).toMatchObject({ gap: "gap-1", stage: "own_check", form: "evidence", own_failing: 1 });
  });
});
