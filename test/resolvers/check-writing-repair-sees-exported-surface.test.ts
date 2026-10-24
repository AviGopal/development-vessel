// A CHECK REFUSED FOR READING A NAME ITS MODULE DOES NOT EXPORT IS REPAIRED ONTO THE MODULE'S REAL EXPORTS.
//
// Measured (dispatch f176b321, a check-supply compose for a goal-host src/index.ts gap): the drafted check called the
// module's internal universalToolFallback off its namespace import, so the verify refused it,
// check_references_missing_export. The refusal's reason names at most 12 of the module's 83 exports and no signature,
// and the repair prompt quotes that reason clipped, so each repair round re-drafted without the surface it had to
// call, and each broke the typecheck.
//
//   [MUST-FAIL] the test-writing judgement of such a check carries the refused module's exported surface: every
//               export with its declared signature, read by the enumeration the refusal itself uses (exportContract);
//   [MUST-FAIL] the repair prompt for that verify carries that surface as a field of its own;
//   [CONTROL]   a check that reads only exported names is judged as before, with no surface; and a repair prompt for
//               any other refusal is byte-identical to the one built without the judgement.
// Real bun runs the check (the bun on PATH), on a fixture vessel under TMPDIR. No LLM, no network.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("check-writing-repair-surface", { who: "check-writing-repair-sees-exported-surface.test.ts" });
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;

const SITE_SRC = [
  `function universalToolFallback(goal: string): string[] { return goal ? ["fs_read", "fs_grep"] : []; }`,
  `export function runGroundedToolLoop(goal: string, maxSteps: number): { tools: string[]; steps: number } { return { tools: universalToolFallback(goal), steps: maxSteps }; }`,
  `export function floorJudgedShapes(targetShapes: readonly string[], called: ReadonlySet<string>): string[] { return targetShapes.filter((s) => called.has(s)); }`,
  `export const FLOOR_TOOL_MAX = 4;`,
  ``,
].join("\n");
const SIGNATURES = [
  "runGroundedToolLoop: function (goal: string, maxSteps: number): { tools: string[]; steps: number }",
  "floorJudgedShapes: function (targetShapes: readonly string[], called: ReadonlySet<string>): string[]",
  "FLOOR_TOOL_MAX: const",
];
const H = `import { expect, test } from "bun:test";\nimport * as mod from "../../src/index";\n`;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function vessel(gapId: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), "tw-surface-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test", "checks"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), SITE_SRC);
  writeFileSync(join(root, "test", "checks", csa.checkSupplyCheckFile(gapId)), H + body);
  return root;
}
const runner = (root: string) => async (rel: string): Promise<string> => {
  const p = Bun.spawnSync([process.execPath, "test", `./${rel}`, "--timeout", "20000"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
};
async function judged(gapId: string, body: string): Promise<Record<string, any>> {
  const root = vessel(gapId, body);
  return csa.judgeTestWritingCheck({ gapId, vesselRoot: root, editSite: "repos/goal-host-vessel/src/index.ts", run: runner(root), runs: 3 });
}
/** The verify result feature_compose builds for a refused test-writing check (runVerify's shape). */
const failedVerify = (j: Record<string, any>) => {
  const detail = csa.testWritingDetail(j);
  return {
    vessel: "repos/goal-host-vessel", errors: "verify", exit_code: 0, ok: false, stage: "own_check",
    output: `== typecheck ==\nTC_EXIT=0\n== tests ==\n(pass) fixture > ok\n${detail}`,
    test_writing: j,
    draft: { own_red: [], introduced: [], new_ts: [], gate_detail: detail.replace(/^\s*\|\s*/, "").trim() },
  };
};
const INTERNAL = `test("the floor offers the shape the chooser named", () => { const f = (mod as Record<string, any>)["universalToolFallback"]; expect(f?.("run a shell") ?? []).toContain("shellResult"); });\n`;
const EXPORTED = `test("the floor offers the shape the chooser named", () => { expect(mod.runGroundedToolLoop("run a shell", 2).tools).toContain("shellResult"); });\n`;
const CHECK = `repos/goal-host-vessel/${csa.checkSupplyCheckPath("tw-surface-internal")}`;

describe("a check refused for a missing export is repaired onto the exported surface", () => {
  it("[MUST-FAIL] the judgement carries the refused module's exports, each with its declared signature", async () => {
    const j = await judged("tw-surface-internal", INTERNAL);
    expect(j).toMatchObject({ ok: false, stage: "check_references_missing_export", edit_site: "src/index.ts" });
    expect(String(j.reason).startsWith("check_references_missing_export:universalToolFallback")).toBe(true);
    expect(j.exported_surface?.module).toBe("src/index.ts");
    const text = String(j.exported_surface?.text ?? "");
    for (const line of SIGNATURES) expect(text).toContain(line);
    expect(text).not.toContain("universalToolFallback");
  });

  it("[MUST-FAIL] the repair prompt for that verify carries the surface as its own field", async () => {
    const j = await judged("tw-surface-internal", INTERNAL);
    const p: string = fc.buildRepairPrompt(failedVerify(j), "", CHECK);
    expect(p).toContain("EXPORTED SURFACE of src/index.ts");
    for (const line of SIGNATURES) expect(p).toContain(line);
    expect(p).toContain(`EDIT SITE (where this gap's fix belongs; fix the code there, do not edit another test to make it pass): ${CHECK}`);
  });

  it("[CONTROL] a check that reads only exported names is judged as before, with no surface", async () => {
    const j = await judged("tw-surface-exported", EXPORTED);
    expect(j).toMatchObject({ ok: true, stage: null, edit_site: "src/index.ts" });
    expect(j.exported_surface).toBeUndefined();
  });

  it("[CONTROL] any other refusal's repair prompt is byte-identical to the prompt built without the judgement", async () => {
    const j = await judged("tw-surface-green", `test("green", () => { expect(mod.FLOOR_TOOL_MAX).toBe(4); });\n`);
    expect(j).toMatchObject({ ok: false, stage: "test_writing_check_not_red" });
    expect(j.exported_surface).toBeUndefined();
    const fv = failedVerify(j);
    const { test_writing: _tw, ...without } = fv;
    expect(fc.buildRepairPrompt(fv, "", CHECK)).toBe(fc.buildRepairPrompt(without, "", CHECK));
    expect(fc.buildRepairPrompt(fv, "", CHECK)).not.toContain("EXPORTED SURFACE");
  });
});
