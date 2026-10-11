// Per-resolver test for `test_suite` (R8.1: one test file per resolver).
//
// This resolver is the IN-BAND replacement for out-of-band post-landing verification.
// External CI runs in no vessel, produces no trace, and delivers its outcome through an
// env-gated webhook; host-pull-sync.sh detects regressions but writes only an operator log.
// Neither emits a shape, so no post-landing outcome was ever observable to the learning
// loop — which is why the fitness of a landed change could not be computed from activity
// outcomes.
//
// The previous version of this file asserted the resolver's original contract (call with a
// bare pointer, get a report). Those two tests had NEVER passed: the old implementation
// fetched /api/test-store/summaries, an endpoint that exists nowhere in the fleet, so every
// call threw. They are replaced here with tests of the contract that actually runs.
import { afterAll, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onlyTestsPattern, parseBunSummary, resolveTestSuite } from "../../src/resolvers/test-suite.js";

// The -t pattern travels base64-encoded and is decoded by the shell into one argv element (names never
// appear as shell text; see test-suite-only-tests-no-shell-injection.test.ts). This reads it back.
const PATTERN_RE = /--test-name-pattern="\$\(printf %s '([A-Za-z0-9+/=]*)' \| base64 -d\)"/;
function namePattern(cmd: string): string | null {
  const m = PATTERN_RE.exec(cmd);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : null;
}

describe("parseBunSummary", () => {
  const REAL = ` 155 pass\n 4 fail\n 321 expect() calls\nRan 159 tests across 7 files. [232.00ms]`;

  it("reads counts from bun's summary lines", () => {
    const r = parseBunSummary(REAL);
    expect(r.pass).toBe(155);
    expect(r.fail).toBe(4);
    expect(r.total).toBe(159);
  });

  it("handles a summary carrying skip/todo lines", () => {
    const r = parseBunSummary(` 7 skip\n 5 todo\n 152 fail\n 82 pass\n`);
    expect(r.pass).toBe(82);
    expect(r.fail).toBe(152);
    expect(r.skip).toBe(7);
  });

  // The load-bearing property. A suite that fails to LOAD emits FEWER per-test lines, not
  // more, so counting (fail) lines cannot distinguish "tests were fixed" from "tests were
  // deleted or the module stopped importing". Reading `pass` from the summary is what
  // catches coverage disappearing — the cheapest way for an autonomous draft to go green.
  it("surfaces a COLLAPSED pass count instead of inferring health from few failures", () => {
    const collapsed = parseBunSummary(` 0 pass\n 1 fail\n`);
    expect(collapsed.pass).toBe(0);
    expect(collapsed.pass).toBeLessThan(parseBunSummary(REAL).pass);
    // Strictly FEWER failures than the 4-fail baseline, yet plainly worse.
    expect(collapsed.fail).toBeLessThan(parseBunSummary(REAL).fail);
  });

  it("collects failing test names with bun's timing suffix stripped", () => {
    const r = parseBunSummary(`(fail) repairSignatureOf > is deterministic [0.11ms]\n 1 pass\n 1 fail\n`);
    expect(r.failingTests).toEqual(["(fail) repairSignatureOf > is deterministic"]);
  });

  // bun prints each failure twice — inline, then again in the summary block. Without
  // dedupe, 9 real failures were reported as 18, overstating a regression to whatever reads
  // this shape.
  it("deduplicates failures that bun prints twice", () => {
    const dup = `(fail) a > one [0.1ms]\n(fail) b > two [0.2ms]\n 5 pass\n 2 fail\n(fail) a > one [0.1ms]\n(fail) b > two [0.2ms]\n`;
    const r = parseBunSummary(dup);
    expect(r.failingTests).toEqual(["(fail) a > one", "(fail) b > two"]);
    expect(r.fail).toBe(2);
  });

  it("returns zeros when the output carries no summary at all", () => {
    const r = parseBunSummary("bun: command not found");
    expect(r).toMatchObject({ total: 0, pass: 0, fail: 0, skip: 0 });
    expect(r.failingTests).toEqual([]);
  });
});

test("resolveTestSuite refuses without a vessel rather than reporting an empty suite", async () => {
  // Reporting 0/0/0 for a missing target would be indistinguishable from a clean run —
  // the same 'absence reads as success' defect this resolver exists to close.
  const result = await resolveTestSuite({ type: "test_suite" });
  expect(result).toHaveProperty("shape", "structuredError");
});

// ---- Isolation re-run filter (2026-08-29) ----
//
// `only_tests` exists for the precutover regression gate, which must confirm a failure
// before refusing. Confirming by re-running the WHOLE suite cannot discriminate a
// load-correlated flake — the second run carries the same load that produced the first.
// These pin the two properties that make the narrowed re-run trustworthy.
describe("test_suite — only_tests isolation filter", () => {
  const originalFetch = globalThis.fetch;

  async function captureCommand(pointer: Record<string, unknown>): Promise<string> {
    let captured = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) {
        return new Response(
          JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }),
          { status: 200 },
        );
      }
      if (url.startsWith("http://shell.test")) {
        captured = String(JSON.parse(body).impulse.pointer.command ?? "");
        return new Response(JSON.stringify({ stdout: " 1 pass\n 0 fail\n" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  }

  it("runs the whole suite when no names are supplied", async () => {
    const cmd = await captureCommand({});
    expect(cmd).toContain("bun test");
    expect(cmd).not.toContain(" -t ");
  });

  it("narrows to the named tests with -t", async () => {
    const cmd = await captureCommand({ only_tests: ["alpha case", "beta case"] });
    expect(namePattern(cmd)).toBe("alpha case|beta case");
  });

  // THE LOAD-BEARING PROPERTY. bun's -t is a regex. The real failure that motivated this
  // is titled "propose finds a closed cluster; apply + gate = PASS" — unescaped, the '+'
  // makes the pattern match NOTHING, the isolated re-run reports zero failures, and the
  // gate concludes "passed in isolation" and waves a genuine regression through. Silent,
  // and in the safe-looking direction.
  it("escapes regex metacharacters so a title with '+' matches literally", async () => {
    const cmd = await captureCommand({ only_tests: ["apply + gate = PASS"] });
    expect(namePattern(cmd)).toBe("apply \\+ gate = PASS");
  });

  // bun matches -t against the test name with describe and test joined by a SPACE, but only_tests carry bun's
  // printed " > " form ("Describe > test"). A full-path name therefore matched ZERO tests: bun printed
  // "matched 0 tests" and no summary, so every full-path check read ran:false and its gap never closed
  // (2026-09-30: all three verified landings of the afternoon, and every generator-filed gap).
  it("joins a full-path name's describe separator with a SPACE, the form bun's -t matches", async () => {
    const cmd = await captureCommand({ only_tests: ["Phase B1: suite > the leaf case"] });
    expect(namePattern(cmd)).toBe("Phase B1: suite the leaf case");
  });

  // BASE-TREE RUN (2026-09-30): the precutover gate asks whether a tracked-red test was already red
  // before the staged change. The run must happen on the COMMITTED ref in a detached worktree, never on
  // the clone's working tree (which holds the staged change), and an unvalidated ref must not reach git.
  it("runs on a detached worktree of base_ref, linking node_modules, and removes it", async () => {
    const cmd = await captureCommand({ only_tests: ["alpha case"], base_ref: "HEAD" });
    expect(cmd).toContain("worktree add -q --detach \"$BW\" HEAD");
    expect(cmd).toContain('ln -s "$ROOT/node_modules" "$BW/node_modules"');
    expect(cmd).toContain('(cd "$BW" && ');
    expect(cmd).toContain('worktree remove --force "$BW"');
    expect(namePattern(cmd)).toBe("alpha case");
    expect(cmd).not.toContain('cd "$ROOT"');
  });
  it("uses the working tree as before when no base_ref is given", async () => {
    const cmd = await captureCommand({ only_tests: ["alpha case"] });
    expect(cmd).not.toContain("worktree");
    expect(cmd).toContain('cd "$ROOT"');
  });
  it("ignores a base_ref that is not HEAD or a commit sha", async () => {
    for (const bad of ["HEAD; rm -rf /", "origin/dev", "$(id)", "abc"]) {
      const cmd = await captureCommand({ base_ref: bad });
      expect(cmd).not.toContain("worktree");
    }
    expect(await captureCommand({ base_ref: "956c79a3" })).toContain("--detach \"$BW\" 956c79a3");
  });

  it("ignores empty or non-string entries rather than emitting an empty pattern", async () => {
    // An empty alternation branch matches everything, which would silently restore the
    // whole-suite behaviour while claiming to be narrowed.
    const cmd = await captureCommand({ only_tests: ["", "   ", 42, null] });
    expect(cmd).not.toContain(" -t ");
    expect(namePattern(cmd)).toBeNull();
  });
});

// ---- Per-test timeout (2026-08-29) ----
//
// bun's 5000ms default is a LOAD SENSOR, not a correctness one. Measured across five runs of
// this vessel's suite at ONE commit with no code change: 94/95/96/97/97 failures, 10 of them
// literal "timed out after 5000ms", drifting with container load. precutover_regression
// compares a staged run against a stored baseline, so that drift manufactures regressions.
describe("test_suite — per-test timeout", () => {
  const originalFetch = globalThis.fetch;

  async function captureCommand(pointer: Record<string, unknown>): Promise<string> {
    let captured = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) {
        return new Response(
          JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }),
          { status: 200 },
        );
      }
      if (url.startsWith("http://shell.test")) {
        captured = String(JSON.parse(body).impulse.pointer.command ?? "");
        return new Response(JSON.stringify({ stdout: " 1 pass\n 0 fail\n" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", ...pointer });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return captured;
  }

  it("passes a per-test timeout well above bun's 5s default", async () => {
    const cmd = await captureCommand({});
    expect(cmd).toContain("--timeout 20000");
  });

  it("still bounds the WHOLE run, so a hung test cannot pass silently", async () => {
    // The per-test timeout is raised, not removed. `timeout <budget>` wraps the run.
    const cmd = await captureCommand({});
    // (the scrubbed-env prefix, src/test-child-env.ts, sits between `timeout` and `bun`)
    expect(cmd).toMatch(/timeout \d+ env -i [^;]*? bun test/);
  });

  it("accepts an explicit override", async () => {
    const cmd = await captureCommand({ per_test_timeout_ms: 45000 });
    expect(cmd).toContain("--timeout 45000");
  });

  it("ignores a non-positive or non-numeric override rather than emitting a broken flag", async () => {
    for (const bad of [0, -1, "20000", null]) {
      const cmd = await captureCommand({ per_test_timeout_ms: bad });
      expect(cmd).toContain("--timeout 20000");
    }
  });
});

// ---- A filter that matched no test in a file that LOADED is a measurement (2026-10-08) ----
//
// requested_not_passing counts a missing test as not passing (TEST_SUITE_CHECK_HELP). But when NONE of the
// named tests exists, bun 1.3.14 prints `error: regex "<p>" matched 0 tests. Searched 1 file (skipping N tests)`,
// exits 1 and prints NO summary, so `ran` was false and requested_not_passing came back null: the class-2 judge
// read that as unknown, and every test-first gap (its falsifier names a test the lane must ADD) was born unknown
// and stamped not admissible. The output here is bun's REAL output on fixture files in a temp dir, carried to the
// resolver through the stubbed shell transport.
describe("test_suite — a name filter that matched no test", () => {
  const originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "test-suite-matched0-"));
  writeFileSync(join(dir, "loads.test.ts"), `import { describe, expect, test } from "bun:test";\ndescribe("Suite", () => { test("existing case", () => expect(1).toBe(1)); test("other case", () => expect(2).toBe(2)); });\n`);
  writeFileSync(join(dir, "syntax.test.ts"), `import { expect, test } from "bun:test";\ntest("existing case", () => { expect(1).toBe(1) ;\n`);

  /** bun's real output for `bun test <file> --test-name-pattern=<the resolver's pattern>` in the fixture dir. */
  function realBunOutput(file: string, onlyTests: string[]): string {
    const p = Bun.spawnSync([process.execPath, "test", `./${file}`, `--test-name-pattern=${onlyTestsPattern(onlyTests)}`], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tmpdir() },
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
  }

  async function resolveWith(stdout: string, onlyTests: string[]): Promise<Record<string, unknown>> {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("vesselCapability")) {
        return new Response(JSON.stringify({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } }), { status: 200 });
      }
      if (String(input).startsWith("http://shell.test")) return new Response(JSON.stringify({ stdout }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await resolveTestSuite({ type: "test_suite", vessel: "development-vessel", test_file: "test/x.test.ts", only_tests: onlyTests });
      expect(r.shape).toBe("test_suite");
      return r.body as Record<string, unknown>;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("[must-fail] a loadable file with none of the named tests reports requested_not_passing = the number of named tests", async () => {
    const one = realBunOutput("loads.test.ts", ["no such named test"]);
    expect(one).toMatch(/^error: regex .* matched 0 tests\. Searched 1 file/m); // the bun text this relies on
    expect((await resolveWith(one, ["no such named test"]))["requested_not_passing"]).toBe(1);
    const names = ["absent one", "Suite > absent two"];
    const two = realBunOutput("loads.test.ts", names);
    const b = await resolveWith(two, names);
    expect(b["requested_not_passing"]).toBe(2);
    // No test executed: `ran` keeps its meaning (a summary was printed), so readers that gate on it are unchanged.
    expect(b["ran"]).toBe(false);
    expect(b["filter_matched_none"]).toBe(true);
  });

  test("[control] a test file that does not exist stays unmeasured (null)", async () => {
    const out = realBunOutput("absent.test.ts", ["existing case"]);
    expect(out).toContain("had no matches");
    const b = await resolveWith(out, ["existing case"]);
    expect(b["requested_not_passing"]).toBeNull();
    expect(b["ran"]).toBe(false);
  });

  test("[control] output with no summary and no 'Searched N file' line stays unmeasured (null)", async () => {
    expect((await resolveWith("bun: command not found\n", ["existing case"]))["requested_not_passing"]).toBeNull();
  });

  // bun 1.3.14 reports a file that fails to LOAD (syntax or import error) as one failed test WITH a summary
  // (`0 pass / 1 fail / 1 error`), so it was already a measurement before this change: pinned, unchanged.
  test("[control] a file that fails to load prints a summary and counts the named test as not passing (unchanged)", async () => {
    const out = realBunOutput("syntax.test.ts", ["existing case"]);
    expect(out).toContain("Unhandled error between tests");
    const b = await resolveWith(out, ["existing case"]);
    expect(b["ran"]).toBe(true);
    expect(b["requested_not_passing"]).toBe(1);
    expect(b["filter_matched_none"]).toBeUndefined();
  });

  test("[control] an existing named test reads ran, total 1, requested_not_passing 0", async () => {
    const b = await resolveWith(realBunOutput("loads.test.ts", ["Suite > existing case"]), ["Suite > existing case"]);
    expect(b).toMatchObject({ ran: true, total: 1, requested_not_passing: 0 });
  });

  test("[control] a run that matched SOME named tests keeps counting the missing ones (unchanged)", async () => {
    const names = ["Suite > existing case", "no such named test"];
    const b = await resolveWith(realBunOutput("loads.test.ts", names), names);
    expect(b).toMatchObject({ ran: true, requested_not_passing: 1 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
