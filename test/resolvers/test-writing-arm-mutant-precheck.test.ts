// A TEST-WRITING CHECK WHOSE RED NO CHANGE TO THE SITE MOVES IS REFUSED AT THE VERIFY, BEFORE IT LANDS (arm pre-check,
// mutant slice). Six of the ten check-only landings the arm step refused in a day failed red_independent_of_edit_site
// (and one region_red_unchanged): the check failed the same way under every mutant of its edit site. Those gates ran only
// after landing, at the vessel clone, where the drafted check did not exist yet. Now the test-writing verify runs the
// arm step's own gates (gap-check-supply.ts editSiteMutationGateAt / regionMutantGateAt) at the compose worktree, through
// test_suite's `root` override, each mutant in a throwaway copy of the worktree:
//   - [MUST-FAIL, end to end] a drafted check that fails the same way under every mutant of its edit site is not
//     accepted; the repair round is shown the arm step's red_independent_of_edit_site reason. Real resolveFeatureCompose
//     (test-writing mode) on the drafter-split harness; this file answers only the planner and the check's runs. Red at
//     the parent (the static slice), which accepts it.
//   - [CONTROL, end to end] a check whose red a mutant moves is not refused by the gates.
//   - [MUST-FAIL] test_suite accepts a `root` only under the compose workspace (composeRootProblem), and refuses any
//     other root, fail closed; [CONTROL] a test_suite call with no root reads the vessel clone as before.
//   - [MUST-FAIL, real shell] a mutant run at a compose root runs the mutant in a throwaway copy: the mutated copy's
//     run is red, the worktree's file is byte-unchanged afterwards, and the copy is removed. The command test_suite
//     builds is executed by bash here (this file stands in only for discovery and the shell vessel's transport).
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("fc-tw-arm-mutant", { superRepo: true, who: "test/resolvers/test-writing-arm-mutant-precheck.test.ts" });
const H_MOD = await import("../drafter-split/harness.js");
const { createHarness, VESSEL, COMPUTE_SRC } = H_MOD;
const H = createHarness(ROOT, RUNTIME);
const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
const ts = (await import("../../src/resolvers/test-suite.js")) as Record<string, any>;
csa.__setCheckSupplyLedgerWaitForTests?.({ attempts: 1, delay_ms: 0, read_timeout_ms: 5_000 });
afterAll(() => { csa.__setCheckSupplyLedgerWaitForTests?.(null); H.restore(); });

type Row = Record<string, any>;
const SITE = `repos/${VESSEL}/src/compute.ts`;
const RED = "compute adds two to the scaled value";
const CONTROL = "control: compute returns a number";
const CHECK_SRC = `import { test, expect } from "bun:test";\nimport * as mod from "../../src/compute";\ntest(${JSON.stringify(RED)}, () => { expect(mod.compute(1)).toBe(4); });\ntest(${JSON.stringify(CONTROL)}, () => { expect(typeof mod.compute(1)).toBe("number"); });\n`;
const redRun = (checkRel: string) => [
  `${checkRel}:`, "error: expect(received).toBe(expected)", "", "Expected: 4", "Received: 3", "",
  `      at <anonymous> (/vessel/${checkRel}:3:60)`, `(fail) ${RED} [1.00ms]`, `(pass) ${CONTROL} [0.10ms]`, "", " 1 pass", " 1 fail", " 2 expect() calls", "Ran 2 tests across 1 file. [5.00ms]", "",
].join("\n");
const greenRun = () => [`(pass) ${RED} [1.00ms]`, `(pass) ${CONTROL} [0.10ms]`, "", " 2 pass", " 0 fail", " 2 expect() calls", "Ran 2 tests across 1 file. [5.00ms]", ""].join("\n");

let seq = 0;
/** One supply-admitted test-writing compose whose planner writes the check; `mutantsMove` decides a mutated copy's run. */
async function compose(gap: string, mutantsMove: boolean): Promise<{ body: Row; prompts: string[]; console: string; mutantRuns: number }> {
  H.install();
  const fc = await import(`../../src/resolvers/feature-compose.ts?tw-arm-mutant=${++seq}`);
  const checkRel = csa.checkSupplyCheckPath(gap) as string;
  const CHECK = `repos/${VESSEL}/${checkRel}`;
  const DISPATCH = `dispatch-${gap}`;
  const SUMMARY = `compute in ${SITE} adds 1; it must add 2`;
  const meta: Row = { edit_site: SITE, check_supply: { state: "goal_dispatched", dispatch_id: DISPATCH, vessel: VESSEL, test_file: checkRel, edit_site: SITE } };
  const prompts: string[] = [];
  let mutantRuns = 0;
  const viaFixture = {
    resolveFeatureCompose: async (p: unknown) => {
      // The vessel clone as a git repo with an origin/dev, so the compose is ISOLATED (compose-workspace.ts) as it is
      // live: the drafted check is then written into a worktree under the compose workspace, the tree the gates read.
      const clone = join(ROOT, "clones", VESSEL);
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture"], ["update-ref", "refs/remotes/origin/dev", "HEAD"]]) {
        const r = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`fixture clone: git ${args.join(" ")}: ${r.stderr}`);
      }
      const router = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        let b: Row = {};
        try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json */ }
        const prompt = String(b?.prompt ?? "");
        if (prompt) prompts.push(prompt);
        if (prompt.includes("decomposing a feature specification")) {
          return Response.json({ content: JSON.stringify({ summary: "write the check", touched_vessels: [`repos/${VESSEL}`], ops: [{ kind: "create_file", path: CHECK, content: CHECK_SRC, rationale: "fixture" }] }) });
        }
        const ptr = (b?.impulse?.pointer ?? b?.pointer ?? b?.impulse ?? {}) as Row;
        const command = typeof ptr.command === "string" ? ptr.command : "";
        if (ptr.type === "shell" && command.includes("bun test") && command.includes(checkRel)) {
          // A mutant run is a throwaway copy with the mutation applied (test-suite.ts): its stdout carries the marker.
          if (command.includes("apply-mutant")) { mutantRuns++; return Response.json({ stdout: `MUTATION_APPLIED=1\n${mutantsMove ? greenRun() : redRun(checkRel)}` }); }
          return Response.json({ stdout: redRun(checkRel) });
        }
        return router(input as never, init);
      }) as typeof fetch;
      try { return await fc.resolveFeatureCompose(p); } finally { globalThis.fetch = router; }
    },
  };
  let body: Row = {};
  const rec = await H.run(viaFixture, {
    name: `tw arm mutant ${gap}`,
    pointer: {
      spec: `Write ONE failing test in ${CHECK} that reproduces: ${SUMMARY}. Import the module the defect lives in as a namespace, import * as mod from "../../src/compute", and assert on it. Do not change src/ or any other file.`,
      verify_vessels: [`repos/${VESSEL}`], land: true, skip_push: true, directed: false,
      gap: { id: gap, summary: SUMMARY, classification_metadata: meta },
      check_supply: { gap_id: gap, dispatch_id: DISPATCH }, authoring_execution_id: DISPATCH,
    },
    plan: "no_ops",
    clone: { [`${VESSEL}/package.json`]: "{\"name\":\"demo-vessel\",\"type\":\"module\"}\n", [`${VESSEL}/src/compute.ts`]: COMPUTE_SRC },
    store: [{ id: gap, status: "open", category: "code_quality", summary: SUMMARY, classification_metadata: meta }],
    pool: { spendEnvelope: { uncapped: true } },
  }, (bb) => { body = bb; });
  return { body, prompts, console: rec.console.join("\n"), mutantRuns };
}

describe("the test-writing verify runs the arm step's mutant gates at the compose worktree", () => {
  it("[MUST-FAIL] a check whose red no mutant of the site moves is refused at the verify with red_independent_of_edit_site", async () => {
    const { body, prompts, console: log, mutantRuns } = await compose("tw-arm-indep", false);
    expect(log, "the compose was admitted as test-writing work").toContain("compose_mode=test_writing");
    expect(log, "the compose was isolated").not.toContain("isolation unavailable");
    expect(log, "the mutant gates ran at the compose root").not.toContain("mutant gates not applied");
    expect(mutantRuns).toBeGreaterThan(0);
    expect(body.verdict).not.toBe("FAVORABLE");
    expect(prompts.some((p) => p.includes("red_independent_of_edit_site: the named test(s) fail the same way under all"))).toBe(true);
  }, 120_000);

  it("[CONTROL] a check whose red a mutant moves is not refused by the gates", async () => {
    const { prompts, console: log, mutantRuns } = await compose("tw-arm-moves", true);
    expect(log).not.toContain("mutant gates not applied");
    expect(mutantRuns).toBeGreaterThan(0);
    expect(prompts.some((p) => /red_independent_of_edit_site|region_red_unchanged/.test(p))).toBe(false);
  }, 120_000);
});

describe("test_suite's root override: a compose worktree only", () => {
  it("[MUST-FAIL] a root under the compose workspace is accepted; any other root is refused, fail closed", async () => {
    expect(typeof ts.composeRootProblem).toBe("function");
    const ws = join(ROOT, "rootcheck-ws"); const inside = join(ws, "fc-x", VESSEL); mkdirSync(inside, { recursive: true });
    const saved = process.env["COMPOSE_WS_DIR"]; process.env["COMPOSE_WS_DIR"] = ws;
    try {
      expect(ts.composeRootProblem(inside)).toBeNull();
      expect(ts.composeRootProblem(ROOT)).toContain("not under the compose workspace");
      expect(ts.composeRootProblem(`${inside}/../../..`)).toContain("no '..'");
      expect(ts.composeRootProblem("relative/path")).toContain("absolute");
      expect(ts.composeRootProblem(join(ws, "missing"))).toContain("does not exist");
      const r = await ts.resolveTestSuite({ type: "test_suite", vessel: `repos/${VESSEL}`, test_file: "test/x.test.ts", root: ROOT });
      expect(r.shape).toBe("structuredError");
      expect(r.body.field).toBe("root");
    } finally { if (saved === undefined) delete process.env["COMPOSE_WS_DIR"]; else process.env["COMPOSE_WS_DIR"] = saved; }
  });
  it("[CONTROL] a call with no root is not refused for a root", async () => {
    const r = await ts.resolveTestSuite({ type: "test_suite", vessel: `repos/${VESSEL}`, test_file: "test/../x.test.ts" });
    expect(r.body.field).not.toBe("root");
  });
});

describe("test_suite at a compose root, through a real shell: the mutant runs in a copy, never in the worktree", () => {
  it("[MUST-FAIL] the mutated copy is red, the worktree's site is unchanged, the copy is removed", async () => {
    const ws = join(ROOT, "realshell-ws"); const wt = join(ws, "fc-real", "real-vessel");
    for (const d of [join(wt, "src"), join(wt, "test"), join(wt, "node_modules")]) mkdirSync(d, { recursive: true });
    const SRC = "export function inc(x: number): number {\n  return x + 1;\n}\n";
    writeFileSync(join(wt, "src", "inc.ts"), SRC);
    writeFileSync(join(wt, "test", "inc.test.ts"), `import { test, expect } from "bun:test";\nimport { inc } from "../src/inc";\ntest("inc adds one", () => { expect(inc(1)).toBe(2); });\n`);
    const start = SRC.indexOf("x + 1"); const end = start + "x + 1".length;
    const saved = process.env["COMPOSE_WS_DIR"]; process.env["COMPOSE_WS_DIR"] = ws;
    const router = globalThis.fetch;
    const commands: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/resolve") && String(init?.body ?? "").includes("vesselCapability")) return Response.json({ content: { vessels: [{ endpoint: "http://shell.invalid", resolve_endpoint: "/resolve" }] } });
      if (url.startsWith("http://shell.invalid")) {
        const command = String(JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.command ?? "");
        commands.push(command);
        const r = spawnSync("bash", ["-c", command], { encoding: "utf8", cwd: wt, timeout: 120_000 });
        return Response.json({ stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` });
      }
      return router(input as never, init);
    }) as typeof fetch;
    try {
      const plain = await ts.resolveTestSuite({ type: "test_suite", vessel: "repos/real-vessel", test_file: "test/inc.test.ts", root: wt });
      expect(plain.shape).toBe("test_suite");
      expect(plain.body.verified_root).toBe(wt);
      expect(plain.body.fail).toBe(0);
      const mut = await ts.resolveTestSuite({ type: "test_suite", vessel: "repos/real-vessel", test_file: "test/inc.test.ts", root: wt, base_ref: "HEAD", mutate_edit: { file: "src/inc.ts", start, end, original: "x + 1", replacement: "x - 1", operator: "arith" } });
      expect(mut.shape).toBe("test_suite");
      expect(mut.body.mutation?.applied).toBe(true);
      expect(mut.body.fail).toBeGreaterThan(0);
      const copy = String(mut.body.verified_root ?? "");
      expect(copy.startsWith("/tmp/test-suite-base-")).toBe(true);
      expect(existsSync(copy)).toBe(false);
      expect(readFileSync(join(wt, "src", "inc.ts"), "utf8")).toBe(SRC);
      expect(commands.some((c) => c.includes("worktree add"))).toBe(false);
    } finally {
      globalThis.fetch = router;
      if (saved === undefined) delete process.env["COMPOSE_WS_DIR"]; else process.env["COMPOSE_WS_DIR"] = saved;
    }
  }, 180_000);
});
