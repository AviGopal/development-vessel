// RUN A GAP-STORE HARNESS FILE IN ITS OWN PROCESS, REPORTING EVERY CASE BY NAME.
//
// substrate-gap captures WORKSPACE_ROOT once, at module load, and `bun test` shares one module registry across
// files: in the full suite the store root is frozen by whichever file imported it first (the checkout), so a
// harness file that drives the real store through gap-to-feature trips its own temp-dir guard in beforeAll and
// the suite reports one "(unnamed)" failure — its cases never run, which is the same as unenforced. A query-
// string fresh import does not help when the code under test imports substrate-gap itself.
//
// This runs `<name>.cases.ts` in a child `bun test` with a fresh temp WORKSPACE_ROOT, output captured to a FILE
// (never a pipe), and returns one row per case so the caller declares one named test per case. A child that
// reports no cases, or fails to run, yields a row that fails by name.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// LEARNED STATE STAYS IN THE CHILD'S TEMP ROOT (2026-10-17). A child spawned with an env built from scratch drops every
// state redirect the scrubbed suite env sets, so code under test fell back to its live defaults: fixture classes
// (stale-flap, stale-ctrl, sweep-*) landed in node1's LIVE /workspace/gap-class-posteriors.json during gate suites.
// Every `process.env.X ?? "/workspace/..."` default in src (the rule pull-sync's scrubbed_env derives its redirects by)
// is pointed under the child's own root, and the spawn is refused if any of them would still resolve outside tmpdir.
// ONE DEFINITION (2026-10-17): the scan lives in src/test-child-env.ts, which production's scrubbed children use too, so a
// test child and a lane child are redirected by the same derived list.
import { learnedStateDefaults, scratchStatePath } from "../../src/test-child-env.js";
export { learnedStateDefaults };
/** A redirected write lands where the live one would have (the writers are best-effort and create no directories). */
const makeParents = (paths: string[]): void => { for (const p of paths) { try { mkdirSync(dirname(p), { recursive: true }); } catch { /* best-effort */ } } };
const underTmp = (p: string): boolean => { const r = resolve(p), t = resolve(tmpdir()); return r === t || r.startsWith(t + sep) || r.startsWith("/tmp/"); };
/** The env for an isolated child: as clean as before (HOME, PATH, WORKSPACE_ROOT=root, the compose-trigger skip, extras),
 *  plus every learned-state default pointed under `root`. Refuses (throws) if any learned-state path is outside tmpdir. */
export function isolatedChildEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root, SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1" };
  for (const [name, dflt] of learnedStateDefaults()) env[name] = scratchStatePath(join(root, "ws"), dflt);
  Object.assign(env, extra);
  for (const name of learnedStateDefaults().keys()) {
    if (!underTmp(env[name]!)) throw new Error(`isolated child refused: ${name}=${env[name]} is not under tmpdir (the child would write live learned state)`);
  }
  if (!underTmp(env["WORKSPACE_ROOT"]!)) throw new Error(`isolated child refused: WORKSPACE_ROOT=${env["WORKSPACE_ROOT"]} is not under tmpdir`);
  makeParents([...learnedStateDefaults().keys()].map((n) => env[n]!));
  return env;
}

/** The in-process twin of isolatedChildEnv, for a test file that drives src in its own process (route 3: such a file set
 *  WORKSPACE_ROOT only, so a credit write through the real modules resolved GAP_CLASS_POSTERIOR_PATH & co. to their live
 *  /workspace defaults: cc-ctl-* classes reached node1's gap-class-posteriors.json). Points every learned-state default
 *  src names under `root/ws` unless its current value is already under tmpdir (the scrubbed suite env's redirects are
 *  kept), and WORKSPACE_ROOT at `root` unless it is already under tmpdir. Every value is checked BEFORE process.env is
 *  touched: a non-tmp root throws and leaves the env as it was.
 *  Covers paths src reads at call time (tablePath, classPosteriorPath, the gap-store table map). A src module that
 *  captures its path at module load is covered only if this runs before that module is imported, so call it before
 *  the file's first `await import("../../src/...")` (a static import is evaluated before the file body). */
export function isolateLearnedStateInProcess(root: string): Record<string, string> {
  if (!underTmp(root)) throw new Error(`in-process isolation refused: root ${root} is not under tmpdir`);
  const next: Record<string, string> = {};
  for (const [name, dflt] of learnedStateDefaults()) {
    const cur = process.env[name];
    // kept only while its directory exists: in one `bun test` process a previous file's removed root is not reused
    next[name] = cur && underTmp(cur) && existsSync(dirname(cur)) ? cur : scratchStatePath(join(root, "ws"), dflt);
  }
  const ws = process.env["WORKSPACE_ROOT"];
  next["WORKSPACE_ROOT"] = ws && underTmp(ws) ? ws : root;
  for (const [name, v] of Object.entries(next)) {
    if (!underTmp(v)) throw new Error(`in-process isolation refused: ${name}=${v} is not under tmpdir (the test would write live learned state)`);
  }
  Object.assign(process.env, next);
  makeParents([...learnedStateDefaults().keys()].map((n) => next[n]!));
  return next;
}

/** The line a pending-land sweep child runs right after importing the landing verdict (`glvPath`): the served-here
 *  read (landedCommitRunningHere) answers through its deps seam instead of the host's systemctl. The test preload does
 *  not reach a child, and the node gate runs these files inside the live container, where development-vessel (the
 *  fixtures' vessel name) is a real unit whose state decided the verdict. The seam answers: unit loaded and active, not
 *  restarted onto the landing (started at 0), so a landing that is not test-only reads "awaiting restart", as it did
 *  when the child could not resolve systemctl. A test-only landing reads "running" before any of it is consulted. */
export const childUnitSeamLine = (glvPath: string): string =>
  `(await import(${JSON.stringify(glvPath)})).__setAutoRevertDepsForTests({ unitLoadState: () => "loaded", unitActive: () => "active", unitStartedAt: () => 0 });`;

export type CaseRow = { name: string; ok: boolean; detail: string };

export function runCasesIsolated(casesFile: string): CaseRow[] {
  const root = mkdtempSync(join(tmpdir(), "gap-harness-"));
  const out = join(root, "out.txt");
  try {
    const env = isolatedChildEnv(root);
    const p = Bun.spawnSync(["bash", "-c", `bun test ${JSON.stringify(casesFile)} > ${JSON.stringify(out)} 2>&1`], { env, cwd: join(import.meta.dir, "..", ".."), timeout: 120_000 });
    const text = (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })();
    // Child output is quoted ("  | ") when echoed, so its (pass)/(fail) lines are never read as the parent's.
    const quoted = (t: string): string => t.split("\n").map((l) => `  | ${l}`).join("\n");
    const rows: CaseRow[] = [];
    for (const line of text.split("\n")) {
      const m = /^\((pass|fail)\) (.*?)(?: \[[0-9.]+m?s\])?$/.exec(line);
      if (m) rows.push({ name: m[2]!, ok: m[1] === "pass", detail: m[1] === "fail" ? quoted(text.slice(0, 4000)) : "" });
    }
    if (rows.length === 0 || p.exitCode !== 0) rows.push({ name: `${casesFile} child run (exit ${String(p.exitCode)})`, ok: rows.length > 0 && p.exitCode === 0, detail: quoted(text.slice(-4000)) });
    return rows;
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
