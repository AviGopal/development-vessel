// A SHELL CHECK (test-suite.ts): a test_suite check at a super-repo validation/scripts/*.check.sh is measured, the way
// the glue runner runs it, instead of being handed to `bun test` (which cannot run it, so every such gap was born
// unknown and held). The check prints `ok   - <label>` / `FAIL - <label>` and exits non-zero on any FAIL; the gap
// names its labels in only_tests and reads zero_field requested_not_passing, the same contract as a bun check.
//
// The commands test_suite builds are EXECUTED here (bash, in a temp super-repo clone), and checked against the
// sibling local-tools vessel's real shell gate. The judge is the real one, its self-resolve answered by the real
// resolver. Must-fail: a red check is measured present, a green one absent, a missing file measured:false (unknown).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const BASE = realpathSync(mkdtempSync(join(tmpdir(), "shell-check-")));
const SUPER = join(BASE, "git", "super-repo");
process.env["MITOSIS_REPO_ROOT"] = SUPER; // test_suite's super-repo root (read at its module load)
process.env["WORKSPACE_ROOT"] = join(BASE, "ws");
const testSuite = await import("../../src/resolvers/test-suite.js");
const { evaluateGapCheck } = await import("../../src/judge/gap-check-judge.js");
const { __resetPolicyReadsForTests } = await import("../../src/judge/gap-policy.js");
const { checkArmingProblem, birthCheckRepo } = await import("../../src/resolvers/substrate-gap.js");

type Row = Record<string, unknown>;
const REPO = resolve(import.meta.dir, "..", "..");
// The sibling gate: repos/<v> in the super-repo, /workspace/git/vessels/<v> in the clones.
const GATE = [resolve(REPO, "..", "local-tools-vessel", "src", "shell-containment.ts"), "/workspace/git/vessels/local-tools-vessel/src/shell-containment.ts"].find((p) => existsSync(p));
const RED = "validation/scripts/widget-red.check.sh";
const GREEN = "validation/scripts/widget-green.check.sh";
const MUTE = "validation/scripts/widget-mute.check.sh";
// The docs-drift checks' shape: refuse without bun (exit 2), else run bun, print cases and a RED/GREEN summary.
const NEEDS_BUN = "validation/scripts/widget-needs-bun.check.sh";
const REFUSES = "validation/scripts/widget-refuses.check.sh";
const script = (lines: string[], exit: number) => `#!/usr/bin/env bash\n${lines.map((l) => `echo "${l}"`).join("\n")}\necho "TMPDIR=$TMPDIR WORKSPACE_ROOT=$WORKSPACE_ROOT"\nexit ${exit}\n`;

const commands: string[] = [];
const realFetch = globalThis.fetch;
let savedStore: string | undefined;
beforeAll(() => {
  savedStore = process.env["GAP_STORE_ENDPOINT"]; delete process.env["GAP_STORE_ENDPOINT"];
  mkdirSync(join(SUPER, "validation", "scripts"), { recursive: true });
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  mkdirSync(join(BASE, "ws"), { recursive: true });
  writeFileSync(join(SUPER, ".gitmodules"), "");
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), "{}");
  writeFileSync(join(SUPER, RED), script(["ok   - the widget counts frames", "FAIL - the widget rejects a short frame (got: 3)"], 1));
  writeFileSync(join(SUPER, GREEN), script(["ok   - the widget counts frames", "ok   - the widget rejects a short frame (got: 0)"], 0));
  writeFileSync(join(SUPER, MUTE), script(["needs curl, jq and bun"], 2));
  writeFileSync(join(SUPER, NEEDS_BUN), `#!/usr/bin/env bash\nset -uo pipefail\nROOT="\${1:-$(cd "$(dirname "$0")/../.." && pwd)}"\ncommand -v bun >/dev/null || { echo "REFUSED: bun not found"; exit 2; }\nexec bun -e 'const fs = require("fs"); const ok = fs.existsSync(process.argv[1] + "/validation/scripts"); console.log((ok ? "ok   - " : "FAIL - ") + "the repo root is the super-repo root"); console.log("FAIL - the widget rejects a short frame"); console.log("RED: 1 failing"); process.exit(1);' "$ROOT"\n`);
  writeFileSync(join(SUPER, REFUSES), script(["ok   - the widget counts frames", "REFUSED: cannot read docs/widget.md"], 2));
  for (const f of [RED, GREEN, MUTE, NEEDS_BUN, REFUSES]) chmodSync(join(SUPER, f), 0o755);
  const git = (...a: string[]) => execFileSync("git", ["-C", SUPER, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "fixture");
  // The live checkout's WORKING STATE differs from its commit: the green check is made red, uncommitted. A hermetic
  // run measures the committed tree, so the green check must still read green.
  writeFileSync(join(SUPER, GREEN), script(["FAIL - the widget counts frames", "FAIL - the widget rejects a short frame"], 1));
  // Discovery names one shell producer; the shell runs the command for real, with the super-repo as its cwd.
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (body?.pointer?.type === "vesselCapability") return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    const cmd = String(body?.impulse?.pointer?.command ?? "");
    if (body?.impulse?.pointer?.type !== "shell" || !cmd) return new Response("not found", { status: 404 });
    commands.push(cmd);
    // Only a shell-check command is executed; anything else (a bun run) is answered, never run against a live clone.
    if (!cmd.includes("archive --format=tar")) return Response.json({ stdout: "" });
    const r = spawnSync("bash", ["-c", cmd], { cwd: SUPER, encoding: "utf8", timeout: 60_000 });
    return Response.json({ stdout: r.stdout, stderr: r.stderr, exitCode: r.status });
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedStore === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = savedStore;
  __resetPolicyReadsForTests();
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* noop */ }
});

const run = (testFile: string, onlyTests: string[]) => testSuite.resolveTestSuite({ type: "test_suite", vessel: "super-repo", test_file: testFile, only_tests: onlyTests, timeout_ms: 60_000 });
const check = (testFile: string, onlyTests: string[]) => ({ shape: "test_suite", input: { vessel: "super-repo", test_file: testFile, only_tests: onlyTests, timeout_ms: 60_000 }, zero_field: "requested_not_passing" });
// The judge's self-resolve, answered by the real resolver.
const selfResolve = (async (_u: unknown, init?: RequestInit) => {
  const p = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer ?? {};
  return Response.json(await testSuite.resolveTestSuite(p));
}) as unknown as typeof fetch;
const judge = (id: string, er: Row) => evaluateGapCheck({ id, classification_metadata: { evidence_resolve: er, falsifier: "class2" } }, { fetchImpl: selfResolve });
const LABELS = ["the widget counts frames", "the widget rejects a short frame"];

describe("a super-repo *.check.sh is measured by test_suite", () => {
  it("the case lines are read as the checks print them (gate-test-lib's ok/bad convention)", () => {
    expect(testSuite.parseShellCheck("ok   - a holds\nFAIL - b holds (got: 3)\nok - not a case\nRED: 1 failing\n")).toEqual({ ok: ["a holds"], fail: ["b holds (got: 3)"] });
  });

  it("MUST-FAIL: a red check is measured: requested_not_passing counts the label with no ok line; the judge reads present", async () => {
    const b = (await run(RED, LABELS)).body as Row;
    expect(b).toMatchObject({ ran: true, total: 2, pass: 1, fail: 1, check_exit: 1, requested_not_passing: 1 });
    expect(b["failingTests"]).toEqual(["the widget rejects a short frame (got: 3)"]);
    expect(await judge("shell-red", check(RED, LABELS))).toBe("present");
  });

  it("MUST-FAIL: a green check reads absent, measured on the COMMITTED tree (the working-state red edit is not seen)", async () => {
    const b = (await run(GREEN, LABELS)).body as Row;
    expect(b).toMatchObject({ ran: true, total: 2, pass: 2, fail: 0, check_exit: 0, requested_not_passing: 0 });
    expect(await judge("shell-green", check(GREEN, LABELS))).toBe("absent");
  });

  it("MUST-FAIL: a file that is not in the tree is measured:false (unknown), never a zero", async () => {
    const b = (await run("validation/scripts/no-such.check.sh", LABELS)).body as Row;
    expect(b).toMatchObject({ ran: false, measured: false, requested_not_passing: null });
    expect(String(b["why"])).toContain("not in");
    expect(await judge("shell-missing", check("validation/scripts/no-such.check.sh", LABELS))).toBe("unknown");
  });

  it("a check that printed no case line is measured:false (unknown)", async () => {
    const b = (await run(MUTE, LABELS)).body as Row;
    expect(b).toMatchObject({ ran: false, measured: false, check_exit: 2, requested_not_passing: null });
    expect(await judge("shell-mute", check(MUTE, LABELS))).toBe("unknown");
  });

  it("MUST-FAIL: exit 2 / REFUSED is unknown, never present or absent, even after a case line", async () => {
    const b = (await run(REFUSES, LABELS)).body as Row;
    expect(b).toMatchObject({ ran: false, measured: false, check_exit: 2, requested_not_passing: null });
    expect(String(b["why"])).toContain("REFUSED");
    expect(await judge("shell-refused", check(REFUSES, LABELS))).toBe("unknown");
  });

  it("a check that runs bun itself finds it on PATH under the scrubbed env, with the super-repo root as its repo root", async () => {
    const labels = ["the repo root is the super-repo root", "the widget rejects a short frame"];
    const b = (await run(NEEDS_BUN, labels)).body as Row;
    expect(b).toMatchObject({ ran: true, check_exit: 1, pass: 1, fail: 1, requested_not_passing: 1 });
    expect(await judge("shell-bun", check(NEEDS_BUN, labels))).toBe("present");
  });

  it("the birth tree of a super-repo check is the super-repo clone (WHICH TREE)", () => {
    expect(birthCheckRepo({ evidence_resolve: check(RED, LABELS) })).toEqual({ dir: SUPER, files: [RED] });
  });

  it("a named label the check never prints is not passing (renamed or deleted counts, as for a bun test)", async () => {
    const b = (await run(GREEN, [...LABELS, "a case that was deleted"])).body as Row;
    expect(b["requested_not_passing"]).toBe(1);
  });

  it("hermetic: the run leaves the super-repo's working state as it was and runs under a scrubbed env with its own TMPDIR", async () => {
    const before = execFileSync("git", ["-C", SUPER, "status", "--porcelain"], { encoding: "utf8" });
    const raw = spawnSync("bash", ["-c", commands[commands.length - 1]!], { cwd: SUPER, encoding: "utf8" }).stdout;
    expect(execFileSync("git", ["-C", SUPER, "status", "--porcelain"], { encoding: "utf8" })).toBe(before);
    expect(before.trim()).toBe(`M ${GREEN}`); // only the fixture's own uncommitted edit
    const env = /TMPDIR=(\S*) WORKSPACE_ROOT=(\S*)/.exec(raw);
    expect(env?.[1]).toMatch(/^\/tmp\/test-suite-check-tmp-/);
    expect(env?.[2]).toMatch(/^\/tmp\//);
    expect(env?.[2]).not.toBe(process.env["WORKSPACE_ROOT"]);
    expect(readdirSync("/tmp").filter((d) => d.startsWith("test-suite-check-")).length).toBe(0); // export and TMPDIR removed
  });

  it("the commands pass the live shell gate (local-tools shell-containment) with the super-repo as cwd", async () => {
    if (!GATE) throw new Error("the sibling local-tools-vessel gate is missing; this check runs test_suite's real commands through it");
    const { containShell } = await import(GATE);
    const gateEnv = { WORKSPACE_ROOT: SUPER, MITOSIS_RUNTIME_DIR: join(BASE, "vessels"), MITOSIS_PUSH_CLONE_DIR: join(BASE, "git", "vessels"), COMPOSE_WS_DIR: join(BASE, "git", "compose"), METABOB_API_KEY: "k" };
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) expect(containShell(cmd, SUPER, { env: gateEnv })).toMatchObject({ ok: true });
  });

  it("control: a .check.sh arming is valid at the write seam now that the instrument can run it; a non-test source file is not", () => {
    expect(checkArmingProblem(check(RED, LABELS))).toBeNull();
    expect(checkArmingProblem({ shape: "test_suite", input: { vessel: "development-vessel", test_file: "src/resolvers/test-suite.ts", only_tests: ["t"] }, zero_field: "requested_not_passing" })).toMatchObject({ position: "evidence_resolve.input.test_file" });
  });

  it("control: a bun test_file still runs through bun, not the shell-check path", async () => {
    const n = commands.length;
    await testSuite.resolveTestSuite({ type: "test_suite", vessel: "development-vessel", test_file: "test/x.test.ts", only_tests: ["t"] });
    expect(commands[n]).toContain("bun test");
    expect(commands[n]).not.toContain("archive");
  });
});
