// gap_falsify rule `authored_test` — the FIX-FIRST piece: the static checker and the contained,
// unprivileged runner for an LLM-drafted test file (slice S, qa ruling 2026-10-02).
//
// What these tests pin:
//  1. checkDraftStatic refuses every escape class the qa ruling names, one must-fail draft per
//     class, and accepts a well-formed draft. It is defence in depth, NOT the boundary: the
//     boundary is runContained (uid 65534, no network, private /tmp, read-only vessel bind).
//  2. RELEVANCE: a red test that never references the gap's defect signature is refused, even
//     when every other rule passes. A comment mentioning the signature does not count.
//  3. parseBunRun tells a named ASSERTION failure (red) apart from a thrown error, a timeout, a
//     module-load error and a not-run test — only the first is ever red. The fixtures below are
//     CAPTURED from real `bun test` runs written to a file (bun 1.3.14), never hand-typed.
//  4. The tree / store instruments are positive-controlled: a change they must see, they see.
//  5. The integration test runs a tiny fixture CONTAINED and asserts uid 65534, no network
//     (with an uncontained positive control so the negative is attributable), and no writes
//     outside the private tmp. It needs root + setpriv + unshare + /mnt, so it is SKIPPED on an
//     operator host — and the skip prints a marker line so it can never read as a pass.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDraftStatic,
  containmentUnavailableReason,
  parseBunRun,
  runContained,
  snapshotStores,
  storesMoved,
  worktreeStatus,
} from "../../src/resolvers/falsify-authored-test.js";

const SITE = "src/resolvers/limit-parse.ts";
const SIG = "parseLimit";
const TEST_REL = "test/resolvers/limit-parse.localize.test.ts";

/** A well-formed draft: imports only the site + bun:test + a read-only builtin, one red, one control. */
const GOOD = `
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseLimit } from "../../src/resolvers/limit-parse.js";

describe("parseLimit", () => {
  test("red: parseLimit(0) is clamped to 1", () => {
    expect(parseLimit("0")).toBe(1);
  });
  test("control: a plain number parses", () => {
    expect(parseLimit("5")).toBe(5);
    expect(join("a", "b")).toBe("a/b");
    expect(typeof readFileSync).toBe("function");
  });
});
`;

/** Wrap a hostile line into an otherwise-valid draft whose red DOES reference the signature,
 *  so the only reason to refuse is the escape itself. */
const draft = (extraImports: string, body: string): string => `
import { expect, test } from "bun:test";
${extraImports}
import { parseLimit } from "../../src/resolvers/limit-parse.js";
test("red: parseLimit clamps zero", async () => {
  ${body}
  expect(parseLimit("0")).toBe(1);
});
`;

describe("checkDraftStatic — must-fail fixture per escape", () => {
  const cases: Array<[string, string, string]> = [
    ["imports the vessel entry src/index.ts", draft(`import "../../src/index.js";`, ""), "vessel_entry"],
    ["imports child_process", draft(`import { execSync } from "node:child_process";`, `execSync("id");`), "child_process"],
    ["imports bare child_process", draft(`import * as cp from "child_process";`, `cp.execSync("id");`), "child_process"],
    ["calls Bun.spawn", draft("", `Bun.spawn(["id"]);`), "bun_spawn"],
    ["uses the Bun.$ shell", draft("", "await Bun.$`id`;"), "bun_shell"],
    ["imports $ from the bun module", draft(`import { $ } from "bun";`, "await $`id`;"), "bun_module"],
    ["calls eval", draft("", `eval("1+1");`), "eval"],
    ["calls eval via a unicode escape", draft("", `\\u0065val("1+1");`), "eval"],
    ["constructs new Function", draft("", `new Function("return 1")();`), "function_constructor"],
    ["reaches Function via .constructor", draft("", `(() => 0).constructor("return 1")();`), "function_constructor"],
    ["uses dynamic import()", draft("", `await import("node:child_process");`), "dynamic_import"],
    ["uses require()", draft("", `require("node:child_process");`), "require"],
    ["calls fetch", draft("", `await fetch("http://127.0.0.1:1/");`), "network"],
    ["opens a WebSocket", draft("", `new WebSocket("ws://127.0.0.1:1/");`), "network"],
    ["imports node:net", draft(`import { connect } from "node:net";`, `connect(1);`), "network"],
    ["calls Bun.write", draft("", `await Bun.write("/tmp/x", "y");`), "fs_write"],
    ["calls fs.writeFileSync (named import)", draft(`import { writeFileSync } from "node:fs";`, `writeFileSync("/workspace/x", "y");`), "fs_write"],
    ["imports fs as a namespace", draft(`import * as fs from "node:fs";`, `fs.writeFileSync("/x", "y");`), "fs_namespace"],
    ["calls fs/promises writeFile", draft(`import { writeFile } from "node:fs/promises";`, `await writeFile("/x", "y");`), "fs_write"],
    ["reads process.env", draft("", `const k = process.env["METABOB_API_KEY"];`), "process_env"],
    ["touches process otherwise", draft("", `process.exit(0);`), "process"],
    ["reads /proc", draft(`import { readFileSync } from "node:fs";`, `readFileSync("/proc/1/status", "utf8");`), "proc_read"],
    ["reads /proc via a template", draft(`import { readFileSync } from "node:fs";`, "readFileSync(`/proc/${1}/status`);"), "proc_read"],
    ["reads a secrets path", draft(`import { readFileSync } from "node:fs";`, `readFileSync("/etc/substrate/env");`), "sensitive_path"],
    ["leaks a setInterval with no clear", draft("", `setInterval(() => 0, 1000);`), "timer_leak"],
    ["aliases the global object", draft("", `(globalThis as any)["fe" + "tch"]("http://x/");`), "global_alias"],
    ["binds a port via Bun.serve", draft("", `Bun.serve({ port: 0, fetch: () => new Response("") });`), "binds_port"],
    ["binds a port via .listen", draft(`import { parseLimit as p2 } from "../../src/resolvers/limit-parse.js";`, `(p2 as any).listen(0);`), "binds_port"],
    ["starts a Worker", draft("", `new Worker("x.js");`), "worker"],
    ["uses import.meta.require", draft("", `import.meta.require("node:child_process");`), "import_meta"],
    ["imports an unrelated relative module", draft(`import { other } from "../../src/resolvers/other.js";`, `other();`), "import_not_allowed"],
    ["imports a package", draft(`import { z } from "zod";`, `z.string();`), "import_not_allowed"],
    ["re-exports from child_process", draft(`export { execSync } from "node:child_process";`, ""), "child_process"],
    ["uses test.only", `import { expect, test } from "bun:test";\nimport { parseLimit } from "../../src/resolvers/limit-parse.js";\ntest.only("red: parseLimit clamps", () => { expect(parseLimit("0")).toBe(1); });\n`, "test_only"],
    ["does not parse", `import { test } from "bun:test";\ntest("red: parseLimit", () => { expect(parseLimit(`, "parse_error"],
  ];
  for (const [what, src, rule] of cases) {
    test(`refuses a draft that ${what} → ${rule}`, () => {
      const r = checkDraftStatic(src, SITE, SIG, { testFileRel: TEST_REL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rule).toBe(rule);
    });
  }

  test("refuses when the edit site itself is the vessel entry", () => {
    const r = checkDraftStatic(GOOD, "src/index.ts", SIG, { testFileRel: TEST_REL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("vessel_entry");
  });

  test("a setInterval that IS cleared is not a leak (control for timer_leak)", () => {
    const r = checkDraftStatic(draft("", `const h = setInterval(() => 0, 1000); clearInterval(h);`), SITE, SIG, { testFileRel: TEST_REL });
    expect(r).toEqual({ ok: true });
  });
});

describe("checkDraftStatic — relevance (the red must reference the defect signature)", () => {
  const UNRELATED = `
import { expect, test } from "bun:test";
import { parseLimit } from "../../src/resolvers/limit-parse.js";
// parseLimit is the defect — but only this comment says so.
test("red: one is not two", () => { expect(1).toBe(2); });
test("control: parses", () => { expect(parseLimit("5")).toBe(5); });
`;
  test("an unrelated red with the signature only in a comment / the control → refused", () => {
    const r = checkDraftStatic(UNRELATED, SITE, SIG, { testFileRel: TEST_REL, redNames: ["red: one is not two"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("relevance");
  });
  test("no test anywhere references the signature → refused", () => {
    const src = `import { expect, test } from "bun:test";\nimport { other } from "../../src/resolvers/limit-parse.js";\n// parseLimit\ntest("red", () => { expect(other()).toBe(2); });\n`;
    const r = checkDraftStatic(src, SITE, SIG, { testFileRel: TEST_REL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("relevance");
  });
  test("a named red that does not exist in the draft → refused", () => {
    const r = checkDraftStatic(GOOD, SITE, SIG, { testFileRel: TEST_REL, redNames: ["red: missing"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("relevance");
  });
  test("a trivially short signature is refused (it would match anything)", () => {
    const r = checkDraftStatic(GOOD, SITE, "p", { testFileRel: TEST_REL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("signature_too_weak");
  });
  test("the good draft is accepted, with and without the test path / red names", () => {
    expect(checkDraftStatic(GOOD, SITE, SIG, { testFileRel: TEST_REL, redNames: ["red: parseLimit(0) is clamped to 1"] })).toEqual({ ok: true });
    expect(checkDraftStatic(GOOD, SITE, SIG)).toEqual({ ok: true });
    expect(checkDraftStatic(GOOD, `repos/development-vessel/${SITE}`, SIG, { testFileRel: TEST_REL })).toEqual({ ok: true });
  });
  test("a signature that is a string literal in the red counts", () => {
    const src = `import { expect, test } from "bun:test";\nimport { run } from "../../src/resolvers/limit-parse.js";\ntest("red", () => { expect(run()).toContain("limit_exceeded_marker"); });\n`;
    expect(checkDraftStatic(src, SITE, "limit_exceeded_marker", { testFileRel: TEST_REL, redNames: ["red"] })).toEqual({ ok: true });
  });
});

// ─── captured bun output (bun test v1.3.14, stdout+stderr to a FILE) ───────────────────────────

/** mixed.test.ts run with -t "control passes|red names the defect|throws plain|times out". */
const MIXED = `bun test v1.3.14 (0d9b296a)

mixed.test.ts:
(pass) site > control passes [0.06ms]
1 | import { describe, test, expect } from "bun:test";
2 | describe("site", () => {
3 |   test("control passes", () => { expect(1 + 1).toBe(2); });
4 |   test("red names the defect", () => { expect("parseLimit(0)").toBe("parseLimit(1)"); });
                                                                   ^
error: expect(received).toBe(expected)

Expected: "parseLimit(1)"
Received: "parseLimit(0)"

      at <anonymous> (/scratch/fx/mixed.test.ts:4:64)
(fail) site > red names the defect [0.14ms]
1 | import { describe, test, expect } from "bun:test";
2 | describe("site", () => {
3 |   test("control passes", () => { expect(1 + 1).toBe(2); });
4 |   test("red names the defect", () => { expect("parseLimit(0)").toBe("parseLimit(1)"); });
5 |   test("throws plain", () => { throw new Error("boom"); });
                                                         ^
error: boom
      at <anonymous> (/scratch/fx/mixed.test.ts:5:54)
(fail) site > throws plain [0.05ms]
(fail) site > times out [20.50ms]
  ^ this test timed out after 20ms.

 1 pass
 1 filtered out
 3 fail
 2 expect() calls
Ran 4 tests across 1 file. [31.00ms]
`;

/** loadfail.test.ts: imports a module that does not exist. */
const LOADFAIL = `bun test v1.3.14 (0d9b296a)

loadfail.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module './does-not-exist' from '/scratch/fx/loadfail.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [10.00ms]
`;

/** topthrow.test.ts: throws at import time. */
const TOPTHROW = `bun test v1.3.14 (0d9b296a)

topthrow.test.ts:

# Unhandled error between tests
-------------------------------
1 | import { test, expect } from "bun:test";
2 | throw new Error("import-time failure");
              ^
error: import-time failure
      at /scratch/fx/topthrow.test.ts:2:11
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [12.00ms]
`;

describe("parseBunRun — red is a NAMED ASSERTION failure, nothing else", () => {
  const names = ["control passes", "red names the defect", "throws plain", "times out", "excluded by filter"];
  const r = parseBunRun(MIXED, names);
  const by = (n: string) => r.results.find((x) => x.name === n);

  test("the file loaded and has no unnamed failures", () => {
    expect(r.loaded).toBe(true);
    expect(r.unnamed_failures).toBe(0);
  });
  test("a passing control is pass", () => expect(by("control passes")).toEqual({ name: "control passes", status: "pass", assertion: false }));
  test("an expect() failure is fail WITH assertion (the only red)", () => expect(by("red names the defect")).toEqual({ name: "red names the defect", status: "fail", assertion: true }));
  test("a thrown error is fail WITHOUT assertion (never red)", () => expect(by("throws plain")).toEqual({ name: "throws plain", status: "fail", assertion: false }));
  test("a timeout is fail WITHOUT assertion (never red)", () => expect(by("times out")).toEqual({ name: "times out", status: "fail", assertion: false }));
  test("a filtered-out test is notrun (never red)", () => expect(by("excluded by filter")).toEqual({ name: "excluded by filter", status: "notrun", assertion: false }));

  test("a module-load error: not loaded, one unnamed failure, the red is notrun", () => {
    const l = parseBunRun(LOADFAIL, ["red never runs"]);
    expect(l.loaded).toBe(false);
    expect(l.unnamed_failures).toBe(1);
    expect(l.results).toEqual([{ name: "red never runs", status: "notrun", assertion: false }]);
  });
  test("an import-time throw: not loaded, one unnamed failure", () => {
    const l = parseBunRun(TOPTHROW, ["red never runs"]);
    expect(l.loaded).toBe(false);
    expect(l.unnamed_failures).toBe(1);
    expect(l.results[0]?.status).toBe("notrun");
  });
  test("a run killed before its summary (no summary lines) is not loaded", () => {
    const l = parseBunRun("bun test v1.3.14 (0d9b296a)\n\nx.test.ts:\n(pass) site > control passes [0.06ms]\n", ["control passes"]);
    expect(l.loaded).toBe(false);
  });
  test("with no names requested, every (pass)/(fail) line is reported", () => {
    const all = parseBunRun(MIXED, []);
    expect(all.results.map((x) => x.name)).toEqual(["site > control passes", "site > red names the defect", "site > throws plain", "site > times out"]);
  });
});

// ─── the instruments, positive-controlled ──────────────────────────────────────────────────────

const scratchDirs: string[] = [];
const scratch = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  scratchDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

describe("store and tree instruments see a change they must see", () => {
  test("storesMoved reports a canary whose mtime moved, and nothing when untouched", () => {
    const d = scratch("fat-stores-");
    const canary = join(d, "gaps.json");
    const absent = join(d, "never.json");
    writeFileSync(canary, "{}");
    utimesSync(canary, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    const before = snapshotStores([canary, absent]);
    expect(storesMoved(before, snapshotStores([canary, absent]))).toEqual([]);
    utimesSync(canary, new Date(1_000_000_500_000), new Date(1_000_000_500_000));
    expect(storesMoved(before, snapshotStores([canary, absent]))).toEqual([canary]);
    writeFileSync(absent, "x");
    expect(storesMoved(before, snapshotStores([canary, absent]))).toEqual([canary, absent]);
  });

  test("worktreeStatus changes when a file appears in the worktree", () => {
    const d = scratch("fat-tree-");
    execFileSync("git", ["init", "-q", d]);
    const before = worktreeStatus(d);
    expect(before).toBe("");
    writeFileSync(join(d, "new.txt"), "x");
    expect(worktreeStatus(d)).not.toBe(before);
    expect(worktreeStatus(join(d, "not-a-repo-sub"))).toBeNull();
  });
});

// ─── runContained ──────────────────────────────────────────────────────────────────────────────

describe("runContained — fails closed", () => {
  test("refuses a test path that escapes the vessel dir, without running anything", async () => {
    const d = scratch("fat-esc-");
    const r = await runContained({ vesselDir: d, testFileRel: "../../etc/x.test.ts", onlyTests: [], timeoutMs: 1000 });
    expect(r.contained).toBe(false);
    expect(r.loaded).toBe(false);
    expect(r.results).toEqual([]);
    expect(String(r.containment_error)).toContain("test path");
  });
  test("where containment primitives are missing it does not run the draft uncontained", async () => {
    if (containmentUnavailableReason() === null) {
      console.log("[falsify-authored-test] fail-closed check N/A: containment IS available here (covered by the integration test)");
      return;
    }
    const d = scratch("fat-nocont-");
    execFileSync("git", ["init", "-q", d]);
    mkdirSync(join(d, "test"));
    writeFileSync(join(d, "test", "x.test.ts"), `import { test } from "bun:test"; test("t", () => {});`);
    const r = await runContained({ vesselDir: d, testFileRel: "test/x.test.ts", onlyTests: ["t"], timeoutMs: 5000 });
    expect(r.contained).toBe(false);
    expect(r.loaded).toBe(false);
    expect(r.results).toEqual([]);
  });
});

/** The fixture the integration test runs contained. It is a STRING, never a file under test/, so the
 *  ordinary (uncontained) suite never discovers and runs it. */
const PROBE_FIXTURE = (rootOwnedTarget: string, hostTmpPath: string): string => `
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const code = async (u: string): Promise<string> => {
  try { await fetch(u, { signal: AbortSignal.timeout(3000) }); return "OK"; }
  catch (e) { return String((e as { code?: string })?.code ?? e); }
};
test("runs as nobody", () => { expect(process.getuid?.()).toBe(65534); });
test("loopback is unreachable", async () => {
  const c = await code("http://127.0.0.1:9/");
  console.log("probe-loopback=" + c);
  expect(c).not.toBe("OK");
  expect(c).not.toBe("ConnectionRefused");
});
test("the outside is unreachable", async () => { expect(await code("http://1.1.1.1/")).not.toBe("OK"); });
const werr = (p: string): string => { try { writeFileSync(p, "x"); return "WROTE"; } catch (e) { return String((e as { code?: string }).code); } };
test("private tmp is writable", () => { expect(werr(join(tmpdir(), "ok"))).toBe("WROTE"); });
// A dir that exists in the HOST's /tmp (this fixture's own worktree there) must be invisible: /tmp is private.
test("the host tmp is invisible", () => { expect(existsSync(${JSON.stringify(hostTmpPath)})).toBe(false); });
// The errno is asserted, not just a throw: ENOENT would mean the probe aimed at a path that does not exist.
// The fixture's dir is world-writable (1777), so only the read-only bind can refuse this: EROFS, not EACCES.
test("the vessel dir is not writable", () => { expect(werr(join(import.meta.dir, "zz-written"))).toBe("EROFS"); });
test("a root-owned dir is not writable", () => { expect(werr(${JSON.stringify(rootOwnedTarget)})).toBe("EACCES"); });
test("env is scrubbed", () => { expect(Object.keys(process.env).filter((k) => !["PATH", "HOME", "TMPDIR", "WORKSPACE_ROOT", "NO_COLOR", "NODE_ENV"].includes(k))).toEqual([]); });
test("red: a named assertion", () => { expect("limit").toBe("parseLimit"); });
`;

const unavailable = containmentUnavailableReason();
if (unavailable !== null) {
  console.log(`[falsify-authored-test] integration SKIPPED: ${unavailable}`);
}

describe("runContained — integration (needs root + setpriv + unshare + /mnt)", () => {
  test.skipIf(unavailable !== null)("a fixture runs as uid 65534 with no network and no writes outside its tmp", async () => {
    // Positive control: the SAME loopback fetch, uncontained, is refused by a live stack — so the
    // contained run's different failure is the namespace, not a dead probe.
    let control = "";
    try { await fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(3000) }); control = "OK"; }
    catch (e) { control = String((e as { code?: string })?.code ?? e); }
    expect(control).toBe("ConnectionRefused");

    const vessel = scratch("fat-vessel-");
    expect(vessel.startsWith("/tmp/")).toBe(true);   // else "the host tmp is invisible" would be vacuous
    execFileSync("chmod", ["755", vessel]);
    execFileSync("git", ["init", "-q", vessel]);
    // /mnt is the run's scratch root inside the namespace: it exists there, is root-owned 755, and root
    // could write it — so EACCES is the uid drop, not a missing path (a target under /tmp would not exist
    // in the namespace's private tmp and would throw ENOENT for the wrong reason).
    const target = "/mnt/written-by-draft";
    mkdirSync(join(vessel, "test"));
    // World-writable on purpose: the uid drop alone cannot protect it, so a write refused there is the
    // read-only vessel bind (a mutant without the ro remount turns this test red).
    execFileSync("chmod", ["1777", join(vessel, "test")]);
    writeFileSync(join(vessel, "test", "probe.localize.test.ts"), PROBE_FIXTURE(target, vessel));
    const store = join(scratch("fat-store-"), "gaps.json");
    writeFileSync(store, "{}");

    const names = ["runs as nobody", "loopback is unreachable", "the outside is unreachable", "private tmp is writable",
      "the host tmp is invisible", "the vessel dir is not writable", "a root-owned dir is not writable", "env is scrubbed", "red: a named assertion"];
    const r = await runContained({ vesselDir: vessel, testFileRel: "test/probe.localize.test.ts", onlyTests: names, timeoutMs: 60_000, storePaths: [store] });
    console.log(`[falsify-authored-test] integration result: ${JSON.stringify(r)}`);
    expect(r.contained).toBe(true);
    expect(r.loaded).toBe(true);
    expect(r.unnamed_failures).toBe(0);
    for (const n of names.slice(0, -1)) expect(r.results.find((x) => x.name === n)?.status).toBe("pass");
    expect(r.results.find((x) => x.name === "red: a named assertion")).toEqual({ name: "red: a named assertion", status: "fail", assertion: true });
    expect(r.tree_clean).toBe(true);
    expect(r.stores_untouched).toBe(true);
    expect(existsSync(join(vessel, "test", "zz-written"))).toBe(false);
    expect(existsSync(r.raw_output_path)).toBe(true);
  }, 90_000);

  test.skipIf(unavailable !== null)("a draft that hangs is killed at the hard timeout and is not loaded", async () => {
    const vessel = scratch("fat-hang-");
    execFileSync("chmod", ["755", vessel]);
    execFileSync("git", ["init", "-q", vessel]);
    mkdirSync(join(vessel, "test"));
    writeFileSync(join(vessel, "test", "hang.localize.test.ts"), `import { test } from "bun:test";\ntest("red: hangs", async () => { await new Promise(() => {}); }, 600000);\n`);
    const t0 = Date.now();
    const r = await runContained({ vesselDir: vessel, testFileRel: "test/hang.localize.test.ts", onlyTests: ["red: hangs"], timeoutMs: 3000, storePaths: [] });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.timed_out).toBe(true);
    expect(r.loaded).toBe(false);
    expect(r.results.find((x) => x.name === "red: hangs")?.status).not.toBe("fail");
  }, 60_000);
});
