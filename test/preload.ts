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
// Both guards install and record here. Callers swallow spawn and read errors, so a throw alone would let a test
// pass on a fail-open path. The afterEach below FAILS the test that recorded a blocked spawn or read.
//
// RE-LANDED WITH PER-TEST ATTRIBUTION (2026-10-25). A process-wide `afterEach`/`afterAll` here once failed
// whichever test was running when it found either violations array non-empty. bun runs the whole suite in ONE
// process, and a violation recorded ASYNCHRONOUSLY (after the test that triggered it had already spliced an
// empty result in its own afterEach) landed in the array before the NEXT, unrelated test's afterEach ran —
// failing an innocent test, sometimes in a different file (measured: the bulk of a node gate's "131 failing at
// candidate" count). That enforcement was pulled (keeping only install+record) until it had per-test
// attribution; this restores it. preload-test-identity.ts tags every violation, at record time, with the test
// whose execution is causally responsible for it (ALS-tracked, so it survives the violation firing during a
// LATER test's turn — proven directly: a setTimeout queued inside test A still reports A's identity when it
// fires mid test B's await). afterEach below fails ONLY the test whose identity matches the one that just ran;
// a violation recorded after its own test ended is left in the array for that test's FILE's own afterAll
// (also installed by preload-test-identity.ts, once per file) to report as a failure of that recording file —
// never a later file. Both arrays are fully drained at each file's afterAll, so nothing can cross a file
// boundary; a genuinely final backstop at the true end of the process reports anything still left over.
//
// Scope, stated honestly: a child process (`bun -e`, `bun test` in a child) does not load this preload; a test that
// spawns vessel code in a child must stub the child's edges itself.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TestId } from "./resolvers/preload-test-identity.js";

export const TEST_RUN_TMP_PREFIX = "dv-test-run-";
const startTmp = resolve(tmpdir());
const ws = process.env["WORKSPACE_ROOT"] ? resolve(process.env["WORKSPACE_ROOT"]) : "";
const wsIsScratch = ws !== "" && ws.startsWith(startTmp + sep) && existsSync(ws);
const runTmp = wsIsScratch ? ws : mkdtempSync(join(startTmp, TEST_RUN_TMP_PREFIX));
/** Where this run's TMPDIR points and why (read by test/preload-tmpdir.test.ts). */
export const TEST_RUN_TMP = Object.freeze({ dir: runTmp, startTmp, source: wsIsScratch ? "workspace_root" : "own" });
process.env["TMPDIR"] = runTmp;
if (!wsIsScratch) process.on("exit", () => { try { rmSync(runTmp, { recursive: true, force: true }); } catch { /* best effort at exit */ } });

const { afterEach, afterAll } = await import("bun:test");
const { installPreloadExecGuard, takePreloadExecViolationsMatching } = await import("./resolvers/cutover-exec-guard.js");
const { installSecretReadGuard, takeSecretReadViolationsMatching } = await import("./resolvers/cutover-fs-guard.js");
const { installTestIdentityTracking, ownerForRecord, mostRecentTestId, sameTestId, onFileEnd } =
  await import("./resolvers/preload-test-identity.js");

await installTestIdentityTracking();
installPreloadExecGuard(ownerForRecord);
installSecretReadGuard([startTmp], ownerForRecord);

function isTestId(o: unknown): o is TestId {
  return !!o && typeof o === "object" && typeof (o as TestId).file === "string" && typeof (o as TestId).name === "string";
}

function report(where: string, spawns: string[], reads: string[]): void {
  if (spawns.length === 0 && reads.length === 0) return;
  throw new Error(`test preload guard (${where}): ${[...spawns.map((s) => `blocked spawn ${s}`), ...reads.map((r) => `blocked secret read ${r}`)].join("; ")}`);
}

// Fails only the test that just ran, by matching the ALS-recorded owner against the plain "most recently
// started" identity (unaffected by any later test, since the next test has not started yet).
afterEach(() => {
  const mine = mostRecentTestId();
  report(
    "in this test",
    takePreloadExecViolationsMatching((o) => sameTestId(isTestId(o) ? o : undefined, mine)),
    takeSecretReadViolationsMatching((o) => sameTestId(isTestId(o) ? o : undefined, mine)),
  );
});

// Once per file (installed by preload-test-identity.ts the first time it sees a new file): drains and
// reports anything recorded by this file (any of its tests, or outside any test) that its own afterEach did
// not already catch — a leak that landed after that test's afterEach but before the file ended. Charges it
// to the file that recorded it, never to whichever file is running when this fires.
onFileEnd((file) => {
  report(
    `outside any test, attributed to ${file}`,
    takePreloadExecViolationsMatching((o) => isTestId(o) && o.file === file),
    takeSecretReadViolationsMatching((o) => isTestId(o) && o.file === file),
  );
});

// Backstop at the true end of the whole process: anything still left (an owner whose file never got its own
// afterEach, or none at all) is reported rather than silently dropped.
afterAll(() => report("outside any test, unattributed", takePreloadExecViolationsMatching(() => true), takeSecretReadViolationsMatching(() => true)));
