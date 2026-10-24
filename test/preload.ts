// THE TEST PRELOAD (bunfig.toml [test] preload): runs once per `bun test` process, before any test file loads.
//
// Each node's pull-sync gate runs this vessel's whole suite INSIDE the live container at install, in one process.
// Three things a test file could do there without asking are made impossible for every file, not only for the
// files that opt in:
//   1. TMPDIR. Tests make their scratch under os.tmpdir(); in the live container that is the container's own /tmp,
//      where every directory a test forgets to remove stays. This process's TMPDIR is a fresh per-run directory
//      (set BEFORE any other import, so module-load tmpdir() reads see it, and inherited by spawned children),
//      removed when the process exits. A run killed with SIGKILL cannot remove it: it is still one directory.
//   2. Host-lifecycle spawns. cutover-exec-guard.ts's guard is installed as the baseline: Bun.spawn, Bun.spawnSync
//      or child_process of systemctl, journalctl, docker, podman or vessel-ctl throws EPERM and is recorded.
//   3. Secret reads. cutover-fs-guard.ts's secret-read guard is installed as the baseline: a content read under
//      the fleet env/config, secrets or identity-key paths throws EACCES and is recorded.
// Callers swallow spawn and read errors, so a throw alone would let a test pass on a fail-open path. The afterEach
// below FAILS the test that recorded a blocked spawn or read, and the afterAll catches any recorded outside a test
// (module top level, beforeAll). A test that blocks one on purpose takes it first (takePreloadExecViolations,
// takeSecretReadViolations).
//
// Scope, stated honestly: a child process (`bun -e`, `bun test` in a child) does not load this preload; a test that
// spawns vessel code in a child must stub the child's edges itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_RUN_TMP_PREFIX = "dv-test-run-";
const startTmp = tmpdir();
const runTmp = mkdtempSync(join(startTmp, TEST_RUN_TMP_PREFIX));
process.env["TMPDIR"] = runTmp;
process.on("exit", () => { try { rmSync(runTmp, { recursive: true, force: true }); } catch { /* best effort at exit */ } });

const { afterEach, afterAll } = await import("bun:test");
const { installPreloadExecGuard, takePreloadExecViolations } = await import("./resolvers/cutover-exec-guard.js");
const { installSecretReadGuard, takeSecretReadViolations } = await import("./resolvers/cutover-fs-guard.js");
installPreloadExecGuard();
installSecretReadGuard([startTmp]);

function failOnRecorded(where: string): void {
  const spawns = takePreloadExecViolations();
  const reads = takeSecretReadViolations();
  if (spawns.length === 0 && reads.length === 0) return;
  throw new Error(`test preload guard (${where}): ${[...spawns.map((s) => `blocked spawn ${s}`), ...reads.map((r) => `blocked secret read ${r}`)].join("; ")}`);
}
afterEach(() => failOnRecorded("in this test"));
afterAll(() => failOnRecorded("outside any test"));
