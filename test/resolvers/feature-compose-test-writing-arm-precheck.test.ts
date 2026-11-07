// A TEST-WRITING CHECK THE ARM STEP WOULD REFUSE IS REFUSED AT THE VERIFY, BEFORE IT LANDS (arm pre-check, static slice).
//
// A check-supply compose's check passed the test-writing verify (red at the parent, by assertion), landed as a
// check-only commit, and was then refused by the arm step on predicates the verify never applied: 10 of 11 check-only
// landings in a day, each a commit and a cutover that armed nothing. Three of those predicates are static (the check
// and the parent's edit site only) and now run at the verify, imported from the arm step:
//   - [MUST-FAIL, end to end] a drafted check that never reaches the gap's region is not accepted: the verify refuses
//     it with the arm step's check_call_misses_region reason, and the repair round is shown that reason. Driven
//     through the real resolveFeatureCompose (test-writing mode) on the drafter-split harness; this file answers only
//     the planner (a plan that writes the check) and the check's own runs (an assertion red), and passes the rest
//     through. Red at the parent, which accepts the check.
//   - [MUST-FAIL] the arm step's other two static refusals, by the same reason strings: no control test
//     (check_no_control), and a region that is not a literal once in the edit site (region_not_literal_once).
//   - [CONTROL] a check that reaches the region and carries a control passes them all; the end-to-end compose of it is
//     not refused by them; require_control false (the arm rhythm's own switch) skips the control rule.
// The post-cutover arm step is unchanged (gap-check-supply.ts is not edited).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-tw-arm-precheck", { superRepo: true, who: "test/resolvers/feature-compose-test-writing-arm-precheck.test.ts" });
const H_MOD = await import("../drafter-split/harness.js");
const { createHarness, VESSEL, COMPUTE_SRC } = H_MOD;
const H = createHarness(ROOT, RUNTIME);
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
csa.__setCheckSupplyLedgerWaitForTests?.({ attempts: 1, delay_ms: 0, read_timeout_ms: 5_000 });
afterAll(() => { csa.__setCheckSupplyLedgerWaitForTests?.(null); H.restore(); });

type Row = Record<string, any>;
const SITE = `repos/${VESSEL}/src/compute.ts`;
const REGION_IN_TWICE = "  return compute(x) + compute(x);"; // occurs once, inside twice()
const MISS_TITLE = "compute adds two to the scaled value";
const REACH_TITLE = "twice doubles compute";
const CONTROL_TITLE = "control: compute returns a number";
const CHECK_MISSES = `import { test, expect } from "bun:test";\nimport * as mod from "../../src/compute";\ntest(${JSON.stringify(MISS_TITLE)}, () => { expect(mod.compute(1)).toBe(4); });\ntest(${JSON.stringify(CONTROL_TITLE)}, () => { expect(typeof mod.compute(1)).toBe("number"); });\n`;
const CHECK_REACHES = `import { test, expect } from "bun:test";\nimport * as mod from "../../src/compute";\ntest(${JSON.stringify(REACH_TITLE)}, () => { expect(mod.twice(1)).toBe(8); });\ntest(${JSON.stringify(CONTROL_TITLE)}, () => { expect(typeof mod.compute(1)).toBe("number"); });\n`;
/** One bun run of a check: its first title an assertion red, its second green. */
const runOf = (checkRel: string, red: string, green: string) => [
  `${checkRel}:`,
  "error: expect(received).toBe(expected)", "", "Expected: 4", "Received: 3", "",
  `      at <anonymous> (/vessel/${checkRel}:3:60)`,
  `(fail) ${red} [1.00ms]`, `(pass) ${green} [0.10ms]`, "", " 1 pass", " 1 fail", " 2 expect() calls", "Ran 2 tests across 1 file. [5.00ms]", "",
].join("\n");

let seq = 0;
/** One supply-admitted test-writing compose whose planner writes `checkSrc` and whose check runs are `red`/`green`. */
async function compose(gap: string, checkSrc: string, red: string): Promise<{ body: Row; prompts: string[]; console: string }> {
  H.install();
  const fc = await import(`../../src/resolvers/feature-compose.ts?tw-arm-precheck=${++seq}`);
  const checkRel = csa.checkSupplyCheckPath(gap) as string;
  const CHECK = `repos/${VESSEL}/${checkRel}`;
  const DISPATCH = `dispatch-${gap}`;
  const SUMMARY = `twice in ${SITE} must double compute`;
  const meta: Row = { edit_site: SITE, region: REGION_IN_TWICE, check_supply: { state: "goal_dispatched", dispatch_id: DISPATCH, vessel: VESSEL, test_file: checkRel, edit_site: SITE } };
  const prompts: string[] = [];
  const viaFixture = {
    resolveFeatureCompose: async (p: unknown) => {
      const router = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        let b: Row = {};
        try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
        const prompt = String(b?.prompt ?? "");
        if (prompt) prompts.push(prompt);
        if (prompt.includes("decomposing a feature specification")) {
          return Response.json({ content: JSON.stringify({ summary: "write the check", touched_vessels: [`repos/${VESSEL}`], ops: [{ kind: "create_file", path: CHECK, content: checkSrc, rationale: "fixture" }] }) });
        }
        const ptr = (b?.impulse?.pointer ?? b?.pointer ?? b?.impulse ?? {}) as Row;
        const command = typeof ptr.command === "string" ? ptr.command : "";
        if (ptr.type === "shell" && command.includes("bun test") && command.includes(checkRel)) return Response.json({ stdout: runOf(checkRel, red, CONTROL_TITLE) });
        return router(input as never, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router; }
    },
  };
  let body: Row = {};
  const rec = await H.run(viaFixture, {
    name: `tw arm precheck ${gap}`,
    pointer: {
      spec: `Write ONE failing test in ${CHECK} that reproduces: ${SUMMARY}. Import the module the defect lives in as a namespace, import * as mod from "../../src/compute", and assert on it. Do not change src/ or any other file.`,
      verify_vessels: [`repos/${VESSEL}`], land: true, skip_push: true, directed: false,
      gap: { id: gap, summary: SUMMARY, classification_metadata: meta },
      check_supply: { gap_id: gap, dispatch_id: DISPATCH }, authoring_execution_id: DISPATCH,
    },
    plan: "no_ops",
    store: [{ id: gap, status: "open", category: "code_quality", summary: SUMMARY, classification_metadata: meta }],
    pool: { spendEnvelope: { uncapped: true } },
  }, (bb) => { body = bb; });
  return { body, prompts, console: rec.console.join("\n") };
}

describe("the test-writing verify applies the arm step's static predicates", () => {
  it("[MUST-FAIL] a drafted check that never reaches the gap's region is refused at the verify, and its repair names check_call_misses_region", async () => {
    const { body, prompts, console: log } = await compose("tw-arm-miss", CHECK_MISSES, MISS_TITLE);
    expect(log, "the compose was admitted as test-writing work").toContain("compose_mode=test_writing");
    expect(log, "the check was run by the test-writing verify").toContain("[fc-test-writing-check]");
    expect(body.verdict).not.toBe("FAVORABLE");
    expect(prompts.some((p) => p.includes("check_call_misses_region: what the check calls in src/compute.ts"))).toBe(true);
  }, 90_000);

  it("[CONTROL] a check that reaches the region (with a control) is not refused by them", async () => {
    const { prompts, console: log } = await compose("tw-arm-reach", CHECK_REACHES, REACH_TITLE);
    expect(log).toContain("[fc-test-writing-check]");
    expect(log).not.toContain("would refuse this check after it lands");
    expect(prompts.some((p) => /check_call_misses_region|check_no_control|region_not_literal_once/.test(p))).toBe(false);
  }, 90_000);
});

const fcMod = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const supply = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
describe("testWritingArmStaticRefusal: the same reason strings as the arm step", () => {
  const fc = fcMod;
  const DIR = join(ROOT, "static-vessel");
  const RT = join(RUNTIME, "static-vessel");
  const NO_CONTROL = `import { test, expect } from "bun:test";\nimport * as mod from "../../src/compute";\ntest(${JSON.stringify(REACH_TITLE)}, () => { expect(mod.twice(1)).toBe(8); });\n`;
  // The arm-time region gate reads the edit site where grounding does (the evaluator tree, MITOSIS_RUNTIME_DIR).
  let savedRt: string | undefined;
  // Written here, not at collection: the harness's runs above clear the runtime tree each time.
  beforeAll(() => {
    savedRt = process.env["MITOSIS_RUNTIME_DIR"]; process.env["MITOSIS_RUNTIME_DIR"] = RUNTIME;
    for (const d of [join(DIR, "src"), join(DIR, "test", "checks"), join(RT, "src")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(DIR, "src", "compute.ts"), COMPUTE_SRC); writeFileSync(join(RT, "src", "compute.ts"), COMPUTE_SRC);
    writeFileSync(join(DIR, "test", "checks", "reach.check.ts"), CHECK_REACHES);
    writeFileSync(join(DIR, "test", "checks", "miss.check.ts"), CHECK_MISSES);
    writeFileSync(join(DIR, "test", "checks", "nocontrol.check.ts"), NO_CONTROL);
  });
  afterAll(() => { if (savedRt === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = savedRt; });
  const base = { vessel: "static-vessel", vesselRoot: DIR, siteRel: "src/compute.ts", region: REGION_IN_TWICE, requireControl: true };
  const refusal = (o: Row) => (typeof fc.testWritingArmStaticRefusal === "function" ? fc.testWritingArmStaticRefusal({ ...base, ...o }) : Promise.resolve("absent"));

  it("[MUST-FAIL] a check with no control test: check_no_control, the arm step's reason", async () => {
    expect(await refusal({ checkFile: "test/checks/nocontrol.check.ts", red: [REACH_TITLE] })).toEqual({ stage: "check_no_control", reason: supply.CHECK_NO_CONTROL_REASON });
  });
  it("[MUST-FAIL] a region that is not a literal once in the edit site: region_not_literal_once", async () => {
    const r = await refusal({ checkFile: "test/checks/reach.check.ts", red: [REACH_TITLE], region: "  return base + 2;" });
    expect(r?.stage).toBe("region_not_literal_once");
    expect(r?.reason).toStartWith("region_not_literal_once occurrences=0 edit_site=repos/static-vessel/src/compute.ts: ");
  });
  it("[MUST-FAIL] a check that misses the region: check_call_misses_region, the arm step's reason", async () => {
    const r = await refusal({ checkFile: "test/checks/miss.check.ts", red: [MISS_TITLE] });
    expect(r).toEqual({ stage: supply.CHECK_MISSES_REGION_STAGE, reason: supply.checkMissesRegionRefusal(COMPUTE_SRC, "src/compute.ts", CHECK_MISSES, REGION_IN_TWICE).reason });
  });
  it("[CONTROL] a check that reaches the region and has a control passes; require_control false skips the control rule", async () => {
    expect(await refusal({ checkFile: "test/checks/reach.check.ts", red: [REACH_TITLE] })).toBeNull();
    expect(await refusal({ checkFile: "test/checks/nocontrol.check.ts", red: [REACH_TITLE], requireControl: false })).toBeNull();
    expect(await refusal({ checkFile: "test/checks/reach.check.ts", red: [REACH_TITLE], region: "" })).toBeNull();
  });
});
