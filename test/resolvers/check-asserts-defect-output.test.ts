// A CHECK THAT ASSERTS THE DEFECT'S OWN OUTPUT IS REFUSED AT THE VERIFY (2026-10-24).
//
// goal-host 6c6d632 (a check-supply test-writing compose) landed a check for the gap "a containment-refused shell write
// reaches the walk as produced no result". It calls dispatchFailureReasons with a walk log of objects and expects
// toContain("the command produced no result"): the literal the gap's region returns
// (`if (r == null) return "the command produced no result";`, src/index.ts:10384 at its parent), the defect itself, in a
// function dispatchFailureReasons never reaches. It was red at the parent only because that function cannot parse the
// fixture (received ["Dispatch failed."]); the verify (judgeTestWritingCheck) passed it on three identical assertion
// reds, and a runtime rebinding that appends the literal later turned it green and closed a child gap on it.
//
// THE CONTRACT (check-supply-admission.ts assertsDefectOutputRefusal): with the gap's region given, the verify refuses
// test_writing_check_asserts_defect_output when the failing assertion expects a literal the region returns or emits
// (expects_region_output). Whether the call reaches the region is not judged at the verify. A check asserting the FIXED behaviour through an export that reaches the region, red at the
// parent, still passes; a check green at the parent is still refused not_red.
//
// FIXTURES: 6c6d632's check file verbatim, and an extract of goal-host src/index.ts at its parent (9fe59e85):
// dispatchFailureReasons and the region line verbatim (see the extract's header). The LIVE runs use the bun running
// this file.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const fixture = (name: string): string => readFileSync(join(FIX, name), "utf8");
const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
type Judgement = { ok: boolean; stage: string | null; cause?: string; reason: string };
const judge = csa["judgeTestWritingCheck"] as (i: { gapId: string; vesselRoot: string; editSite: string | null; region?: unknown; run: (rel: string) => Promise<string>; runs?: number }) => Promise<Judgement>;
const checkFile = csa["checkSupplyCheckFile"] as (id: string) => string;
const outputs = csa["regionOutputLiterals"] as undefined | ((siteSrc: string, siteRel: string, region: string) => { literals: string[] } | null);

const GAP = "a-containment-refused-shell-write-reaches-the-walk-as-produced-no-result-so-the-refusal-teaches-nothing";
const EDIT_SITE = "repos/goal-host-vessel/src/index.ts";
const REGION = "if (r == null) return \"the command produced no result\";";
const SITE_SRC = fixture("goal-host-index.extract-9fe59e85.ts.txt");
const CHECK_6C6D632 = fixture("6c6d632-containment-refused.check.ts.txt");
const check = (body: string): string => `import { test, expect } from "bun:test";\nimport * as mod from "../../src/index";\n\n${body}\n`;
// The row's control: the fixed behaviour (a refusal reported as a refusal), through an export that reaches the region.
const CHECK_FIXED = check(`test("a containment-refused shell write is reported as a refusal", async () => {\n  expect(await mod.runGoalAs(null)).toContain("refused by containment");\n});`);
// The same, negated on the region's literal: it asserts the defect is gone, so it is no defect assertion.
const CHECK_NEGATED = check(`test("a containment-refused shell write is not reported as no result", async () => {\n  expect(await mod.runGoalAs(null)).not.toBe("the command produced no result");\n});`);
// Green at the parent.
const CHECK_GREEN = check(`test("the terminal reason is kept", () => {\n  expect(mod.dispatchFailureReasons([], "Dispatch failed.")).toEqual(["Dispatch failed."]);\n});`);

/** One fixture vessel: the extract as src/index.ts and the gap's check file. */
function vessel(checkSrc: string): string {
  const root = mkdtempSync(join(tmpdir(), "asserts-defect-output-"));
  for (const [rel, text] of Object.entries({ "src/index.ts": SITE_SRC, [`test/checks/${checkFile(GAP)}`]: checkSrc })) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const runner = (root: string) => async (rel: string): Promise<string> => {
  const p = Bun.spawnSync([process.execPath, "test", `./${rel}`, "--timeout", "20000"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
};
const verdict = async (checkSrc: string, region: unknown = REGION): Promise<Judgement> => {
  const root = vessel(checkSrc);
  return judge({ gapId: GAP, vesselRoot: root, editSite: EDIT_SITE, region, run: runner(root), runs: 3 });
};

describe("the region's output literals", () => {
  test("[FIXTURE] the check file is the gap's check path, and the region occurs once in the extract", () => {
    expect(checkFile(GAP)).toBe("a-containment-refused-shell-write-reaches-the-walk-as-produc.check.ts");
    expect(SITE_SRC.split(REGION).length).toBe(2);
  });

  test("[MUST-FAIL] the region returns \"the command produced no result\"", () => {
    expect(typeof outputs).toBe("function");
    expect(outputs!(SITE_SRC, "src/index.ts", REGION)?.literals).toEqual(["the command produced no result"]);
  });

  test("[CONTROL] a literal the region only compares is no output; a region not once in the site decides nothing", () => {
    expect(typeof outputs).toBe("function");
    const src = `export function f(x: string): string | null {\n  if (x === "refused") return null;\n  return x;\n}\n`;
    expect(outputs!(src, "src/f.ts", "if (x === \"refused\") return null;")?.literals).toEqual([]);
    expect(SITE_SRC.split("seen.has(").length).toBe(3);
    expect(outputs!(SITE_SRC, "src/index.ts", "seen.has(")).toBeNull();
  });
});

describe("LIVE: the test_writing verify (judgeTestWritingCheck) with the bun running this file", () => {
  test("[MUST-FAIL] 6c6d632's check is refused: it expects the region's own output", async () => {
    const j = await verdict(CHECK_6C6D632);
    expect(j.ok).toBe(false);
    expect(j.stage).toBe("test_writing_check_asserts_defect_output");
    expect(j.cause).toBe("expects_region_output");
    expect(j.reason).toContain("the command produced no result");
    expect(j.reason).toContain(REGION);
  });

  test("[CONTROL] a check asserting the fixed behaviour through an export that reaches the region passes", async () => {
    expect(await verdict(CHECK_FIXED)).toMatchObject({ ok: true, stage: null });
  });

  test("[CONTROL] a negated assertion on the region's literal passes", async () => {
    expect(await verdict(CHECK_NEGATED)).toMatchObject({ ok: true, stage: null });
  });

  test("[CONTROL] with no region on the gap the stage decides nothing (6c6d632's check passes as before)", async () => {
    expect(await verdict(CHECK_6C6D632, null)).toMatchObject({ ok: true, stage: null });
  });

  test("[REGRESSION CONTROL] a check green at the parent is still refused not_red", async () => {
    expect(await verdict(CHECK_GREEN)).toMatchObject({ ok: false, stage: "test_writing_check_not_red" });
  });
});
