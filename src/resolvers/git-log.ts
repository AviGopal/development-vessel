import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ResolverResult } from "./types.js";
import { SUPER_REPO_ROOT } from "../shape-vocabulary.js";

/**
 * git_log — read commit history from the substrate's own clones.
 *
 * WHY THE DEFAULT IS THE SUPER-REPO CLONE, NOT process.cwd()
 * This resolver used to spawn `git log` with cwd = pointer.cwd and nothing else. The walk does
 * not pass a cwd (the seeded templates carry an uninterpolated "{{cwd}}", synthesis has nothing
 * to bind it from), so git ran in the process cwd, /vessels/development-vessel — a runtime mirror
 * with no .git — and every call answered `fatal: not a git repository` (exit 128). Observed four
 * times in one probe walk: the system could not read its own commit history.
 *
 * The default is now the substrate's own super-repo clone, located the way the fs resolvers and
 * feature_compose already locate it: WORKSPACE_ROOT read at call time (workspace-roots.ts), else
 * shape-vocabulary's SUPER_REPO_ROOT. It never falls back to process.cwd(): that fallback IS the
 * defect.
 *
 * `repo` names a vessel and maps it to that vessel's clone exactly as feature_compose
 * materializes one: its push clone (MITOSIS_PUSH_CLONE_DIR/<vessel>, a submodule vessel), else
 * the super-repo's repos/<vessel> (an in-tree vessel, governed by the super-repo's .git, so its
 * log is scoped to that directory). An unknown name is an error, never a fallback.
 *
 * CONTAINMENT. A given cwd is resolved (relative paths against the default root) and then
 * REALPATHED, together with each root, and must land inside one of the allowed clone roots (the
 * super-repo clone and the push-clone root). Lexical checks miss symlink escapes; realpath does
 * not. /etc, ../.. and a symlink out of a root are refused with a shaped error.
 *
 * READ-ONLY BY CONSTRUCTION. The default points at a LIVE clone, so the only thing this may ever
 * run is a plain `git log`. The argv is built here and is always ["git", "log", ...]: no field
 * names a subcommand or adds an option of its own. Every field value is one argv element
 * (Bun.spawn with an array, never a shell string) and is validated first: no value may begin
 * with '-' (`git log --output=<file>` WRITES a file), limit is an integer from 1 to MAX_LIMIT
 * (over the cap is refused, not clamped, so a caller learns its ask was not honoured), since is
 * one element `--since=<value>` with no shell metacharacters. `--no-ext-diff --no-textconv
 * --no-show-signature` keep a clone's own config from running a diff, textconv or gpg helper,
 * and git runs with GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null and an empty temporary
 * HOME, so no system or global config is read at all.
 *
 * A refusal is a commandResult with a non-zero exitCode, `refused: true` and `error`, not a throw:
 * impulses.ts would turn a throw into an HTTP 500 the walk cannot read.
 */
export interface GitLogPointer {
  type: "git_log";
  /** A directory inside an allowed clone root; relative paths resolve against the super-repo clone. */
  cwd?: string;
  /** A vessel name (e.g. "development-vessel"): read that vessel's clone. Exclusive with cwd. */
  repo?: string;
  limit?: number;
  format?: string;
  /** Passed as --since=<value>, e.g. "24 hours ago" or "2026-10-01". */
  since?: string;
}

interface GitLogRoots {
  /** The substrate's own super-repo clone: the default cwd, and the home of in-tree vessels. */
  superRepo: string;
  /** Where submodule vessels' push clones live (one directory per vessel). */
  cloneDir: string;
}

let rootsOverride: GitLogRoots | null = null;

/** Point the resolver at other roots (tests only: a temp git layout instead of the live clones). Pass null to restore. */
export function __setGitLogRootsForTests(roots: GitLogRoots | null): void {
  rootsOverride = roots;
}

// Read at call time, not at module load (compose-workspace.ts's rule): a value frozen at import is
// whatever the first importer's environment held.
function gitLogRoots(): GitLogRoots {
  if (rootsOverride) return rootsOverride;
  const ws = process.env["WORKSPACE_ROOT"];
  return {
    superRepo: ws && ws.trim() !== "" ? ws : SUPER_REPO_ROOT,
    cloneDir: process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels",
  };
}

// The pointer constraints. Exported because GIT_LOG_CONTRACT below (served by resolver_schema to
// goal-host's arg synthesis) is rendered FROM them, so the advertised contract cannot drift from
// what this resolver enforces.
export const GIT_LOG_MAX_LIMIT = 200;
export const GIT_LOG_DEFAULT_LIMIT = 5;
export const GIT_LOG_VESSEL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// Letters, digits, space and the punctuation git's date parser reads ("24 hours ago",
// "2026-10-01 12:00:00 +0000", "1.week.ago"). Nothing a shell would interpret.
export const GIT_LOG_SINCE_RE = /^[A-Za-z0-9 :.,+\-\/_]+$/;
export const GIT_LOG_SINCE_MAX_LEN = 64;
export const GIT_LOG_FORMAT_MAX_LEN = 400;
const MAX_LIMIT = GIT_LOG_MAX_LIMIT;
const VESSEL_NAME_RE = GIT_LOG_VESSEL_NAME_RE;
const SINCE_RE = GIT_LOG_SINCE_RE;

/**
 * git_log's payload contract, in resolver-schema.ts's Contract form (it is CONTRACTS.git_log there).
 * goal-host's llmExtractPointerArgs fetches it as pointer {type:"resolver_schema", shape:"git_log"}
 * and builds its AUTHORITATIVE PAYLOAD CONTRACT block from `fields` and `notes`. Every field is
 * optional: an empty pointer reads the super-repo clone.
 */
export const GIT_LOG_CONTRACT: { fields: Array<{ name: string; required: boolean; type: string }>; notes: string } = {
  fields: [
    { name: "repo", required: false, type: "string" },
    { name: "cwd", required: false, type: "string" },
    { name: "limit", required: false, type: "integer" },
    { name: "format", required: false, type: "string" },
    { name: "since", required: false, type: "string" },
  ],
  notes:
    "Flat pointer; every field is optional and an empty pointer reads the substrate's super-repo clone. " +
    `repo: a vessel name matching ${GIT_LOG_VESSEL_NAME_RE.source} (e.g. "development-vessel"), reads that vessel's clone; an unknown name is refused. ` +
    "cwd: a directory inside the super-repo clone or a vessel clone (relative paths resolve against the super-repo clone; anything outside is refused); give repo OR cwd, not both. " +
    `limit: an integer from 1 to ${GIT_LOG_MAX_LIMIT} (default ${GIT_LOG_DEFAULT_LIMIT}); over ${GIT_LOG_MAX_LIMIT} is refused. ` +
    `format: a git pretty format, at most ${GIT_LOG_FORMAT_MAX_LEN} characters on one line (default "%s", e.g. "%h %ad %s"). ` +
    `since: a date or relative time such as "24 hours ago" or "2026-10-01", at most ${GIT_LOG_SINCE_MAX_LEN} characters matching ${GIT_LOG_SINCE_RE.source}. ` +
    "No value may begin with '-'.",
};
const PLACEHOLDER_RE = /^\s*\{\{[^}]*\}\}\s*$/;

function refused(error: string): ResolverResult {
  return { shape: "commandResult", body: { exitCode: 2, stdout: "", stderr: `git_log: ${error}\n`, refused: true, error } };
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function insideAny(real: string, roots: string[]): boolean {
  for (const root of roots) {
    const r = realOrNull(root);
    if (!r) continue;
    if (real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)) return true;
  }
  return false;
}

/** The clone (and pathspec) a vessel name maps to, or an error. */
function repoDir(name: string, roots: GitLogRoots): { dir: string; pathspec: string[] } | { error: string } {
  if (!VESSEL_NAME_RE.test(name)) return { error: `repo must be a vessel name (lowercase letters, digits, '-'), got ${JSON.stringify(name.slice(0, 80))}` };
  const clone = `${roots.cloneDir}/${name}`;
  if (existsSync(`${clone}/.git`)) return { dir: clone, pathspec: [] };
  const inTree = `${roots.superRepo}/repos/${name}`;
  if (existsSync(`${inTree}/.git`)) return { dir: inTree, pathspec: [] }; // an initialized submodule checkout
  if (existsSync(`${inTree}/package.json`)) return { dir: inTree, pathspec: ["."] }; // in-tree: scope the super-repo log to it
  return { error: `unknown repo ${JSON.stringify(name)}: no clone at ${clone} and no vessel at ${inTree}` };
}

type GitLogArgs = { limit: number; format: string; since?: string; pathspec?: string[] };

/** git's arguments after the program name: always "log" first, every value one element, validated by the caller. */
function gitLogArgs(a: GitLogArgs): string[] {
  return [
    "log",
    "--no-ext-diff", "--no-textconv", "--no-show-signature",
    "-n", String(a.limit),
    `--pretty=${a.format}`,
    ...(a.since !== undefined ? [`--since=${a.since}`] : []),
    "--", ...(a.pathspec ?? []),
  ];
}

/** The argv git_log runs: always ["git", "log", ...]. */
export function buildGitLogArgv(a: GitLogArgs): string[] {
  return ["git", ...gitLogArgs(a)];
}

/** The environment git_log spawns git with: PATH only, an empty HOME, and no system or global config. */
export function gitLogSpawnEnv(home: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
}

export async function resolveGitLog(pointer: GitLogPointer): Promise<ResolverResult> {
  const roots = gitLogRoots();
  const allowed = [roots.superRepo, roots.cloneDir];

  for (const field of ["cwd", "repo", "format", "since"] as const) {
    const v = pointer[field];
    if (typeof v === "string" && v.trimStart().startsWith("-")) return refused(`${field} must not begin with '-' (git_log takes no options from its pointer)`);
  }
  if (typeof pointer.limit === "string" && String(pointer.limit).trimStart().startsWith("-")) {
    return refused(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const rawLimit = pointer.limit ?? GIT_LOG_DEFAULT_LIMIT;
  const limit = typeof rawLimit === "string" ? Number(rawLimit) : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return refused(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const format = pointer.format ?? "%s";
  if (typeof format !== "string" || format.length === 0 || format.length > GIT_LOG_FORMAT_MAX_LEN || /[\0\r\n]/.test(format)) {
    return refused(`format must be a non-empty single-line string of at most ${GIT_LOG_FORMAT_MAX_LEN} characters`);
  }
  let since: string | undefined;
  if (pointer.since !== undefined && pointer.since !== null && pointer.since !== "") {
    since = pointer.since;
    if (typeof since !== "string" || since.length > GIT_LOG_SINCE_MAX_LEN || since.startsWith("-") || !SINCE_RE.test(since)) {
      return refused("since must be a date or relative time such as \"24 hours ago\" (letters, digits, space, : . , + - / _; no leading '-')");
    }
  }

  // An uninterpolated template slot ("{{cwd}}") means the caller had no cwd to give.
  const cwdGiven = typeof pointer.cwd === "string" && pointer.cwd.trim() !== "" && !PLACEHOLDER_RE.test(pointer.cwd);
  const repoGiven = typeof pointer.repo === "string" && pointer.repo.trim() !== "" && !PLACEHOLDER_RE.test(pointer.repo);
  if (cwdGiven && repoGiven) return refused("give either repo or cwd, not both");

  let dir: string;
  let pathspec: string[] = [];
  if (repoGiven) {
    const r = repoDir(pointer.repo!.trim(), roots);
    if ("error" in r) return refused(r.error);
    dir = r.dir;
    pathspec = r.pathspec;
  } else if (cwdGiven) {
    const c = pointer.cwd!;
    dir = isAbsolute(c) ? resolve(c) : resolve(roots.superRepo, c);
  } else {
    dir = roots.superRepo;
  }

  const real = realOrNull(dir);
  if (!real) return refused(`cwd does not exist: ${dir}`);
  if (!insideAny(real, allowed)) {
    return refused(`cwd ${JSON.stringify(cwdGiven ? pointer.cwd : dir)} resolves outside the allowed clone roots (${allowed.join(", ")})`);
  }

  const args = gitLogArgs({ limit, format, since, pathspec });
  const home = mkdtempSync(join(tmpdir(), "git-log-home-"));
  let stdout: string, stderr: string, exitCode: number;
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: real, env: gitLogSpawnEnv(home), stdout: "pipe", stderr: "pipe" });
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return { shape: "commandResult", body: { exitCode, stdout, stderr, cwd: real, ...(repoGiven ? { repo: pointer.repo!.trim() } : {}) } };
}
