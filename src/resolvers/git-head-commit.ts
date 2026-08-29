import type { ResolverResult } from "../resolvers/types.js";
import { env } from "../config.js";

/**
 * Returns the HEAD commit hash of a git repository.
 *
 * HONOURS `cwd`. It previously hardcoded
 * `process.env.GOAL_HOST_VESSEL_REPO ?? "/workspace/goal-host-vessel"` and accepted no directory
 * at all, so it always answered about the goal-host vessel regardless of the caller — the same
 * defect fixed in git-status.ts (9595134). It also shelled out with `Bun.$`, which THROWS when
 * the path is not a repository, so the failure escaped as an exception instead of a shaped
 * result and surfaced in tests with no assertion diff at all.
 *
 * NOTE: this overlaps `git_status`, which also reports a HEAD commit hash. Two shapes answering
 * the same question is worth consolidating, but that is a contract change for callers and is not
 * done here.
 */
export async function resolveGitHeadCommit(
  pointer: Readonly<{ type: "gitHeadCommit"; cwd?: string; repoPath?: string }>,
): Promise<ResolverResult> {
  const requested = pointer.repoPath ?? pointer.cwd;
  const repoPath =
    requested !== undefined && requested.trim() !== ""
      ? requested
      : env("GOAL_HOST_VESSEL_REPO", "/workspace/goal-host-vessel");

  try {
    const out = await Bun.$`git -C ${repoPath} rev-parse HEAD`.text();
    const commitHash = out.trim();
    if (!/^[0-9a-f]{40}$/.test(commitHash)) {
      return {
        shape: "gitHeadCommit",
        body: { shape: "gitHeadCommit", error: `unexpected rev-parse output at ${repoPath}`, repoPath },
      };
    }
    return { shape: "gitHeadCommit", body: { shape: "gitHeadCommit", commitHash, repoPath } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      shape: "gitHeadCommit",
      body: { shape: "gitHeadCommit", error: `failed to read HEAD at ${repoPath}: ${msg}`, repoPath },
    };
  }
}
