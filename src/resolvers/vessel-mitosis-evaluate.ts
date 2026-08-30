import { join, dirname, basename } from "path";
import {
  stat,
  lstat,
  mkdir,
  copyFile,
  readdir,
  symlink,
  unlink,
  cp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { groupLeaderArgv, killProcessGroup } from "../process-group";
import { isSaturated, loadAverage1m, SATURATION_MULTIPLE } from "../system-load";
// bun resolved via Bun.which at call-time (no external import needed)
import type { ResolverResult } from "./types.js";

/**
 * vessel_mitosis_evaluate — fetches recent traces from activity-api, segments
 * them by version_id (read from trace metadata), computes per-version
 * success_rate + failure_mode class set, and renders a verdict.
 *
 * STATIC EVALUATION (2026-06-04): when pointer.mitosis_root is supplied, the
 * resolver runs the idiomatic substrate disciplines — `bun run lint` +
 * `bun test` — inside the mitosis directory BEFORE consulting traces. This
 * lets the autonomous self-repair loop reach FAVORABLE on freshly-staged
 * mitoses (which have no runtime traces against them yet) when the code
 * change is well-formed. Failing checks → UNFAVORABLE with cited output.
 * Passing checks → FAVORABLE (trace check becomes additive, not gating).
 *
 *   FAVORABLE       — mitosis success_rate ≥ base + threshold AND no new
 *                     failure_mode classes introduced.
 *   NEUTRAL         — within ±threshold either direction.
 *   UNFAVORABLE     — mitosis success_rate < base - threshold OR a new
 *                     failure_mode class appears.
 *   INSUFFICIENT_DATA — either side has fewer than min_traces_per_version.
 *
 * Version routing keys (in priority order, first present wins):
 *   metadata.version_id
 *   metadata.mitosis_version_id
 *   metadata.dispatch_target_template_id matching mitosis pattern
 *
 * Immunity-pattern: deterministic, no LLM, single resolver.
 */

export interface VesselMitosisEvaluatePointer {
  type: "vessel_mitosis_evaluate";
  base_version_id: string;
  mitosis_version_id: string;
  tracesUrl?: string;
  fetchLimit?: number;
  since?: string;
  min_traces_per_version?: number;
  success_rate_advantage_threshold?: number;
  /**
   * When supplied, the resolver runs `bun run lint` + `bun test` inside this
   * directory before consulting traces. If both pass → FAVORABLE. If either
   * fails → UNFAVORABLE with cited output. If the directory or scripts are
   * missing → falls through to trace path.
   */
  mitosis_root?: string;
  /**
   * When supplied along with mitosis_root + staged_files, the resolver
   * overlays staged files from mitosis_root onto a temp clone of
   * static_check_base_root (the canonical vessel tree with package.json +
   * node_modules) and runs lint + tests there. This is how the substrate
   * evaluates a sparse mitosis dir (which only contains the changed files)
   * — we synthesize the full vessel-tree-as-if-cutover-had-happened and
   * test it in isolation, then throw the temp away.
   */
  static_check_base_root?: string;
  staged_files?: string[];
  /** Override the static-check command runner (test hook). */
  static_check_runner?: "bun" | "skip";
  /** Override `bun` binary path. */
  bun_cmd?: string;
  /**
   * Script name(s) to invoke as `bun run <name>`. Defaults to ["lint"]
   * (typecheck + shape-dispatch). When the synthesized overlay lacks
   * supporting files for some scripts (e.g. test fixtures), provide a
   * narrower set. The `bun test` step is always attempted after these.
   */
  static_check_scripts?: string[];
  /** Skip `bun test` (default false). */
  skip_tests?: boolean;
}

interface StaticCheckResult {
  name: string;
  exit_code: number;
  duration_ms: number;
  output_tail: string;
  /**
   * True when the check was SIGTERM-killed by STATIC_CHECK_TIMEOUT_MS rather
   * than completing on its own. A timed-out check produced NO trustworthy
   * exit code / error output, so it must NOT be read as a typecheck failure
   * (regression) — the caller treats it as inconclusive (defer-and-retry).
   */
  timed_out: boolean;
}

export interface StaticEvalResult {
  attempted: boolean;
  ok: boolean;
  reason: string;
  checks: StaticCheckResult[];
  duration_ms: number;
  /**
   * V40: set when a static check was SIGTERM-killed by the timeout (no
   * completed verdict). This is INCONCLUSIVE, not a failure — the caller
   * must NOT frame it as an UNFAVORABLE regression; it should defer and
   * re-evaluate next tick (in a quieter window).
   */
  timed_out?: boolean;
}

// V40 (2026-06-30): raised 60s → 120s. Overlay typechecks of large vessels
// under autonomous-loop load (the substrate exercising itself concurrently)
// legitimately exceed 60s — the SIGTERM-killed tsc then returned exit 143,
// which the failure-reason assembly framed as a '(regression)' UNFAVORABLE
// for a change that actually compiles. The timeout case is now detected and
// surfaced as a DISTINCT, inconclusive result (see runCheck.timed_out and the
// timeout branch in staticEvaluate) so the cutover defers-and-retries in a
// quieter window instead of terminally rejecting a clean patch.
const STATIC_CHECK_TIMEOUT_MS = 120_000;
// A FULL SUITE IS NOT A SCRIPT CHECK, AND 120s CANNOT MEASURE ONE.
//
// STATIC_CHECK_TIMEOUT_MS was sized for `tsc --noEmit` and the shape-dispatch check,
// which finish in seconds. `bun test` is a different order of work: development-vessel
// runs 1429 tests across 203 files, ~33s on a warm host tree and considerably slower in
// the overlay, which symlinks its top level and starts cold. Measured on the live gate:
// killed after 120000ms (exit=143), every attempt, so the suite NEVER completed and the
// delta could never be computed — the gate deferred forever and no autonomous landing
// could pass it.
//
// The gate needs two suite runs (base + overlay) to judge a delta at all, so the budget
// must cover the slower of them with room to spare. A too-short timeout here does not
// fail safe: it converts a working gate into a permanent defer, which is how the test
// gate came to be disabled with skip_tests the first time.
const SUITE_CHECK_TIMEOUT_MS = 420_000;
// Raised to 1 MiB (2026-06-30) to capture full typecheck/lint output so the
// mitosis signature-subset gate and the spawn-error / missing-script / syntax-bail
// guards normalize over the COMPLETE tsc output rather than only the last 4 KB.
const OUTPUT_TAIL_BYTES = 1_048_576;
// POSIX 128 + SIGTERM(15). Bun.spawn's proc.kill() sends SIGTERM, so a
// timeout-killed child exits 143. We also set an explicit timed_out flag so
// we never confuse a genuine non-zero tsc exit with a kill.
const SIGTERM_EXIT_CODE = 143;

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "...(truncated)..." + s.slice(s.length - n);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Baseline suite results, cached per base tree.
 *
 * The delta gate runs a baseline suite whenever the overlay suite is non-zero — which,
 * for any vessel carrying pre-existing reds, is EVERY evaluation. development-vessel has
 * 76, so every mitosis evaluation was running two full suites back to back.
 *
 * That is a real cost I introduced with the delta gate, and it showed: three concurrent
 * `bun test` processes in the container, host load average 6.46, and the CHEAP checks
 * starving — `typecheck` began timing out at its 120s budget, which it had never done
 * before. A gate that makes the box too slow to run the other gates is not a safe gate.
 *
 * The base tree does not change between evaluations of the same staged batch, so the
 * baseline is the same answer every time. Cache it briefly, keyed by the base root, and
 * take the cost once per window instead of once per evaluation.
 */
const BASELINE_CACHE_TTL_MS = 10 * 60_000;
const baselineSuiteCache = new Map<string, { at: number; result: StaticCheckResult }>();

async function runCheck(
  bunCmd: string,
  args: string[],
  cwd: string,
  name: string,
  timeoutMs: number = STATIC_CHECK_TIMEOUT_MS,
): Promise<StaticCheckResult> {
  const start = Date.now();
  let exit = -1;
  let out = "";
  let timedOut = false;
  // DON'T START A SUITE THE BOX CANNOT FINISH.
  //
  // Measured 2026-08-30: mitosis-tick fired ~390x/hour while each suite takes minutes, so ~29 ran
  // concurrently on 14 CPUs and loadavg sat at 41-57 for over half an hour with no downward trend.
  // At that oversubscription a suite overruns SUITE_CHECK_TIMEOUT_MS and returns `timed_out`, which
  // this evaluator ALREADY treats as inconclusive-defer rather than a regression — so the run burns
  // seven CPU-minutes to produce the verdict it would have produced for free, and that burn is part
  // of what keeps the box saturated.
  //
  // Declining to start yields the SAME inconclusive verdict at zero cost, and lifts by itself when
  // load falls: condition-driven selection, not a static clamp or a timer. Reported through the
  // existing `timed_out` channel on purpose — inventing a new verdict would risk being read as a
  // test FAILURE, which is exactly the false-block that already bites the pre-cutover gate.
  if (isSaturated()) {
    const load = loadAverage1m();
    return {
      name,
      exit_code: -1,
      duration_ms: 0,
      output_tail: `deferred: not started — 1-minute load average ${load ?? "unknown"} exceeds ${SATURATION_MULTIPLE}x the CPU count. At this oversubscription the suite would almost certainly exhaust its timeout and return inconclusive anyway, so it is skipped rather than run. This is not a test failure and not a regression; it re-runs unchanged once load falls.`,
      timed_out: true,
    };
  }
  try {
    // Spawned as its own process-group leader so a timeout can take the WHOLE tree.
    const proc = Bun.spawn(groupLeaderArgv(bunCmd, args), {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${process.env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}:/root/.bun/bin` },
    });
    const timer = setTimeout(() => {
      // V40: record that WE killed it. The resulting exit code (143 / -1) must
      // not be interpreted as a tsc verdict — it's a kill, not a completion.
      timedOut = true;
      // KILL THE GROUP, NOT THE CHILD. `proc.kill()` signals exactly one pid, so killing `bun`
      // left every worker `bun test` had forked running — reparented to init, no parent, no
      // timer, forever. Measured on substrate-live 2026-08-30: loadavg 57.5 holding above 45
      // with 29-47 orphaned `bun test` processes continuously replenished (this runs at ~292
      // mitosis-ticks/hour with a 420s suite timeout), which is what made vessel /health take
      // 9.5s and walks die on "fetch failed: The operation was aborted". Same defect, same fix
      // as `groupBounded` in repos/local-tools-vessel/src/index.ts. Falls back to the old
      // single-pid kill so a timeout always terminates something.
      killProcessGroup(proc.pid, () => proc.kill());
    }, timeoutMs);
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exit = await proc.exited;
    clearTimeout(timer);
    out = `--- stdout ---\n${stdoutText}\n--- stderr ---\n${stderrText}`;
  } catch (err) {
    out = `spawn_error: ${(err as Error).message}`;
  }
  // Belt-and-braces: if the timer didn't flip the flag but the process exited
  // with the SIGTERM code AND produced no error output, treat it as a kill too.
  // A genuine tsc failure exits non-zero WITH `error TS…` lines in its output.
  if (!timedOut && exit === SIGTERM_EXIT_CODE && !/error TS\d+:/.test(out)) {
    timedOut = true;
  }
  return {
    name,
    exit_code: exit,
    duration_ms: Date.now() - start,
    output_tail: tail(out, OUTPUT_TAIL_BYTES),
    timed_out: timedOut,
  };
}

/**
 * Failing-test names from a `bun test` run, for baseline-delta comparison. Mirrors
 * feature-compose.ts's testFailureSet: a NEW failure is one this patch introduced, not
 * one the vessel was already carrying.
 */
/** Drop SGR escapes so anchored matching sees the text bun printed, not its colours. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

/**
 * Failure names from a bun test run.
 *
 * FORMAT NOTE, AND A CORRECTION TO AN EARLIER CLAIM IN THIS FILE'S HISTORY
 * (2026-08-09). I once concluded this function "parsed nothing on every run"
 * because bun printed an ANSI-prefixed cross rather than `(fail)`. That was
 * WRONG, and the mistake is worth recording because it is easy to repeat: bun
 * emits `(pass)`/`(fail)` when its stdout is a PIPE, and the coloured tick/cross
 * when it is a TTY. The gate always spawns with piped stdout, so the original
 * `(fail)` pattern was correct for the only context that matters. The cross I
 * measured came from an interactive shell — I compared the gate against output
 * it never sees, and shipped a "fix" on that premise.
 *
 * The real defect was elsewhere: symlinked test files executed from the base
 * tree and imported unpatched source (see buildOverlay). Confirmed after that
 * fix — a live gate run emits `(fail) isEditIntentGoal > ...` and the delta
 * correctly reported 2 failures INTRODUCED.
 *
 * Both spellings are accepted anyway: it costs one alternation, and it means a
 * future bun that changes its non-TTY format cannot silently empty this set.
 */
export function testFailureNames(output: string): Set<string> {
  const out = new Set<string>();
  for (const raw of stripAnsi(output).split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(?:\(fail\)|✗|×)\s+(.*)$/);
    if (m && m[1]) out.add(m[1].replace(/\s*\[[\d.]+m?s\]\s*$/, "").trim());
  }
  return out;
}

/**
 * Does the parsed failure set agree with bun's own summary line?
 *
 * THE REGEX WAS NOT THE BUG. The bug was that an empty parse was trusted as a
 * measurement: a parser returning nothing is indistinguishable from a green
 * suite, and nothing ever asserted the difference — which is why a dead pattern
 * survived a bun upgrade and silently disarmed the gate.
 *
 * bun prints `N fail` in its summary. If it says failures happened and we parsed
 * none, the parse is broken and the comparison must be treated as UNKNOWN rather
 * than as zero. Returns true when the two agree (including the ordinary
 * everything-passed case, where both are zero).
 */
export function testFailureParseIsConsistent(output: string, parsed: Set<string>): boolean {
  const m = stripAnsi(output).match(/^\s*(\d+)\s+fail\b/m);
  if (!m) return true; // no summary to check against — nothing to contradict
  const reported = Number(m[1]);
  return reported === 0 ? parsed.size === 0 : parsed.size > 0;
}

/**
 * Build a synthetic vessel tree under tmpdir() that mirrors `baseRoot` via
 * symlinks for unchanged entries and copies `stagedFiles` from `mitosisRoot`
 * over the top. Returns the temp root. Caller is responsible for cleanup —
 * since these are mostly symlinks, the cleanup is cheap.
 */
async function buildOverlay(
  baseRoot: string,
  mitosisRoot: string,
  stagedFiles: string[],
): Promise<string> {
  const overlay = join(
    tmpdir(),
    `mitosis-overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(overlay, { recursive: true });
  // Symlink every top-level entry of baseRoot into overlay.
  const tops = (await readdir(baseRoot, { withFileTypes: true })) as unknown as Array<{
    name: string;
    isDirectory(): boolean;
  }>;
  for (const e of tops) {
    const name = e.name;
    if (name === ".git") continue;
    try {
      await symlink(join(baseRoot, name), join(overlay, name));
    } catch {
      /* ignore EEXIST */
    }
  }
  // Apply each staged file: remove symlinked path along its prefix,
  // materialize real dirs, copy the file.
  for (const rel of stagedFiles) {
    const parts = rel.split("/");
    let cursor = overlay;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      if (!segment) continue;
      const path = join(cursor, segment);
      let s;
      try {
        // V38 (2026-06-12): lstat, NOT stat. stat FOLLOWS symlinks, so a
        // symlinked top-level dir (overlay/src -> baseRoot/src) reported
        // isDirectory()=true, the materialize branch never fired, and the
        // staged-file copy below wrote THROUGH the symlink into the LIVE
        // baseRoot tree. That corrupted the running vessel source mid-evaluate
        // and then tripped the cutover's base_sha freshness gate. lstat sees
        // the symlink itself (isDirectory()=false) so we materialize a real dir.
        s = await lstat(path);
      } catch {
        s = null;
      }
      if (!s || !s.isDirectory()) {
        try {
          await unlink(path);
        } catch {
          /* not a symlink/file */
        }
        await mkdir(path, { recursive: true });
        // Re-link existing entries from the real base subdir.
        const realSub = join(baseRoot, parts.slice(0, i + 1).join("/"));
        try {
          const subEntries = (await readdir(realSub, { withFileTypes: true })) as unknown as Array<{
            name: string;
          }>;
          for (const sub of subEntries) {
            try {
              // TEST FILES MUST BE REAL COPIES, NOT SYMLINKS (2026-08-09).
              //
              // A symlinked test executes at its REAL path in baseRoot, so its
              // relative imports resolve against baseRoot — `import "./goal-intent"`
              // loads the UNPATCHED source, never the staged copy sitting beside it
              // in the overlay. The suite then passes honestly about code that was
              // never patched, and the delta reports "0 introduced".
              //
              // MEASURED, probe validated in both directions before trusting it:
              // base tree 7 pass/0 fail; same suite against the staged (broken)
              // goal-intent.ts 2 FAIL; the gate ran it from
              // `../gv-base/src/goal-intent.test.ts` and returned FAVORABLE 7/0.
              // That is how a commit disabling the isEditIntentGoal path guard
              // landed FAVORABLE and pushed to origin/dev.
              //
              // Only test files are copied: they are few and small, and they are the
              // only entries whose module resolution decides WHICH TREE gets tested.
              // Everything else stays symlinked, so the cheap-overlay property holds.
              if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(sub.name)) {
                await copyFile(join(realSub, sub.name), join(path, sub.name));
              } else {
                await symlink(join(realSub, sub.name), join(path, sub.name));
              }
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* realSub missing — staged file introducing a new dir */
        }
      }
      cursor = path;
    }
    const target = join(overlay, rel);
    try {
      await unlink(target);
    } catch {
      /* not present */
    }
    const src = join(mitosisRoot, rel);
    if (await pathExists(src)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(src, target);
    }
  }
  return overlay;
}

/**
 * Normalize a static-check output blob into the SET of error SIGNATURES it reports.
 * A signature drops the volatile `path(line,col): ` prefix (robust to line shifts) but
 * keeps `TS<code>: <message>` (the message carries the distinguishing identifier), and
 * folds shape-dispatch violations in per-shape. The mitosis delta gate accepts a staged
 * change iff its signature set is a SUBSET of the base's — i.e. it introduces no NEW
 * error the baseline lacked. Exported so the regression it guards (a syntax break or an
 * out-of-scope-name type error that a raw line-COUNT waves through) is pinned by test.
 */
export function signatureSet(out: string): Set<string> {
  const sigs = new Set<string>();
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    const ts = line.match(/error TS\d+:.*/);
    if (ts) { sigs.add(ts[0].replace(/\s+/g, " ").trim()); continue; }
    const sd = line.match(/\[(?:unhandled|orphan)\]\s+\S+/);
    if (sd) { sigs.add(sd[0].replace(/\s+/g, " ").trim()); continue; }
    if (line.includes("UNHANDLED ADVERTISED SHAPES")) sigs.add("UNHANDLED ADVERTISED SHAPES");
    else if (line.includes("ORPHAN DISPATCH HANDLERS")) sigs.add("ORPHAN DISPATCH HANDLERS");
    else if (/violation\(s\) found/.test(line)) sigs.add("violation(s) found");
  }
  return sigs;
}

// ── GOLDEN-DRIFT GATE (2026-07-30) ──────────────────────────────────────────
// A vessel MAY ship a self-contained "golden" drift test that EXECUTES its
// route-as-data selector cells over a real fixture and asserts each cell's shell
// fragment and JS oracle AGREE (goal-host-vessel's test/reach-routes-golden.test.ts).
// That test cannot run in the SRC-ONLY synced /vessels/<v> base (no test/ dir) nor
// in the sparse mitosis dir, so the normal typecheck/lint gate never exercises it —
// a drifted selector cell would land and serve hollow greens. This stage runs that
// golden test against the IN-CONTAINER git clone (which HAS test/ + the route-as-data
// src) with the STAGED src overlaid on top, so the cell BEING LANDED is what executes.
//
// CONDITIONAL: only vessels whose clone carries the golden test file engage it
// (absent → SKIP, NOT fail-closed — most vessels have no such test). FAIL-CLOSED
// (per the 530c1e9 lesson): once engaged, an inability to run (spawn error / missing
// node_modules / module-load error / no parseable test summary) → REFUSE
// (golden_drift_inconclusive), and a genuine test failure → REFUSE
// (golden_drift_failed). A SIGTERM timeout is treated like every other static check
// (V40): inconclusive-DEFER (timed_out), not a terminal regression, so a transient
// under load re-evaluates next tick rather than permanently halting the whole fleet.
const GOLDEN_TEST_REL = "test/reach-routes-golden.test.ts";
const DEFAULT_CLONE_REPO_ROOT = "/workspace/git/super-repo/repos";

/** Parse a `bun test` summary tail into pass/fail counts (null when absent). */
function parseBunTestCounts(out: string): { pass: number | null; fail: number | null } {
  const p = out.match(/(\d+)\s+pass\b/);
  const f = out.match(/(\d+)\s+fail\b/);
  return { pass: p ? Number(p[1]) : null, fail: f ? Number(f[1]) : null };
}

type GoldenGateOutcome =
  | { kind: "skip" }
  | { kind: "pass"; check: StaticCheckResult }
  | { kind: "failed"; check: StaticCheckResult }
  | { kind: "inconclusive"; check: StaticCheckResult | null; detail: string }
  | { kind: "timeout"; check: StaticCheckResult };

/**
 * Run a vessel's golden drift test (if it ships one) against a temp overlay that
 * combines: the clone's test/ + src/ (REAL files, so the test's relative
 * `../src/index.ts` import resolves INTO the overlay), the STAGED src overlaid on
 * top (so the cell being landed is what executes), and node_modules symlinked from
 * the vessel's live base (the clone carries no node_modules). Torn down afterward.
 */
async function runGoldenDriftGate(args: {
  cloneRepoRoot: string;
  vesselName: string;
  bunCmd: string;
  mitosisRoot: string;
  stagedFiles: string[];
  nmSourceRoot: string | null;
}): Promise<GoldenGateOutcome> {
  const cloneDir = join(args.cloneRepoRoot, args.vesselName);
  const goldenTestAbs = join(cloneDir, GOLDEN_TEST_REL);
  if (!(await pathExists(goldenTestAbs))) return { kind: "skip" };

  let overlay: string | null = null;
  try {
    overlay = join(
      tmpdir(),
      `golden-drift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(overlay, { recursive: true });
    // Real-copy every top-level clone entry (test/, src/, package.json, tsconfig,
    // bun.lock …). The clone is src+test only (no node_modules), so this is cheap.
    const tops = (await readdir(cloneDir, { withFileTypes: true })) as unknown as Array<{
      name: string;
    }>;
    for (const e of tops) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      await cp(join(cloneDir, e.name), join(overlay, e.name), { recursive: true });
    }
    // node_modules: the golden test imports the vessel entrypoint, which pulls in
    // real deps (e.g. @anthropic-ai/sdk). The clone has none; symlink them from the
    // live base. Without a resolvable node_modules the test cannot run → fail closed
    // (inconclusive), never delta-excused.
    if (!(await pathExists(join(overlay, "node_modules")))) {
      const nmSrc =
        args.nmSourceRoot && (await pathExists(join(args.nmSourceRoot, "node_modules")))
          ? args.nmSourceRoot
          : (await pathExists(join(cloneDir, "node_modules")))
            ? cloneDir
            : null;
      if (!nmSrc) {
        return {
          kind: "inconclusive",
          check: null,
          detail: `no resolvable node_modules to build the golden overlay (checked ${args.nmSourceRoot ?? "<none>"} and ${cloneDir})`,
        };
      }
      await symlink(join(nmSrc, "node_modules"), join(overlay, "node_modules"));
    }
    // Overlay the STAGED src files (the version being landed) on top of the clone
    // src, so the golden test executes the cell being added — the whole point.
    for (const rel of args.stagedFiles) {
      const src = join(args.mitosisRoot, rel);
      if (!(await pathExists(src))) continue;
      const target = join(overlay, rel);
      await mkdir(dirname(target), { recursive: true });
      try {
        await rm(target, { force: true });
      } catch {
        /* not present */
      }
      await copyFile(src, target);
    }
    // Execute the golden test IN the overlay (its self-contained fixtures spawn bash
    // + mkdtemp; only the `../src/index.ts` import depends on cwd).
    const check = await runCheck(
      args.bunCmd,
      ["test", GOLDEN_TEST_REL],
      overlay,
      "golden-drift: reach-routes-golden",
    );
    if (check.timed_out) return { kind: "timeout", check };
    if (check.output_tail.includes("spawn_error")) {
      return { kind: "inconclusive", check, detail: "spawn_error running the golden test" };
    }
    const { pass, fail } = parseBunTestCounts(check.output_tail);
    // No parseable summary, or ZERO assertions ran → the harness never meaningfully
    // executed (e.g. a module-load error). Cannot verify → refuse.
    if (pass === null || pass === 0) {
      return {
        kind: "inconclusive",
        check,
        detail: `golden test did not execute any assertions (pass=${pass ?? "?"} fail=${fail ?? "?"} exit=${check.exit_code}) — likely a module-load/resolution error, not a clean run`,
      };
    }
    // Assertions ran: any failure (or a non-zero exit) is a genuine drift / ownership
    // break in the staged selector table.
    if ((fail ?? 0) > 0 || check.exit_code !== 0) {
      return { kind: "failed", check };
    }
    return { kind: "pass", check };
  } catch (err) {
    return {
      kind: "inconclusive",
      check: null,
      detail: `golden overlay build/run threw: ${(err as Error).message}`,
    };
  } finally {
    if (overlay) {
      try {
        await rm(overlay, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export async function staticEvaluate(
  mitosisRoot: string,
  bunCmd: string,
  baseRootForOverlay?: string,
  stagedFiles?: string[],
  scripts: string[] = ["lint"],
  skipTests = false,
  cloneRepoRoot: string = DEFAULT_CLONE_REPO_ROOT,
): Promise<StaticEvalResult> {
  const start = Date.now();
  if (!(await pathExists(mitosisRoot))) {
    return {
      attempted: false,
      ok: false,
      reason: "static_eval_unavailable: mitosis_root missing",
      checks: [],
      duration_ms: Date.now() - start,
    };
  }
  // Decide which directory to run checks in.
  let runRoot = mitosisRoot;
  const mitosisHasPkg = await pathExists(join(mitosisRoot, "package.json"));
  if (!mitosisHasPkg) {
    // Need an overlay against a base that DOES have package.json.
    if (
      !baseRootForOverlay ||
      !stagedFiles ||
      stagedFiles.length === 0 ||
      !(await pathExists(join(baseRootForOverlay, "package.json")))
    ) {
      return {
        attempted: false,
        ok: false,
        reason:
          "static_eval_unavailable: mitosis_root lacks package.json and no static_check_base_root+staged_files supplied",
        checks: [],
        duration_ms: Date.now() - start,
      };
    }
    try {
      runRoot = await buildOverlay(baseRootForOverlay, mitosisRoot, stagedFiles);
    } catch (err) {
      return {
        attempted: false,
        ok: false,
        reason: `static_eval_unavailable: overlay build failed: ${(err as Error).message}`,
        checks: [],
        duration_ms: Date.now() - start,
      };
    }
  }
  const completed: StaticCheckResult[] = [];
  for (const scriptName of scripts) {
    const r = await runCheck(
      bunCmd,
      ["run", scriptName],
      runRoot,
      `bun run ${scriptName}`,
    );
    completed.push(r);
    if (r.timed_out) {
      // V40 (2026-06-30): the check was SIGTERM-killed by STATIC_CHECK_TIMEOUT_MS
      // — it produced no completed verdict, so we cannot tell whether the code
      // compiles. This is NOT a regression; framing it as one terminally rejects
      // a change that may well be clean. Return a DISTINCT inconclusive result so
      // the caller defers and re-evaluates next tick in a quieter window.
      return {
        attempted: true,
        ok: false,
        reason: `static_check_timeout: '${scriptName}' killed after ${STATIC_CHECK_TIMEOUT_MS}ms (exit=${r.exit_code}) — inconclusive, NOT a regression`,
        checks: completed,
        duration_ms: Date.now() - start,
        timed_out: true,
      };
    }
    if (r.exit_code !== 0) {
      // V32 (2026-06-09): delta-aware verdict. Vessels carry pre-existing
      // baseline typecheck errors (e.g. boredom-vessel src/index.ts:1805
      // METABOB_API_KEY undefined — present months before any V25-V31 work).
      // A binary exit≠0 → UNFAVORABLE gate makes the autonomous repair loop
      // unreachable: every staged patch fails even when it doesn't worsen
      // the baseline. The idiom shift — patches must not REGRESS the static
      // health, but they need not perfect it — matches how vessel_mitosis
      // already treats trace verdicts (better-than-base, not best-possible).
      //
      // Compare error-line counts. If the base tree has the same or more
      // matching errors than the mitosis tree, treat as pass. Only run the
      // base check when we actually have baseRootForOverlay (the overlay
      // path); without it we can't compute a baseline, so we keep the strict
      // gate behaviour.
      let isRegression = true;
      let baseErrorCount = -1;
      let mitosisErrorCount = -1;
      let newSignatures: string[] = [];
      let syntaxBail = false;
      if (baseRootForOverlay && stagedFiles && stagedFiles.length > 0) {
        // Count BOTH tsc errors AND shape-dispatch violations. check-shape-dispatch
        // (the three-place-rule lint) exits 1 with NO `error TS` line, so a tsc-only
        // count delta-excuses a HALF-WIRED new resolver — an advertised shape with no
        // dispatch case (or vice-versa) — letting it slip FAVORABLE into a cutover.
        // This is the Seam-③ soundness fix (2026-06-19): closing the gate hole that
        // made net-new-resolver authoring unsafe. See SUBSTRATE_AS_DEC §4.4.
        // Delta-aware by SIGNATURE SUBSET, not line count. A raw error-line count is
        // NOT monotone (contra the old "count is monotone" note): a NEW *syntax* error
        // makes tsc bail EARLY and emit FEWER `error TS` lines than a dirty base
        // (0f794d2: `Record<string, unknown)` + duplicate `let ageMs` → accepted-yet-
        // unparseable, vessel DOWN), and a new TYPE error can enter at unchanged/lower
        // count because tsc suppresses the cascades it feeds (5697f70: TS2552 'parentId').
        // So compare the SET of normalized error SIGNATURES: strip the volatile
        // `path(line,col): ` prefix (robust to line shifts) but KEEP `TS<code>: <message>`
        // (the message carries the distinguishing id). Accept iff every mitosis signature
        // already exists in base (mitosis ⊆ base). Shape-dispatch markers are folded in
        // per-shape so a half-wired new resolver (advertised shape, no case) is a NEW
        // signature even on a dirty base — preserving the Seam-③ soundness fix.
        const mitosisSigs = signatureSet(r.output_tail);
        const baseCheck = await runCheck(bunCmd, ["run", scriptName], baseRootForOverlay, `base:bun run ${scriptName}`);
        const baseSigs = signatureSet(baseCheck.output_tail);
        newSignatures = [...mitosisSigs].filter((sig) => !baseSigs.has(sig));
        // Sizes kept for the human-readable note ONLY; the DECISION is the subset test.
        mitosisErrorCount = mitosisSigs.size;
        baseErrorCount = baseSigs.size;
        // Primary guard, robust to checker-prose drift: a script the BASE passes
        // (exit 0) but the mitosis tree FAILS (exit≠0) is by definition a NEW
        // regression — never delta-excuse it regardless of parsed counts. This is
        // what closes the shape-dispatch-only hole even if the markers above drift.
        const cleanBaseDirtyMitosis = baseCheck.exit_code === 0 && r.exit_code !== 0;
        // Accept only if NOT a clean-base/dirty-mitosis regression AND mitosis
        // introduces no new counted errors. Count is monotone for tsc (line numbers
        // shift, but mitosis_count > base_count ⇒ new errors); the exit-code guard
        // covers checkers whose failures the count regex can't see.
        const hasSpawnError = (s: string) => s.includes("spawn_error") || s.includes("Executable not found");
      if (hasSpawnError(r.output_tail) || hasSpawnError(baseCheck.output_tail)) {
        return {
          attempted: true,
          ok: false,
          reason: `static_check_inconclusive: spawn_error during '${scriptName}' — bun not found in spawn env; deferred for retry`,
          checks: completed,
          duration_ms: Date.now() - start,
          timed_out: true,
        };
      }
      // SCRIPT-MISSING FAIL-CLOSED (2026-07-30): a check that DID NOT ACTUALLY RUN is not
      // evidence of health. `bun run <name>` for an absent script prints `Script not found
      // "<name>"` and exits non-zero with ZERO `error TS` lines — so BOTH the overlay and the
      // base normalize to the EMPTY signature set and the subset test (mitosis ⊆ base) passes
      // TRIVIALLY, delta-excusing a tree that was NEVER TYPECHECKED. This is precisely how two
      // broken goal-host commits slipped (TS2451 redeclare + TS2345 cross-file async): the
      // landing gate ran `bun run lint`, but goal-host-vessel has no `lint` script (only
      // `typecheck`). A missing check script is a HARD refuse (we could not verify) — never a
      // delta-excuse, and NOT a deferrable timeout (the script is still absent next tick, so a
      // defer would loop forever). patch_with_tools is separately fixed to pass the vessel's
      // real check script; this backstop guarantees a delta-excuse only ever compares checks
      // that GENUINELY EXECUTED.
      const hasMissingScript = (s: string) => /Script not found/i.test(s);
      if (hasMissingScript(r.output_tail) || hasMissingScript(baseCheck.output_tail)) {
        return {
          attempted: true,
          ok: false,
          reason: `static_check_script_missing: '${scriptName}' is not a script in this vessel (bun: "Script not found") — cannot typecheck; refusing to delta-excuse an UNVERIFIED tree`,
          checks: completed,
          duration_ms: Date.now() - start,
        };
      }
      // SYNTAX-BAIL GUARD: tsc reserves TS1xxx for grammar/parse errors, on which it stops
      // parsing early — so the emitted error set is TRUNCATED and its signatures (generic
      // messages like "TS1005: ',' expected.") collide across files. A subset comparison over
      // a truncated set is unsound: a NEW syntax error can normalize to a signature already
      // present in a syntax-dirty base and slip through as new=0. When either tree shows a
      // parse bail, never delta-excuse — fail closed. (Closes the dirty-base cascade where one
      // syntax-broken landing let every subsequent broken patch land as a "subset".)
      // FAIL-CLOSED CLASSES (never delta-excuse):
      //  • TS1xxx — grammar/parse bails; tsc stops early → TRUNCATED error set whose generic
      //    signatures collide across files, so a subset comparison is unsound.
      //  • TS2300 / TS2440 / TS2451 / TS2393 — duplicate-identifier, duplicate-import, redeclare
      //    of a block-scoped variable, duplicate function implementation. The tree does NOT
      //    compile and the class is cascade-prone: a NEW one can normalize to a signature already
      //    present in a dirty base and slip through as new=0. A redeclare/duplicate is never a
      //    legitimate "pre-existing baseline to build on" (contrast boredom-vessel's long-standing
      //    TS2304 METABOB_API_KEY-undefined baseline, which is NOT fail-closed and stays
      //    delta-excused). When either tree shows one of these, fail closed.
      const hasParseBail = (s: string) => /error TS1\d{3}:/.test(s) || /error TS(?:2300|2440|2451|2393):/.test(s);
      syntaxBail = hasParseBail(r.output_tail) || hasParseBail(baseCheck.output_tail);
      if (!cleanBaseDirtyMitosis && !syntaxBail && newSignatures.length === 0) {
          isRegression = false;
          completed.push({
            ...baseCheck,
            name: `base:${baseCheck.name} (delta_aware: mitosis_sigs=${mitosisErrorCount} base_sigs=${baseErrorCount} new=0 → accept)`,
          });
        }
      }
      if (isRegression) {
        return {
          attempted: true,
          ok: false,
          reason: `${scriptName}_failed: exit=${r.exit_code}${syntaxBail ? " fail_closed=true (parse-bail TS1xxx or duplicate-symbol TS2300/2440/2451/2393 in either tree — subset unsound, failed closed)" : ""}${baseErrorCount >= 0 ? ` new_errors(${newSignatures.length})=[${newSignatures.slice(0, 5).join(" | ")}${newSignatures.length > 5 ? ` +${newSignatures.length - 5}` : ""}] (regression)` : ""}`,
          checks: completed,
          duration_ms: Date.now() - start,
        };
      }
      // Patch doesn't regress baseline — continue to next script (or finish).
    }
  }
  // ── GOLDEN-DRIFT GATE: run the vessel's executable selector-drift test (if it
  // ships one) against the clone + STAGED src. Runs on BOTH the skip_tests and the
  // normal paths — a shell-vs-oracle drift is a determinism defect, not a flaky
  // test, and must gate every cutover. Conditional + fail-closed (see helper above).
  {
    const vesselName = baseRootForOverlay
      ? basename(baseRootForOverlay)
      : basename(mitosisRoot).replace(/-mitosis-.*$/, "");
    const nmSourceRoot = baseRootForOverlay ?? mitosisRoot;
    const golden = await runGoldenDriftGate({
      cloneRepoRoot,
      vesselName,
      bunCmd,
      mitosisRoot,
      stagedFiles: stagedFiles ?? [],
      nmSourceRoot,
    });
    if (golden.kind === "timeout") {
      completed.push(golden.check);
      return {
        attempted: true,
        ok: false,
        reason: `static_check_timeout: golden-drift 'reach-routes-golden' killed after ${STATIC_CHECK_TIMEOUT_MS}ms (exit=${golden.check.exit_code}) — inconclusive, NOT a regression (defer-and-retry)`,
        checks: completed,
        duration_ms: Date.now() - start,
        timed_out: true,
      };
    }
    if (golden.kind === "inconclusive") {
      if (golden.check) completed.push(golden.check);
      return {
        attempted: true,
        ok: false,
        reason: `evaluate_refused: golden_drift_inconclusive — ${golden.detail}; refusing to land an UNVERIFIED selector table (fail-closed per the 530c1e9 lesson)`,
        checks: completed,
        duration_ms: Date.now() - start,
      };
    }
    if (golden.kind === "failed") {
      completed.push(golden.check);
      return {
        attempted: true,
        ok: false,
        reason: `evaluate_refused: golden_drift_failed — the reach-routes golden fixture gate FAILED on the staged src (a SELECTORS shell-vs-oracle arithmetic drift or a route-ownership break); a drifted selector serves hollow greens`,
        checks: completed,
        duration_ms: Date.now() - start,
      };
    }
    if (golden.kind === "pass") {
      completed.push(golden.check);
    }
    // golden.kind === "skip" → vessel ships no golden test; proceed unchanged.
  }
  if (!skipTests) {
    const test = await runCheck(bunCmd, ["test"], runRoot, "bun test", SUITE_CHECK_TIMEOUT_MS);
    completed.push(test);
    if (test.timed_out) {
      // V40: same inconclusive treatment as the script checks above.
      return {
        attempted: true,
        ok: false,
        reason: `static_check_timeout: 'bun test' killed after ${SUITE_CHECK_TIMEOUT_MS}ms (exit=${test.exit_code}) — inconclusive, NOT a regression`,
        checks: completed,
        duration_ms: Date.now() - start,
        timed_out: true,
      };
    }
    if (test.exit_code !== 0) {
      // BASELINE-DELTA, NOT ABSOLUTE. `exit_code !== 0` refuses a landing whenever the
      // vessel's suite is red for ANY reason, including reds that predate the patch.
      // development-vessel sits at 76 pre-existing failures; goal-host at 4. Against an
      // absolute gate every landing on those vessels is refused for reasons the patch did
      // not cause — which is exactly why this check was disabled with skip_tests instead
      // of fixed, and why 76 reds then accumulated behind a gate that never ran.
      //
      // feature_compose already solved this at feature-compose.ts (testFailureSet +
      // `newTest = curTest \ baseTest`), explicitly so that "pre-existing reds in an
      // unrelated test file don't wedge every autonomous edit". Same rule here: run the
      // BASE tree, subtract its failures, and refuse only on failures this patch
      // INTRODUCED.
      //
      // If the base run cannot be produced, fail CLOSED on the absolute result rather
      // than guessing — an unknown baseline must not become a free pass.
      const baseForDelta = mitosisHasPkg ? null : baseRootForOverlay;
      let newFailures: string[] | null = null;
      if (baseForDelta) {
        const cached = baselineSuiteCache.get(baseForDelta);
        const baseTest = cached && Date.now() - cached.at < BASELINE_CACHE_TTL_MS
          ? cached.result
          : await runCheck(bunCmd, ["test"], await buildOverlay(baseForDelta, baseForDelta, stagedFiles ?? []), "bun test (baseline)", SUITE_CHECK_TIMEOUT_MS);
        if (!cached || Date.now() - cached.at >= BASELINE_CACHE_TTL_MS) {
          if (!baseTest.timed_out) baselineSuiteCache.set(baseForDelta, { at: Date.now(), result: baseTest });
        }
        // Both tails must be COMPLETE. output_tail is capped at OUTPUT_TAIL_BYTES; a
        // truncated run silently loses failure lines, which would fabricate "new"
        // failures on one side or hide them on the other. If either side hit the cap the
        // comparison is untrustworthy, so leave newFailures null and fail closed below.
        const curTail = test.output_tail ?? "";
        const baseTail = baseTest.output_tail ?? "";
        const truncated = curTail.length >= OUTPUT_TAIL_BYTES || baseTail.length >= OUTPUT_TAIL_BYTES;
        if (!baseTest.timed_out && !truncated) {
          const cur = testFailureNames(curTail);
          const base = testFailureNames(baseTail);
          // A PARSE THAT CONTRADICTS BUN'S OWN SUMMARY IS NOT A MEASUREMENT.
          // If either side reports `N fail` and we extracted none, the pattern has
          // drifted from the runner's output again; leaving newFailures null routes
          // to the inconclusive branch instead of silently reporting "0 introduced",
          // which is exactly how the dead `(fail)` pattern disarmed this gate.
          if (
            testFailureParseIsConsistent(curTail, cur) &&
            testFailureParseIsConsistent(baseTail, base)
          ) {
            newFailures = [...cur].filter((t) => !base.has(t));
          } else {
            console.error(
              `[mitosis-evaluate] test failure parse DISAGREES with bun's summary (cur=${cur.size} base=${base.size}) — treating the delta as unknown rather than zero; the output format has probably changed`,
            );
          }
        }
      }
      if (newFailures !== null && newFailures.length === 0) {
        completed.push({ ...test, name: `bun test (${testFailureNames(test.output_tail ?? "").size} pre-existing red(s), 0 introduced)` });
      } else if (newFailures === null) {
        // AN UNPRODUCIBLE BASELINE IS INCONCLUSIVE, NOT A FAILURE.
        //
        // I shipped this as "failing closed" and it WEDGED autonomous landings on
        // development-vessel within the hour. The baseline run is a second full suite,
        // so the pair routinely exceeds STATIC_CHECK_TIMEOUT_MS (120s) — the journal
        // shows `bun test killed after 120000ms (exit=143)` followed by
        // `tests_failed: exit=1 (no baseline available — failing closed)`, and the
        // cutover then failed on every retry. Its mitosis-pending marker never cleared,
        // which in turn deferred pull-sync for 30 minutes until the TTL bailed it out.
        // One over-strict gate stalled the whole convergence path.
        //
        // Fail-closed is right when a check RAN and disagreed. It is wrong when the
        // check could not run at all: that is the same inconclusive state the
        // surrounding code already treats as INSUFFICIENT_DATA and defers on, and
        // treating "I could not measure" as "I measured a failure" is precisely the
        // confusion this file's timeout branch above exists to avoid.
        //
        // So report it as a TIMEOUT-class inconclusive result. The caller defers and
        // retries rather than recording a regression that was never observed.
        return {
          attempted: true,
          ok: false,
          reason: `static_check_timeout: baseline suite did not complete (overlay exit=${test.exit_code}); delta undecidable — INCONCLUSIVE, not a regression`,
          checks: completed,
          duration_ms: Date.now() - start,
          timed_out: true,
        };
      } else {
        return {
          attempted: true,
          ok: false,
          reason: `tests_failed: ${newFailures.length} failure(s) INTRODUCED by this patch: ${newFailures.slice(0, 5).join(" ; ").slice(0, 400)}`,
          checks: completed,
          duration_ms: Date.now() - start,
        };
      }
    }
  }
  return {
    attempted: true,
    ok: true,
    reason: "static_checks_pass",
    checks: completed,
    duration_ms: Date.now() - start,
  };
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:8080/v2/activities/execution-traces";
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_MIN_TRACES = 3;
const DEFAULT_THRESHOLD = 0.1;

interface TraceLike {
  execution_id?: unknown;
  id?: unknown;
  status?: unknown;
  failure_mode?: unknown;
  metadata?: unknown;
  executed_at?: unknown;
}

function versionIdOf(t: TraceLike, baseId: string, mitosisId: string): string | null {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    md["version_id"],
    md["mitosis_version_id"],
    md["dispatch_target_template_id"],
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      if (c === baseId || c === mitosisId) return c;
      if (c.includes(mitosisId)) return mitosisId;
      if (c.includes(baseId)) return baseId;
    }
  }
  return null;
}

function execIdOf(t: TraceLike): string {
  if (typeof t.execution_id === "string" && t.execution_id.length > 0) return t.execution_id;
  if (typeof t.id === "string") return t.id;
  return "unknown";
}

function failureModeTypeOf(t: TraceLike): string | null {
  const fm = t.failure_mode;
  if (!fm || typeof fm !== "object") return null;
  const type = (fm as { type?: unknown }).type;
  if (typeof type === "string" && type.length > 0) return type;
  return null;
}

interface VersionStats {
  version_id: string;
  total: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  failure_mode_classes: string[];
  sample_trace_ids: string[];
}

function emptyStats(version_id: string): VersionStats {
  return {
    version_id,
    total: 0,
    succeeded: 0,
    failed: 0,
    success_rate: 0,
    failure_mode_classes: [],
    sample_trace_ids: [],
  };
}

export async function resolveVesselMitosisEvaluate(
  pointer: VesselMitosisEvaluatePointer,
): Promise<ResolverResult> {
  const baseId = pointer.base_version_id;
  const mitosisId = pointer.mitosis_version_id;
  if (!baseId && !mitosisId) {
    return {
      shape: "vesselMitosisEvaluation",
      body: {
        base_version_id: "",
        mitosis_version_id: "",
        verdict: "INSUFFICIENT_DATA",
        verdict_reason: "no_pending_mitosis",
        evaluated_at: new Date().toISOString(),
      },
    };
  }
  if (!baseId || !mitosisId) {
    return {
      shape: "structuredError",
      body: {
        resolver: "vessel_mitosis_evaluate",
        detail: "base_version_id and mitosis_version_id are required",
      },
    };
  }
  const minTraces = pointer.min_traces_per_version ?? DEFAULT_MIN_TRACES;
  const threshold = pointer.success_rate_advantage_threshold ?? DEFAULT_THRESHOLD;
  const fetchLimit = pointer.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const url = (pointer.tracesUrl ?? DEFAULT_TRACES_URL) + `?limit=${fetchLimit}`;

  // V8 (2026-06-05): deterministic verdict within an hour bucket.
  // Previously the trace-path verdict drifted across calls on the same
  // mitosis pair because the trace fetch returned whatever happened to be
  // the most recent N rows at request time. Same input must yield same
  // verdict to be a usable signal. We bucket time to the hour and use it
  // as the lower bound of the trace window when no explicit `since` is
  // supplied — repeated calls within the same hour see identical input.
  const HOUR_MS = 60 * 60 * 1000;
  // 30-day window — wide enough to capture all reasonably-recent traces
  // for a mitosis evaluation, narrow enough that the trace fetch (limit=200)
  // sees the same set across calls within an hour. The hour bucket on
  // `bucketNow` is the determinism anchor; the window length only sets
  // the lower bound of "ancient" traces we ignore.
  const DEFAULT_WINDOW_HOURS = 24 * 30;
  const bucketNow = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const defaultSince = new Date(bucketNow - DEFAULT_WINDOW_HOURS * HOUR_MS).toISOString();

  // ---- Static evaluation gate (2026-06-04) ----
  // Idiomatic substrate discipline: run lint + tests inside the mitosis dir
  // before consulting traces. Lets freshly-staged mitoses reach FAVORABLE
  // without waiting for runtime traces. Sufficient by itself for FAVORABLE
  // when checks pass.
  // V38 (2026-06-12): coerce staged_files. The mitosis-tick template passes it
  // as {{extract_staged_files_content}} — json_path_extract + variable
  // substitution STRINGIFY the array, so the resolver receives the literal
  // string '["src/...ts"]' not an array. staticEvaluate then iterated the
  // string char-by-char, buildOverlay tried to copyfile the mitosis_root dir
  // itself (ENOTSUP), returned attempted:false, and the verdict fell through to
  // the trace path → INSUFFICIENT_DATA → cutover refused a perfectly good patch.
  const stagedFilesArr: string[] = Array.isArray(pointer.staged_files)
    ? (pointer.staged_files as string[])
    : typeof pointer.staged_files === "string"
      ? (() => { try { const p = JSON.parse(pointer.staged_files as unknown as string); return Array.isArray(p) ? (p as string[]) : [pointer.staged_files as unknown as string]; } catch { return [pointer.staged_files as unknown as string]; } })()
      : [];
  let staticResult: StaticEvalResult | null = null;
  if (pointer.mitosis_root && pointer.static_check_runner !== "skip") {
    const bunCmd = pointer.bun_cmd ?? Bun.which("bun") ?? "/root/.bun/bin/bun";
    staticResult = await staticEvaluate(
      pointer.mitosis_root,
      bunCmd,
      pointer.static_check_base_root,
      stagedFilesArr,
      pointer.static_check_scripts,
      pointer.skip_tests ?? false,
    );
    console.error(`[mitosis-evaluate] static attempted=${staticResult.attempted} ok=${staticResult.ok} reason=${staticResult.reason} | mitosis_root=${pointer.mitosis_root} base=${pointer.static_check_base_root} staged_files=${JSON.stringify(pointer.staged_files)} (type ${typeof pointer.staged_files}) scripts=${JSON.stringify(pointer.static_check_scripts)}`);
    if (staticResult.attempted && staticResult.timed_out) {
      // V40 (2026-06-30): the static check was SIGTERM-killed by the timeout —
      // no completed verdict, so this is INCONCLUSIVE, not a regression. Emit
      // INSUFFICIENT_DATA (NOT UNFAVORABLE) so the cutover treats it as
      // defer-and-retry-next-tick (the existing INSUFFICIENT_DATA/NEUTRAL soft
      // path) and re-evaluates in a quieter window — instead of terminally
      // rejecting a change that may well compile. A genuine non-zero tsc exit
      // WITH error output never reaches here (it is not flagged timed_out) and
      // still produces UNFAVORABLE below.
      const timedOutCheck = staticResult.checks.find((c) => c.timed_out);
      console.error(`[mitosis-evaluate] static_check_timeout → INSUFFICIENT_DATA (defer) reason=${staticResult.reason}`);
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "INSUFFICIENT_DATA",
          verdict_reason: staticResult.reason,
          static_check_timeout: true,
          static_evaluation: staticResult,
          cited_check_name: timedOutCheck?.name ?? "unknown",
          cited_check_output_tail: timedOutCheck?.output_tail ?? "",
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    if (staticResult.attempted && !staticResult.ok) {
      const firstFail = staticResult.checks.find((c) => c.exit_code !== 0);
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "UNFAVORABLE",
          verdict_reason: staticResult.reason,
          static_evaluation: staticResult,
          cited_check_name: firstFail?.name ?? "unknown",
          cited_check_output_tail: firstFail?.output_tail ?? "",
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    if (staticResult.attempted && staticResult.ok) {
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "FAVORABLE",
          verdict_reason: "static_checks_pass",
          static_evaluation: staticResult,
          cited_check_names: staticResult.checks.map((c) => c.name),
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    // staticResult.attempted === false → fall through to trace path.
  }

  const apiKey = process.env["METABOB_API_KEY"];
  const bearerToken = process.env["ACTIVITY_API_TOKEN"] ?? process.env["VESSEL_JWT"];
  const headers: Record<string, string> = apiKey ? { Authorization: `ApiKey ${apiKey}` } : bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};

  let traces: TraceLike[] = [];
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      // Transient activity-api unavailability is the substrate's "no
      // runtime evidence available right now" — the audited NO, not a
      // chain failure. Emit vesselMitosisEvaluation{INSUFFICIENT_DATA}
      // so cutover sees the verdict (and refuses cleanly) instead of
      // structuredError being silently dropped by the engine top-level
      // catch. Mirrors the pattern from 74542cc/875d539/f9573a3/befb371.
      return {
        shape: "vesselMitosisEvaluation",
        body: {
          base_version_id: baseId,
          mitosis_version_id: mitosisId,
          verdict: "INSUFFICIENT_DATA",
          verdict_reason: `activity_api_traces_returned_${resp.status}`,
          evaluated_at: new Date().toISOString(),
        },
      };
    }
    const json = (await resp.json()) as { executions?: unknown; traces?: unknown };
    const arr = Array.isArray(json.executions)
      ? json.executions
      : Array.isArray(json.traces)
        ? json.traces
        : [];
    traces = arr as TraceLike[];
  } catch (err) {
    // Same audited-NO pattern as the 4xx/5xx branch above: trace-fetch
    // failure is the substrate's "no runtime evidence available" signal,
    // not a chain crash. Cutover will see the INSUFFICIENT_DATA verdict
    // and either accept it via static-eval cited_check_names or
    // soft-refuse cleanly.
    return {
      shape: "vesselMitosisEvaluation",
      body: {
        base_version_id: baseId,
        mitosis_version_id: mitosisId,
        verdict: "INSUFFICIENT_DATA",
        verdict_reason: `traces_fetch_failed: ${(err as Error).message.slice(0, 200)}`,
        evaluated_at: new Date().toISOString(),
      },
    };
  }

  // V8: clamp to deterministic window. `pointer.since` wins when supplied;
  // otherwise we use the hour-bucketed default so repeated calls within the
  // same hour observe the same trace set.
  const since = pointer.since ?? defaultSince;
  traces = traces.filter((t) => {
    const ts = typeof t.executed_at === "string" ? t.executed_at : "";
    return ts >= since;
  });

  const base = emptyStats(baseId);
  const mitosis = emptyStats(mitosisId);
  const baseFMs = new Set<string>();
  const mitosisFMs = new Set<string>();

  for (const t of traces) {
    const vid = versionIdOf(t, baseId, mitosisId);
    if (vid !== baseId && vid !== mitosisId) continue;
    const target = vid === baseId ? base : mitosis;
    const fmSet = vid === baseId ? baseFMs : mitosisFMs;
    target.total += 1;
    if (t.status === "success") target.succeeded += 1;
    else if (t.status === "failure") target.failed += 1;
    const fmType = failureModeTypeOf(t);
    if (fmType) fmSet.add(fmType);
    if (target.sample_trace_ids.length < 5) target.sample_trace_ids.push(execIdOf(t));
  }

  base.success_rate = base.total > 0 ? base.succeeded / base.total : 0;
  mitosis.success_rate = mitosis.total > 0 ? mitosis.succeeded / mitosis.total : 0;
  base.failure_mode_classes = Array.from(baseFMs).sort();
  mitosis.failure_mode_classes = Array.from(mitosisFMs).sort();

  let verdict: "FAVORABLE" | "NEUTRAL" | "UNFAVORABLE" | "INSUFFICIENT_DATA";
  let verdict_reason: string;
  const cited_trace_ids: string[] = [...base.sample_trace_ids, ...mitosis.sample_trace_ids];

  if (base.total < minTraces || mitosis.total < minTraces) {
    verdict = "INSUFFICIENT_DATA";
    verdict_reason = `need ≥${minTraces} traces per version (base=${base.total}, mitosis=${mitosis.total})`;
  } else {
    const newFailureClasses = mitosis.failure_mode_classes.filter(
      (c) => !baseFMs.has(c),
    );
    const advantage = mitosis.success_rate - base.success_rate;
    if (newFailureClasses.length > 0) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis introduces new failure_mode class(es): ${newFailureClasses.join(", ")}`;
    } else if (advantage >= threshold) {
      verdict = "FAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} beats base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else if (advantage <= -threshold) {
      verdict = "UNFAVORABLE";
      verdict_reason = `mitosis success_rate ${mitosis.success_rate.toFixed(3)} trails base ${base.success_rate.toFixed(3)} by ≥${threshold}`;
    } else {
      verdict = "NEUTRAL";
      verdict_reason = `success_rate delta ${advantage.toFixed(3)} within ±${threshold}; no failure class regression`;
    }
  }

  return {
    shape: "vesselMitosisEvaluation",
    body: {
      base_version_id: baseId,
      mitosis_version_id: mitosisId,
      verdict,
      verdict_reason,
      threshold,
      min_traces_per_version: minTraces,
      base_success_rate: base.success_rate,
      mitosis_success_rate: mitosis.success_rate,
      base,
      mitosis,
      cited_trace_ids,
      scanned: traces.length,
      window_since: since,
      window_since_source: pointer.since ? "explicit" : "hour_bucket_default",
      static_evaluation: staticResult,
      evaluated_at: new Date().toISOString(),
    },
  };
}
