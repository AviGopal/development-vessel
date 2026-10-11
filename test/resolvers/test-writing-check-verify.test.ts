// B′ P2 + W1 + W2: A TEST-WRITING COMPOSE IS VERIFIED BY ITS OWN CHECK, RED FOR THE RIGHT REASON, THREE TIMES
// (check-first, 2026-10-08).
//
// An admitted test_writing compose (slice G) writes ONE out-of-suite check, test/checks/<checkSupplyCheckFile(gap)>
// (P1). bun's default discovery never runs a *.check.ts, so the full-suite gate ("no new reds") holds for it
// automatically and says nothing about it. Before this, nothing checked that the landed file is a reproduction at all:
// a green check, a check that fails to LOAD, one that reaches the network or times out, and one that imports nothing
// the gap names all landed and then sat unarmed.
//
// THE CONTRACT (feature-compose verify, test_writing only): run ./test/checks/<id>.check.ts ALONE, 3 times (W1), and on
// EVERY run require a bun summary, >=1 "(fail)", no "# Unhandled error between tests", and every failure classified as
// an ASSERTION by the shared classifier (retry-evidence.ts classifyCheckRun; ANSI stripped first): its error line is
// `error: expect(...)` with Expected/Received (or the diff header) printed, and nothing in its error text names a
// network error, a timeout, a missing module or export, a syntax or reference error. W1: the three runs' failure sets
// are identical by (test name + error class) only, never by Received (timestamps, ids). W2: the check statically,
// barely or dynamically imports the gap's edit_site module (scope-earn-in.ts testImportsFile); an edit_site that is
// not a TS/JS module refuses. Refusal stages: test_writing_check_not_red, test_writing_check_wrong_reason,
// test_writing_check_flaky, test_writing_check_misses_edit_site, edit_site_not_importable.
// qa: a named import of a missing export fails at LOAD (bun ESM "Export named … not found"), so the wrong_reason for it
// names the cure: import the edit site as a namespace (import * as mod) and assert typeof; that form is an assertion red.
//
// REAL BUN: every judgement below is bun's own output on fixtures under TMPDIR, run with the bun on PATH and, when it
// is present, the container's bun 1.4.2 (BUN_ALT_BINARY, else $TMPDIR/bun142/node_modules/.bin/bun). A missing 1.4.2
// is a visible skip, never a pass.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const csa = await import("../../src/resolvers/check-supply-admission.js") as Record<string, unknown>;
const re = await import("../../src/resolvers/retry-evidence.js") as Record<string, unknown>;
type Judgement = { ok: boolean; stage: string | null; cause?: string; reason: string; check_file: string; edit_site: string | null; runs: Array<{ verdict: string; keys: string[]; red: string[]; unhandled: boolean }> };
type JudgeInput = { gapId: string; vesselRoot: string; editSite: string | null; run: (checkRel: string) => Promise<string>; runs?: number };
const judge = csa["judgeTestWritingCheck"] as undefined | ((i: JudgeInput) => Promise<Judgement>);
const detailOf = csa["testWritingDetail"] as undefined | ((j: Judgement) => string);
const RUNS = csa["TEST_WRITING_CHECK_RUNS"];
const armRefusal = re["armRedReasonRefusal"] as undefined | ((rr: unknown, titles: string[]) => { cause?: string; reason: string } | null);
const classify = re["classifyCheckRun"] as undefined | ((raw: string) => { ran: boolean; unhandled: boolean; failures: Array<{ name: string; cls: string; cause?: string }> });
const checkFile = csa["checkSupplyCheckFile"] as (id: string) => string;

const HOST_BUN = process.execPath;
const ALT_BUN = process.env["BUN_ALT_BINARY"] ?? join(tmpdir(), "bun142", "node_modules", ".bin", "bun");
const ALT_PRESENT = existsSync(ALT_BUN);
if (!ALT_PRESENT) console.warn(`[test-writing-check-verify] bun 1.4.2 not found at ${ALT_BUN}: its cases are SKIPPED (visible), not passed`);
const H = `import { expect, test } from "bun:test";\n`;

/** One fixture vessel: src/x.ts plus the gap's check file with `body`. */
function vessel(gapId: string, body: string, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tw-check-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test", "checks"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const widget = 1;\nexport function f(): number { return 1; }\n");
  writeFileSync(join(root, "test", "checks", checkFile(gapId)), H + body);
  for (const [rel, text] of Object.entries(extra)) { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); }
  return root;
}
/** A runner executing `bun test ./<rel>` in the fixture root with the given binary: bun's real output. */
function runner(bin: string, root: string, env: Record<string, string> = {}): (rel: string) => Promise<string> {
  return async (rel: string) => {
    const p = Bun.spawnSync([bin, "test", `./${rel}`, "--timeout", "20000"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir(), NODE_ENV: "test", TZ: "UTC", ...env }, stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  };
}
const SITE = "repos/fixture-vessel/src/x.ts";

for (const [label, bin, present] of [["host bun", HOST_BUN, true], ["bun 1.4.2", ALT_BUN, ALT_PRESENT]] as const) {
  const t = present ? test : test.skip;
  describe(`test_writing verify on ${label}`, () => {
    async function verdict(gapId: string, body: string, editSite: string | null = SITE, extra: Record<string, string> = {}, env: Record<string, string> = {}): Promise<Judgement> {
      expect(typeof judge).toBe("function");
      const root = vessel(gapId, body, extra);
      const run = runner(bin, root, env);
      const head = await run(`test/checks/${checkFile(gapId)}`);
      // the bun that produced the verdict is the one this case names
      expect(head.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(new RegExp(`bun test v${label === "host bun" ? Bun.version.replace(/\./g, "\\.") : "1\\.4\\.2"}`));
      return judge!({ gapId, vesselRoot: root, editSite, run, runs: 3 });
    }

    t("[MUST-FAIL] three runs is the verify's count (W1)", () => {
      expect(RUNS).toBe(3);
    });

    t("[MUST-FAIL] a GREEN check is refused: test_writing_check_not_red", async () => {
      const j = await verdict("tw-green", `import { widget } from "../../src/x";\ntest("green", () => { expect(widget).toBe(1); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_not_red");
    });

    t("[MUST-FAIL] a check that fails to LOAD (unhandled error between tests, no (fail)) is refused: wrong_reason", async () => {
      const j = await verdict("tw-load", `import { widget } from "../../src/x";\nimport { y } from "../../src/absent";\ntest("mm", () => { expect(widget + y).toBe(2); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
      expect(j.cause).toBe("module");
    });

    t("[MUST-FAIL] a syntax error at load is refused: wrong_reason", async () => {
      const j = await verdict("tw-syntax", `import { widget } from "../../src/x";\ntest("syn", () => { expect(widget).toBe(2) ;\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
    });

    t("[MUST-FAIL] a named failure from a refused connection (ECONNREFUSED / ConnectionRefused) is refused: wrong_reason (network)", async () => {
      const j = await verdict("tw-net", `import { widget } from "../../src/x";\ntest("net red", async () => { const r = await fetch("http://127.0.0.1:1/"); expect(r.ok && widget === 2).toBe(true); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
      expect(j.cause).toBe("network");
    });

    t("[MUST-FAIL] a named failure that TIMED OUT is refused: wrong_reason (timeout); its detail cannot read as an environment non-attempt", async () => {
      const j = await verdict("tw-timeout", `import { widget } from "../../src/x";\ntest("timeout red", async () => { await new Promise((r) => setTimeout(r, 3000)); expect(widget).toBe(2); }, 200);\ntest("after it", () => { expect(widget).toBe(2); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
      expect(j.cause).toBe("timeout");
      // composeFailureKind reads /timed out after \d+ms/ in a verify output as "environment" (a NON-ATTEMPT).
      expect(typeof detailOf).toBe("function");
      expect(detailOf!(j)).not.toMatch(/timed out after \d+\s*ms/i);
    });

    t("[MUST-FAIL] a timeout's trailer line is attributed to the test that timed out, not the next one", () => {
      expect(typeof classify).toBe("function");
      const root = vessel("tw-trailer", `import { widget } from "../../src/x";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 3000)); }, 200);\ntest("next one", () => { expect(widget).toBe(2); });\n`);
      const p = Bun.spawnSync([bin, "test", `./test/checks/${checkFile("tw-trailer")}`], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      const c = classify!(new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr));
      expect(c.failures.find((f) => f.name === "slow")).toMatchObject({ cls: "wrong_reason", cause: "timeout" });
      expect(c.failures.find((f) => f.name === "next one")).toMatchObject({ cls: "assertion" });
    });

    t("[MUST-FAIL] a failure bun prints twice (the multi-file \"N tests failed:\" recap) is classified once, by its first block", () => {
      expect(typeof classify).toBe("function");
      const root = vessel("tw-recap", `import { widget } from "../../src/x";\n${Array.from({ length: 12 }, (_, i) => `test("many ${i}", () => { expect(widget).toBe(${i + 2}); });`).join("\n")}\n`);
      const p = Bun.spawnSync([bin, "test", `./test/checks/${checkFile("tw-recap")}`], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      const raw = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      // measured: a single-file run prints no recap (12 and 15 failures, 1.3.14 and 1.4.2); a whole-suite run does
      const fails = raw.split("\n").filter((l) => l.startsWith("(fail) "));
      expect(fails.length).toBe(12);
      const c = classify!(raw + `\n12 tests failed:\n${fails.join("\n")}\n`);
      expect(c.failures.length).toBe(12);
      expect(c.failures.every((f) => f.cls === "assertion")).toBe(true);
    });

    t("[MUST-FAIL] (qa nocmp) a check that THROWS an Error whose message mimics an expect() line is not an assertion, in the verify and at the arm", async () => {
      // bun prints a thrown Error as `error: <message>`, so this error line also starts `error: expect(`; only the
      // missing Expected/Received block tells it from a real assertion failure.
      const body = `import * as mod from "../../src/x";\ntest("forged", () => { if (mod.widget !== 2) throw new Error("expect(received).toBe(expected)"); });\n`;
      const j = await verdict("tw-forged", body);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
      expect(j.cause).toBe("non_assertion");
      const root = vessel("tw-forged-arm", body);
      const raw = await runner(bin, root)(`test/checks/${checkFile("tw-forged-arm")}`);
      expect(raw).toMatch(/^error: expect\(received\)\.toBe\(expected\)$/m);
      const c = classify!(raw);
      expect(c.failures).toEqual([expect.objectContaining({ name: "forged", cls: "wrong_reason", cause: "non_assertion" })]);
      expect(typeof armRefusal).toBe("function");
      expect(armRefusal!(c, ["forged"])).toMatchObject({ cause: "non_assertion" });
    });

    t("[MUST-FAIL] (qa budget) a wrong-reason run 1 stops the verify: exactly 1 run recorded, stage and cause unchanged", async () => {
      expect(typeof judge).toBe("function");
      const root = vessel("tw-budget-wrong", `import { widget } from "../../src/x";\nimport { y } from "../../src/absent";\ntest("mm", () => { expect(widget + y).toBe(2); });\n`);
      let calls = 0;
      const base = runner(bin, root);
      const j = await judge!({ gapId: "tw-budget-wrong", vesselRoot: root, editSite: SITE, run: async (rel) => { calls += 1; return base(rel); }, runs: 3 });
      expect(j).toMatchObject({ ok: false, stage: "test_writing_check_wrong_reason", cause: "module" });
      expect(calls).toBe(1);
      expect(j.runs.length).toBe(1);
    });

    t("[MUST-FAIL] (qa budget) a GREEN run 1 stops the verify: exactly 1 run, not_red", async () => {
      const root = vessel("tw-budget-green", `import { widget } from "../../src/x";\ntest("g", () => { expect(widget).toBe(1); });\n`);
      let calls = 0;
      const base = runner(bin, root);
      const j = await judge!({ gapId: "tw-budget-green", vesselRoot: root, editSite: SITE, run: async (rel) => { calls += 1; return base(rel); }, runs: 3 });
      expect(j.stage).toBe("test_writing_check_not_red");
      expect(calls).toBe(1);
      expect(j.runs.length).toBe(1);
    });

    t("[CONTROL] (qa budget) an assertion-red check still records 3 runs", async () => {
      const root = vessel("tw-budget-red", `import { widget } from "../../src/x";\ntest("r", () => { expect(widget).toBe(2); });\n`);
      let calls = 0;
      const base = runner(bin, root);
      const j = await judge!({ gapId: "tw-budget-red", vesselRoot: root, editSite: SITE, run: async (rel) => { calls += 1; return base(rel); }, runs: 3 });
      expect(j).toMatchObject({ ok: true, stage: null });
      expect(calls).toBe(3);
      expect(j.runs.length).toBe(3);
    });

    t("[MUST-FAIL] (qa budget) a red run 1 then a GREEN run 2 stops at 2 runs, flaky", async () => {
      const counter = join(mkdtempSync(join(tmpdir(), "tw-budget-counter-")), "n");
      writeFileSync(counter, "0");
      const root2 = vessel("tw-budget-flip", `import { readFileSync, writeFileSync } from "node:fs";\nimport { widget } from "../../src/x";\nconst n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")); writeFileSync(${JSON.stringify(counter)}, String(n + 1));\ntest("flip", () => { expect(n === 0 ? widget : 2).toBe(2); });\n`);
      let calls2 = 0;
      const base2 = runner(bin, root2);
      const j2 = await judge!({ gapId: "tw-budget-flip", vesselRoot: root2, editSite: SITE, run: async (rel) => { calls2 += 1; return base2(rel); }, runs: 3 });
      expect(j2.stage).toBe("test_writing_check_flaky");
      expect(calls2).toBe(2);
    });

    t("[MUST-FAIL] a ReferenceError and a plain throw are not assertions: wrong_reason", async () => {
      const a = await verdict("tw-ref", `import { widget } from "../../src/x";\ntest("ref red", () => { // @ts-ignore\n expect(widget + nope).toBe(1); });\n`);
      expect(a.stage).toBe("test_writing_check_wrong_reason");
      const b = await verdict("tw-throw", `import { widget } from "../../src/x";\ntest("throw red", () => { if (widget === 1) throw new Error("plain"); });\n`);
      expect(b.stage).toBe("test_writing_check_wrong_reason");
    });

    t("[CONTROL] an assertion red identical across 3 runs PASSES verify, naming the edit site it imports", async () => {
      const j = await verdict("tw-red", `import { widget } from "../../src/x";\ntest("widget is two", () => { expect(widget).toBe(2); });\ntest("object shape", () => { expect({ a: widget }).toEqual({ a: 2 }); });\n`);
      expect(j).toMatchObject({ ok: true, stage: null, check_file: `test/checks/${checkFile("tw-red")}`, edit_site: "src/x.ts" });
      expect(j.runs.length).toBe(3);
      expect(j.runs.every((r) => r.verdict === "assertion_red")).toBe(true);
    });

    t("[MUST-FAIL] an assertion red whose failure SET differs on the second run (counter fixture) is refused: test_writing_check_flaky", async () => {
      const counter = join(mkdtempSync(join(tmpdir(), "tw-counter-")), "n");
      writeFileSync(counter, "0");
      const j = await verdict("tw-flaky", `import { readFileSync, writeFileSync } from "node:fs";\nimport { widget } from "../../src/x";\nconst n = Number(readFileSync(${JSON.stringify(counter)}, "utf8")); writeFileSync(${JSON.stringify(counter)}, String(n + 1));\ntest("odd run red", () => { expect(n % 2 === 0 ? widget : 2).toBe(2); });\ntest("even run red", () => { expect(n % 2 === 1 ? widget : 2).toBe(2); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_flaky");
      expect(Number(readFileSync(counter, "utf8"))).toBeGreaterThanOrEqual(2);
    });

    t("[CONTROL] a Received carrying a timestamp that differs across runs, same name and error class, is NOT flaky (passes)", async () => {
      const j = await verdict("tw-stamp", `import { widget } from "../../src/x";\ntest("stamped", () => { expect(\`\${widget}@\${new Date().toISOString()}@\${Math.random()}\`).toBe("2"); });\n`);
      expect(j).toMatchObject({ ok: true, stage: null });
    });

    t("[CONTROL] colour output (ANSI) is stripped before classifying", async () => {
      const j = await verdict("tw-ansi", `import { widget } from "../../src/x";\ntest("widget is two", () => { expect(widget).toBe(2); });\n`, SITE, {}, { FORCE_COLOR: "1" });
      expect(j).toMatchObject({ ok: true, stage: null });
    });

    // qa: "X must exist" gaps.
    t("[CONTROL] (qa a) a NAMESPACE import of a missing export, asserted with typeof, is an assertion red x3 and passes", async () => {
      const j = await verdict("tw-ns", `import * as mod from "../../src/x";\ntest("newThing exists", () => { expect(typeof (mod as Record<string, unknown>)["newThing"]).toBe("function"); });\n`);
      expect(j).toMatchObject({ ok: true, stage: null, edit_site: "src/x.ts" });
    });

    t("[MUST-FAIL] (qa b) a NAMED import of the same missing export is refused wrong_reason (missing_export) and the reason teaches the namespace import", async () => {
      const j = await verdict("tw-named", `import { newThing } from "../../src/x";\ntest("newThing exists", () => { expect(typeof newThing).toBe("function"); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_wrong_reason");
      expect(j.cause).toBe("missing_export");
      expect(j.reason).toContain("import * as mod");
      expect(j.reason).toContain("typeof");
    });

    // W2: the check must import the gap's edit site.
    t("[MUST-FAIL] W2: an assertion red that does not import the edit site is refused: test_writing_check_misses_edit_site", async () => {
      const j = await verdict("tw-noimport", `test("trivial", () => { expect(1).toBe(2); });\n`);
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("test_writing_check_misses_edit_site");
    });

    t("[CONTROL] W2: a dynamic import(...) of the edit site counts (passes)", async () => {
      const j = await verdict("tw-dyn", `test("dyn", async () => { const m = await import("../../src/x.ts"); expect(m.widget).toBe(2); });\n`);
      expect(j).toMatchObject({ ok: true, stage: null });
    });

    t("[MUST-FAIL] W2: an edit_site that is not a TS/JS module (foo.sh) is refused: edit_site_not_importable", async () => {
      const j = await verdict("tw-sh", `import { widget } from "../../src/x";\ntest("red", () => { expect(widget).toBe(2); });\n`, "repos/fixture-vessel/scripts/foo.sh", { "scripts/foo.sh": "#!/bin/sh\necho hi\n" });
      expect(j.ok).toBe(false);
      expect(j.stage).toBe("edit_site_not_importable");
    });

    t("[CONTROL] W2: a gap with NO edit site passes when the check imports an existing src module, which becomes its edit site", async () => {
      const j = await verdict("tw-nosite", `import { f } from "../../src/x.js";\ntest("f is two", () => { expect(f()).toBe(2); });\n`, null);
      expect(j).toMatchObject({ ok: true, stage: null, edit_site: "src/x.ts" });
    });

    t("[MUST-FAIL] W2: a gap with NO edit site and a check importing no src module is refused: misses_edit_site", async () => {
      const j = await verdict("tw-nosite-noimport", `test("trivial", () => { expect(1).toBe(2); });\n`, null);
      expect(j.stage).toBe("test_writing_check_misses_edit_site");
    });

    t("[MUST-FAIL] a check file that was never written is refused: test_writing_check_not_red (not run, nothing executed)", async () => {
      expect(typeof judge).toBe("function");
      const root = vessel("tw-other-name", `test("x", () => { expect(1).toBe(2); });\n`);
      let ran = 0;
      const j = await judge!({ gapId: "tw-absent", vesselRoot: root, editSite: SITE, run: async () => { ran += 1; return ""; }, runs: 3 });
      expect(j.stage).toBe("test_writing_check_not_red");
      expect(ran).toBe(0);
    });

    t("[CONTROL] the default suite NEVER runs the .check.ts: a red check beside a green *.test.ts reads green", () => {
      const root = vessel("tw-default", `import { widget } from "../../src/x";\ntest("intended red", () => { expect(widget).toBe(2); });\n`, { "test/a.test.ts": `${H}import { widget } from "../src/x";\ntest("ordinary green", () => { expect(widget).toBe(1); });\n` });
      const p = Bun.spawnSync([bin, "test"], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
      const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      expect(out).toContain("ordinary green");
      expect(out).not.toContain("intended red");
      expect(out).toMatch(/\b1 pass\b/);
      expect(out).toMatch(/\b0 fail\b/);
      expect(p.exitCode).toBe(0);
    });
  });
}

describe("bun 1.4.2 availability", () => {
  (ALT_PRESENT ? test.skip : test)("skipped: bun 1.4.2 not found (its cases above did not run)", () => {
    console.warn(`[test-writing-check-verify] skipped: bun 1.4.2 not found at ${ALT_BUN}`);
  });
});

// WIRING (pinned by source: no harness drives resolveFeatureCompose's verify past the planner without an LLM).
const FC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts"), "utf-8");
const TEST_OK = "const testOk = confirmedNewTest.length === 0 && !passRegressed && !summaryMissing;";
describe("feature-compose verify: the test_writing check is judged after the suite gate and gates `ok`", () => {
  test("[MUST-FAIL] judgeTestWritingCheck runs after the full-suite testOk and before `const ok`, which requires it", () => {
    const testOk = FC.indexOf(TEST_OK);
    const call = FC.indexOf("judgeTestWritingCheck({");
    const ok = FC.indexOf("const ok = installOk && dryRunOk && tcOk && sdOk && testOk && ownOk && testWritingOk;");
    expect(testOk).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(testOk);
    expect(ok).toBeGreaterThan(call);
  });

  test("[MUST-FAIL] only in compose_mode test_writing, only on a typecheck-clean draft, 3 runs of ./<check> alone with the own-check's env and a 240 s shell budget", () => {
    const call = FC.indexOf("judgeTestWritingCheck({");
    const block = FC.slice(Math.max(0, call - 1500), call + 1500);
    expect(block).toContain("if (testWritingMode && tcOk)");
    expect(block).toContain("runs: csaV.TEST_WRITING_CHECK_RUNS");
    expect(block).toContain('bun test ${shq("./" + rel)} --timeout 20000');
    // The own-check's env is the shared scrubbed prefix (src/test-child-env.ts), no longer an inline `env -i` copy.
    expect(block).toContain("timeout 180 ${testChildEnvShellPrefix()} bun test");
    expect(block).toContain("timeout_sec: 240");
    expect(block).toContain("[fc-test-writing-check]");
    expect(FC).toMatch(/const testWritingMode = \(pointer as \{ compose_mode\?: unknown \}\)\.compose_mode === csaV\.CHECK_SUPPLY_COMPOSE_MODE;/);
  });

  test("[MUST-FAIL] the verify reads the edit site the ARM step reads: the supply ledger's only (never the gap's own edit_site behind it)", () => {
    // gap-check-supply arms with checkImportsEditSite(…, ledger.edit_site ?? null, …). ledger.edit_site is null exactly
    // when the gap's own edit_site is unusable (another vessel, not in the clone, not src): demanding it here would be
    // a refusal the drafter cannot cure, of a check the arm would accept.
    const call = FC.indexOf("judgeTestWritingCheck({");
    const block = FC.slice(call, call + 800);
    expect(block).toContain("editSite: twLedger.edit_site ?? null,");
    expect(block).not.toContain("twMeta.edit_site");
  });

  test("[CONTROL] the full-suite gate is UNCHANGED for every mode (a .check.ts is never discovered, so 'no new reds' holds by itself)", () => {
    expect(FC.split(TEST_OK).length).toBe(2);
    expect(FC).toContain("const curTest = testFailureSet(testRaw);");
    // the gate's inputs are mode-blind: no compose_mode read between the suite run and testOk
    const suite = FC.indexOf("command: composeVerifyCommand(vAbs, SHARED_DISPATCH_CHECK),");
    expect(FC.slice(suite, FC.indexOf(TEST_OK))).not.toContain("compose_mode");
  });

  test("[MUST-FAIL] a refused check carries its named stage on the verify result and only its classified detail in `output`", () => {
    expect(FC).toContain("...(testWriting ? { test_writing: testWriting } : {})");
    expect(FC).toContain("(testWritingOk ? \"\" : csaV.testWritingDetail(testWriting!))");
  });

  test("[MUST-FAIL] strayTestEdits allows the gap's own check file in test_writing mode, and only then", () => {
    expect(FC).toContain("strayTests = strayTestEdits(v, editedRel, gapMeta, [...(!own && specIsIntent ? specPaths : []), ...(testWritingMode ? [csaV.checkSupplyCheckPath(String(pointer.gap?.id ?? \"\"))] : [])]);");
  });
});
