import { writeFile, readFile, stat } from "node:fs/promises";
import { basename, join, resolve as resolvePath, sep } from "node:path";
import { createHash } from "node:crypto";
import type { ResolverResult } from "./types.js";

/**
 * activate_substrate_script (2026-06-26) — SELF-ACTIVATION primitive.
 *
 * The substrate's timer units (scripts/substrate/*.ts) historically ran
 * directly from the read-only, stale-after-mount host bind path
 * (/home/.../scripts/substrate/<name>.ts). A Docker-Desktop bind only
 * refreshes on a full container restart, so a substrate-authored new version
 * of a timer script could NOT take effect without an operator
 * `docker restart` — the autonomy loop's authored output never went live.
 *
 * The fix is a writable run-dir on the substrate-workspace volume
 * (/workspace/active-scripts/), seeded fresh from the bind at every boot by
 * substrate-active-scripts-seed.service, and a repointed unit ExecStart that
 * runs the script from the run-dir. This resolver is the write half: a
 * self-dev flow that has COMMITTED a new version of a timer script calls it
 * with { script } and the committed version goes live on the NEXT timer
 * firing — no restart.
 *
 * PROVENANCE, NOT CONTENT. Every unit that runs from the run-dir loads the
 * fleet EnvironmentFile and runs as root (two of the scripts read the env file
 * themselves), so whatever lands in the run-dir executes with every fleet
 * secret. The resolver therefore never takes source from its caller: the bytes
 * it writes are the git blob `HEAD:scripts/substrate/<script>` of the
 * super-repo clone — reviewed, attributable, landed code. A pointer carrying
 * `content` is refused (it was the old contract; accepting it let any caller
 * that could reach this shape run arbitrary code with the fleet's secrets).
 * The run-dir and repo root are likewise not pointer fields: a pointer-chosen
 * run-dir let the existence gate below overwrite any existing .ts the vessel
 * could write, vessel source included. They are resolver options, supplied
 * only by in-process callers and tests.
 *
 * Path safety:
 *   - `script` is reduced to its basename (no path traversal, no leading /).
 *   - must end in `.ts`.
 *   - the target file MUST already exist in the run-dir (replace-only).
 *   - the script must be tracked at HEAD under scripts/substrate/.
 *   - optional `base_sha` guard: if supplied, the current run-dir content's
 *     sha256 must match before we overwrite. Mismatch → refused.
 */

const DEFAULT_RUN_DIR = "/workspace/active-scripts";
// GATE-FED DIRS (2026-10-06). The run-dir and the gate-public dir are written only by pull-sync (root) and the boot
// seed, from the copy Gate P accepted, and development-vessel's unit mounts them read-only. A script change reaches
// them by landing and promotion, never by this resolver: a write here would put an unjudged blob where the fleet runs
// it. The gate-public dir is refused outright; a read-only run-dir answers with the same reason, not a raw error.
const GATE_FED_REFUSAL = "the run dir is gate-fed; land the change and let Gate P promote it";
const gatePublicDir = (): string => process.env["SELF_FACTS_PUBLIC_DIR"] ?? "/workspace/.gate-public";
/** A write error that means "this dir is not ours to write" (read-only mount or permission), not a transient fault. */
export function isGateFedWriteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EROFS" || code === "EACCES" || code === "EPERM";
}
const isUnder = (dir: string, root: string): boolean => {
  const d = resolvePath(dir); const r = resolvePath(root);
  return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep);
};
const SCRIPT_DIR_IN_REPO = "scripts/substrate";

export interface ActivateSubstrateScriptPointer {
  type: "activate_substrate_script";
  /** Basename of the committed timer script, e.g. "compose-teacher.ts". */
  script?: string;
  /** Optional sha256 of the CURRENT run-dir content; overwrite only if it matches. */
  base_sha?: string;
}

/** In-process options; never read from a pointer. */
export interface ActivateSubstrateScriptOptions {
  /** Run-dir to write into. Default /workspace/active-scripts. */
  runDir?: string;
  /** Super-repo clone whose HEAD is the source of truth. Default: located from WORKSPACE_ROOT. */
  repoRoot?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

function refuse(error: string, extra: Record<string, unknown> = {}): ResolverResult {
  return { shape: "structuredError", body: { error, activated: false, ...extra } };
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
}

/**
 * The super-repo clone. WORKSPACE_ROOT is either the clone itself or the workspace that contains it at
 * git/super-repo (both layouts are deployed); the first candidate that is a git work tree holding
 * scripts/substrate wins.
 */
async function locateSuperRepo(): Promise<string | null> {
  const ws = process.env["WORKSPACE_ROOT"] || process.cwd();
  for (const candidate of [ws, join(ws, "git", "super-repo")]) {
    try {
      if (!(await stat(join(candidate, SCRIPT_DIR_IN_REPO))).isDirectory()) continue;
    } catch {
      continue;
    }
    const top = await git(["rev-parse", "--is-inside-work-tree"], candidate);
    if (top.code === 0 && top.stdout.trim() === "true") return candidate;
  }
  return null;
}

export async function resolveActivateSubstrateScript(
  pointer: ActivateSubstrateScriptPointer,
  opts: ActivateSubstrateScriptOptions = {},
): Promise<ResolverResult> {
  const runDir = opts.runDir ?? DEFAULT_RUN_DIR;
  const rawScript = pointer.script;
  const p = pointer as unknown as Record<string, unknown>;

  // --- provenance: caller-supplied source or location is refused ----------
  if (p["content"] !== undefined) {
    return refuse(
      "activate_substrate_script no longer accepts `content`: the run-dir executes with the fleet " +
        "EnvironmentFile, so only the committed file HEAD:scripts/substrate/<script> can be activated. " +
        "Land the change as a commit, then activate it with { script } alone.",
    );
  }
  if (p["runDir"] !== undefined || p["repoRoot"] !== undefined) {
    return refuse("runDir/repoRoot are not pointer fields; the run-dir and source repo are fixed by the resolver");
  }

  // --- input validation -------------------------------------------------
  if (typeof rawScript !== "string" || !rawScript.trim()) {
    return refuse("script (basename, *.ts) is required");
  }

  // --- path safety: basename only, must end .ts -------------------------
  const name = basename(rawScript);
  if (name !== rawScript || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    return refuse(`path traversal / non-basename script rejected: ${rawScript}`);
  }
  if (!name.endsWith(".ts")) {
    return refuse(`script must end in .ts: ${name}`);
  }

  if (isUnder(runDir, gatePublicDir())) {
    return refuse(`${GATE_FED_REFUSAL} (${runDir} is under the gate-public dir)`, { script: name, gate_fed: true });
  }

  const target = join(runDir, name);

  // --- existence gate: only REPLACE a known seeded script ---------------
  let prevContent: string;
  try {
    const st = await stat(target);
    if (!st.isFile()) {
      return refuse(`target is not a regular file: ${target}`);
    }
    prevContent = await readFile(target, "utf-8");
  } catch {
    return refuse(
      `script not present in run-dir (${target}) — activation only replaces ` +
        `an existing seeded timer script, it never creates new executables`,
    );
  }

  // --- source: the committed blob, never the caller ---------------------
  const repoRoot = opts.repoRoot ?? (await locateSuperRepo());
  if (!repoRoot) {
    return refuse("super-repo clone not found (WORKSPACE_ROOT or WORKSPACE_ROOT/git/super-repo)", { script: name });
  }
  const repoPath = `${SCRIPT_DIR_IN_REPO}/${name}`;
  const headRev = await git(["rev-parse", "HEAD"], repoRoot);
  const blob = await git(["show", `HEAD:${repoPath}`], repoRoot);
  if (headRev.code !== 0 || blob.code !== 0) {
    return refuse(`${repoPath} is not tracked at HEAD of ${repoRoot} — only committed scripts can be activated`, {
      script: name,
    });
  }
  const content = blob.stdout;

  // --- optional base_sha optimistic-concurrency guard -------------------
  if (typeof pointer.base_sha === "string" && pointer.base_sha) {
    const cur = sha256(prevContent);
    if (cur !== pointer.base_sha) {
      return refuse("base_sha mismatch — run-dir content changed since author read it", {
        script: name,
        expected_base_sha: pointer.base_sha,
        actual_base_sha: cur,
      });
    }
  }

  // --- write ------------------------------------------------------------
  try {
    await writeFile(target, content, "utf-8");
  } catch (err) {
    if (isGateFedWriteError(err)) return refuse(GATE_FED_REFUSAL, { script: name, gate_fed: true, code: (err as { code?: string }).code });
    return refuse(err instanceof Error ? err.message.slice(0, 200) : String(err), { script: name });
  }

  const bytes = Buffer.byteLength(content, "utf-8");
  return {
    shape: "substrateScriptActivation",
    body: {
      activated: true,
      script: name,
      run_dir: runDir,
      path: target,
      source: `${repoPath}@${headRev.stdout.trim()}`,
      bytes,
      sha256: sha256(content),
      prev_sha256: sha256(prevContent),
      changed: prevContent !== content,
      at: new Date().toISOString(),
    },
  };
}
