// test_suite runs `test_file` as a PATH, never as a bun filter (2026-10-08).
//
// bun treats a bare positional argument as a FILTER over the files it discovers (substring match on the
// path), not as a path. Measured on bun 1.3.14 and 1.4.2:
//   - `bun test "test/checks/gap-x.check.ts"` prints "The following filters did not match any test files …
//     To treat the … filter as a path, run bun test ./test/checks/gap-x.check.ts" and NO summary: a file
//     that is not named *.test.* / *.spec.* never ran, so its check read ran:false / requested_not_passing
//     null forever — unknown, never red and never green;
//   - `bun test "test/a/x.test.ts"` also runs `pkg/test/a/x.test.ts` (the path contains the filter), so a
//     check's counts included another file's tests.
// A `./`-prefixed argument is a path: exactly that file runs. feature_compose's own-check runs already pass
// `"./" + test_file`; this pins the same for the resolver every gap check, the cutover's own-check, the
// staged-mitosis gate and scope earn-in go through.
//
// These tests EXECUTE the resolver's real shell command (only the vessel root is pointed at a fixture under
// TMPDIR) with whichever `bun` is first on PATH, and feed bun's real output back through the stubbed shell
// transport — so the verdicts are bun's, not a transcript of them.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestSuite } from "../../src/resolvers/test-suite.js";

const HEADER = `import { describe, expect, test } from "bun:test";\n`;
const fixture = mkdtempSync(join(tmpdir(), "test-suite-file-path-"));
function put(rel: string, body: string): void {
  mkdirSync(join(fixture, rel, ".."), { recursive: true });
  writeFileSync(join(fixture, rel), HEADER + body);
}
// node_modules present so the command never runs `bun install` in the fixture.
mkdirSync(join(fixture, "node_modules"), { recursive: true });
put("test/checks/gap-x.check.ts", `test("gap x red case", () => expect(1).toBe(2));\ntest("gap x green case", () => expect(1).toBe(1));\n`);
put("test/a/x.test.ts", `test("A only case", () => expect(1).toBe(1));\n`);
// Shares a path SUFFIX with test/a/x.test.ts, and is red: a bare filter runs it and counts its failure.
put("pkg/test/a/x.test.ts", `test("NESTED only case", () => expect(1).toBe(2));\n`);
put("test/normal.test.ts", `describe("Normal", () => { test("first case", () => expect(1).toBe(1)); test("second case", () => expect(2).toBe(2)); test("third case", () => expect(3).toBe(4)); });\n`);

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(fixture, { recursive: true, force: true });
});

type Run = { body: Record<string, unknown>; shape: string; command: string; output: string };

/** Resolve with the shell stub EXECUTING the command against the fixture; `output` is what bun printed. */
async function run(pointer: Record<string, unknown>): Promise<Run> {
  let command = "";
  let output = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("vesselCapability")) {
      return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }), { status: 200 });
    }
    if (String(input).startsWith("http://shell.test")) {
      command = String(JSON.parse(body).impulse.pointer.command ?? "");
      const local = command.replace(/^ROOT='[^']*'/, `ROOT='${fixture}'`);
      const p = Bun.spawnSync(["bash", "-c", local], {
        cwd: fixture,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
        stdout: "pipe",
        stderr: "pipe",
      });
      output = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      return new Response(JSON.stringify({ stdout: output }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const r = await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
    return { body: (r.body ?? {}) as Record<string, unknown>, shape: r.shape, command, output };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("test_suite — test_file is run as a path, not a bun filter", () => {
  test("[must-fail] a .check.ts test_file runs and its red assertion is NAMED", async () => {
    const r = await run({ test_file: "test/checks/gap-x.check.ts" });
    // A real bun ran, and it is the same bun as this runner (PATH decides both): the header names the version measured.
    expect(r.output).toContain(`bun test v${Bun.version}`);
    expect(r.body).toMatchObject({ ran: true, total: 2, pass: 1, fail: 1, test_file: "test/checks/gap-x.check.ts" });
    expect(r.body["failingTests"]).toEqual(["(fail) gap x red case"]);
  });

  test("[must-fail] the same with only_tests = the red title counts it as not passing", async () => {
    const r = await run({ test_file: "test/checks/gap-x.check.ts", only_tests: ["gap x red case"] });
    expect(r.body).toMatchObject({ ran: true, fail: 1, requested_not_passing: 1 });
    expect(r.body["filter_matched_none"]).toBeUndefined();
  });

  test("[must-fail] a test_file that is a path suffix of another file runs ONLY that file", async () => {
    const r = await run({ test_file: "test/a/x.test.ts" });
    expect(r.body).toMatchObject({ ran: true, total: 1, pass: 1, fail: 0 });
    expect(r.output).toContain("A only case");
    expect(r.output).not.toContain("NESTED only case");
    expect(r.output).toMatch(/Ran 1 test across 1 file/);
  });

  test("[must-fail] a test_file with '..' or an absolute path is refused by name, and nothing runs", async () => {
    for (const bad of ["../development-vessel/test/a/x.test.ts", "test/../test/a/x.test.ts", "/etc/passwd", `${fixture}/test/a/x.test.ts`, "./", "test/a/x.test.ts; id"]) {
      const r = await run({ test_file: bad });
      expect(r.shape).toBe("structuredError");
      expect(r.body).toMatchObject({ resolver: "test_suite", failure_mode: "validation_rejected", field: "test_file" });
      expect(r.command).toBe(""); // the shell was never called
    }
  });

  test("[must-fail] a './'-prefixed test_file is accepted once, never doubled", async () => {
    const r = await run({ test_file: "./test/a/x.test.ts" });
    expect(r.command).toContain(`bun test "./test/a/x.test.ts" --timeout`);
    expect(r.command).not.toContain("././");
    expect(r.body).toMatchObject({ ran: true, total: 1, test_file: "test/a/x.test.ts" });
  });

  test("[control] a missing test_file stays ran:false", async () => {
    const r = await run({ test_file: "test/absent.test.ts", only_tests: ["anything"] });
    expect(r.shape).toBe("test_suite");
    expect(r.body).toMatchObject({ ran: false, requested_not_passing: null });
  });

  test("[control] an ordinary test/normal.test.ts reads the same counts", async () => {
    const r = await run({ test_file: "test/normal.test.ts" });
    expect(r.body).toMatchObject({ ran: true, total: 3, pass: 2, fail: 1 });
    expect(r.body["failingTests"]).toEqual(["(fail) Normal > third case"]);
    const named = await run({ test_file: "test/normal.test.ts", only_tests: ["Normal > first case", "Normal > third case"] });
    expect(named.body).toMatchObject({ ran: true, requested_not_passing: 1 });
  });

  test("[control] a loadable file with none of the named tests still reads filter_matched_none", async () => {
    const r = await run({ test_file: "test/normal.test.ts", only_tests: ["absent one", "Normal > absent two"] });
    expect(r.output).toMatch(/^error: regex .* matched 0 tests\. Searched 1 file/m);
    expect(r.body).toMatchObject({ ran: false, requested_not_passing: 2, filter_matched_none: true });
  });
});
