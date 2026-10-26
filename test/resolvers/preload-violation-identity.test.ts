// A VIOLATION'S IDENTITY IS THE TEST THAT RECORDED IT, NEVER WHOEVER IS RUNNING WHEN IT LANDS.
//
// test/preload.ts's afterEach/afterAll and the guard arrays they drain are shared across the whole `bun test`
// PROCESS (the node gate runs the vessel's full suite that way). A violation recorded asynchronously, after its
// own test's afterEach already ran, used to land in the shared array before the NEXT test's afterEach fired —
// failing an innocent test, sometimes in a different file entirely (measured 2026-10-24: ~52 failures across 13
// files from exactly this leak).
//
// Both cases below spawn a CHILD `bun test` process over a small fixture, preloaded with THIS repo's real
// test/preload.ts by absolute path (no copy: whatever the preload currently does is what gets exercised), so
// running this same file at a commit before the fix picks up that commit's own (buggy) preload.ts and goes red.
//
// CASE 1 (cross-file): file A's first test queues a violation timed to land well after file A has entirely
// finished (including its own per-file afterAll) and while file B's test is running.
//   MUST-FAIL: at a preload before owner-tracking (716a3c21/51b744bf as landed), file B's innocent test is
//   reported failed — the bug as measured.
//   Green at this fix: file B's test passes. The leak can no longer be attributed to file A specifically (its
//   own afterAll already ran before the leak arrived — an honest, documented limit, see preload.ts's backstop)
//   but it is still reported, at the process-end backstop, never charged to file B.
// CASE 2 (same file, still open): file A's first test queues a violation timed to land while file A's SECOND
// test is still running (file A has not finished).
//   MUST-FAIL: at the buggy preload, the UNRELATED second test in the SAME file fails for a sibling's leak.
//   Green at this fix: the second test passes, and the leak is reported at file A's own afterAll, named as
//   file A's.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD_PATH = resolve(fileURLToPath(new URL("../preload.ts", import.meta.url)));

function runFixture(files: Record<string, string>, args: string[]): { stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "preload-identity-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const r = Bun.spawnSync(["bun", `--preload=${PRELOAD_PATH}`, "test", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { stdout: `${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const leakyTest = (delayMs: number) => `
import { test, expect } from "bun:test";
test("a-leaky", () => {
  setTimeout(() => {
    try { Bun.spawnSync(["systemctl", "is-active", "x"], { stdout: "pipe", stderr: "pipe" }); } catch { /* recorded by the guard */ }
  }, ${delayMs});
  expect(1).toBe(1);
});
`;

describe("preload violation identity: a leak is charged to its own recording test/file, never a later one", () => {
  it("MUST-FAIL (cross-file): an innocent test in a LATER file is not failed by an earlier file's async leak", () => {
    const { stdout } = runFixture(
      {
        "a.test.ts": `${leakyTest(150)}
import { test, expect } from "bun:test";
test("a-second", async () => { await Bun.sleep(20); expect(1).toBe(1); });
`,
        "b.test.ts": `
import { test, expect } from "bun:test";
test("b-innocent", async () => { await Bun.sleep(300); expect(1).toBe(1); });
`,
      },
      ["./a.test.ts", "./b.test.ts"],
    );
    expect({
      bFailed: /\(fail\)\s+b-innocent/.test(stdout),
      bPassedOrAbsentFromFailures: !/\(fail\)\s+b-innocent/.test(stdout),
      leakStillReported: /blocked spawn Bun\.spawnSync: systemctl is-active x/.test(stdout),
      notBlamedOnFileB: !/attributed to .*b\.test\.ts/.test(stdout),
    }).toEqual({ bFailed: false, bPassedOrAbsentFromFailures: true, leakStillReported: true, notBlamedOnFileB: true });
  });

  it("MUST-FAIL (same file): an unrelated sibling test is not failed by this file's own async leak, which is reported as this file's", () => {
    const { stdout } = runFixture(
      {
        "a.test.ts": `${leakyTest(50)}
import { test, expect } from "bun:test";
test("a-second", async () => { await Bun.sleep(250); expect(1).toBe(1); });
`,
      },
      ["./a.test.ts"],
    );
    expect({
      secondFailed: /\(fail\)\s+a-second/.test(stdout),
      attributedToThisFile: /outside any test, attributed to .*a\.test\.ts/.test(stdout),
    }).toEqual({ secondFailed: false, attributedToThisFile: true });
  });

  it("CONTROL: a synchronous violation inside a test still fails THAT test; a neighbor is unaffected", () => {
    const { stdout } = runFixture(
      {
        "sync.test.ts": `
import { test, expect } from "bun:test";
test("sync-violator", () => {
  Bun.spawnSync(["systemctl", "is-active", "x"], { stdout: "pipe", stderr: "pipe" });
  expect(1).toBe(1);
});
test("sync-neighbor", () => { expect(1).toBe(1); });
`,
      },
      ["./sync.test.ts"],
    );
    expect({
      violatorFailed: /\(fail\)\s+sync-violator/.test(stdout),
      neighborFailed: /\(fail\)\s+sync-neighbor/.test(stdout),
    }).toEqual({ violatorFailed: true, neighborFailed: false });
  });
});
