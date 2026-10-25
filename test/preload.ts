// THE TEST PRELOAD (bunfig.toml [test] preload): runs once per `bun test` process, before any test file loads.
//
// Each node's pull-sync gate runs this vessel's whole suite INSIDE the live container at install, in one process.
// Three things a test file could do there without asking are made impossible for every file, not only for the
// files that opt in:
//   1. TMPDIR. Tests make their scratch under os.tmpdir(); in the live container that is the container's own /tmp,
//      where every directory a test forgets to remove stays. This process's TMPDIR is a per-run directory (set BEFORE
//      any other import, so module-load tmpdir() reads see it, and inherited by spawned children). When the run was
//      given a scratch WORKSPACE_ROOT inside the tmp root (the node gate's scrubbed env does: a mktemp root it removes
//      after the run), that root IS the per-run directory: harnesses that require the store root to sit under
//      tmpdir() (judge-split, drafter-split) keep holding, and whatever a test leaves goes with the gate's cleanup.
//      Otherwise a fresh directory is made under the tmp root and removed when the process exits. A run killed with
//      SIGKILL cannot remove its own directory: it is still one directory, not one per test.
//   2. Host-lifecycle spawns. cutover-exec-guard.ts's guard is installed as the baseline: Bun.spawn, Bun.spawnSync
//      or child_process of systemctl, journalctl, docker, podman or vessel-ctl throws EPERM and is recorded.
//   3. Secret reads. cutover-fs-guard.ts's secret-read guard is installed as the baseline: a content read under
//      the fleet env/config, secrets or identity-key paths throws EACCES and is recorded.
// Both guards install and record here, for any file to read (takePreloadExecViolations, takeSecretReadViolations).
//
// REMOVED (temporary, 2026-10-25): a process-wide `afterEach`/`afterAll` used to fail whichever test was running
// when it found either violations array non-empty. bun runs the whole suite in ONE process, and a violation
// recorded ASYNCHRONOUSLY (after the test that triggered it had already spliced an empty result in its own
// afterEach) landed in the array before the NEXT, unrelated test's afterEach ran — failing an innocent test in a
// different file. That cross-file leak produced the bulk of a node gate's "131 failing at candidate" count. The
// guards still install and still record, so a test that wants enforcement takes the arrays itself
// (takePreloadExecViolations, takeSecretReadViolations) and asserts on them directly; re-landing an always-on
// failure needs per-test attribution (take only what THIS test added, not the whole array) first.
//
// Scope, stated honestly: a child process (`bun -e`, `bun test` in a child) does not load this preload; a test that
// spawns vessel code in a child must stub the child's edges itself.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const TEST_RUN_TMP_PREFIX = "dv-test-run-";
const startTmp = resolve(tmpdir());
const ws = process.env["WORKSPACE_ROOT"] ? resolve(process.env["WORKSPACE_ROOT"]) : "";
const wsIsScratch = ws !== "" && ws.startsWith(startTmp + sep) && existsSync(ws);
const runTmp = wsIsScratch ? ws : mkdtempSync(join(startTmp, TEST_RUN_TMP_PREFIX));
/** Where this run's TMPDIR points and why (read by test/preload-tmpdir.test.ts). */
export const TEST_RUN_TMP = Object.freeze({ dir: runTmp, startTmp, source: wsIsScratch ? "workspace_root" : "own" });
process.env["TMPDIR"] = runTmp;
if (!wsIsScratch) process.on("exit", () => { try { rmSync(runTmp, { recursive: true, force: true }); } catch { /* best effort at exit */ } });

const { installPreloadExecGuard } = await import("./resolvers/cutover-exec-guard.js");
const { installSecretReadGuard } = await import("./resolvers/cutover-fs-guard.js");
installPreloadExecGuard();
installSecretReadGuard([startTmp]);
