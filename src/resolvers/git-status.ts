import type { ResolverResult } from "../resolvers/types.js";
import { env } from "../config.js";

/**
 * Reports the HEAD commit of a git repository.
 *
 * HONOURS `cwd`. It previously did not: repoPath was hardcoded to
 * `process.env.GOAL_HOST_VESSEL_REPO ?? "/workspace/goal-host-vessel"`, so a caller asking for
 * the status OF A GIVEN DIRECTORY silently received the goal-host vessel's HEAD instead — or an
 * error when that path did not exist. A resolver that confidently answers about a DIFFERENT
 * repository than the one asked about is a correctness hazard for anything branching on git
 * state, not merely a red test. Measured via the CLI:
 *   call-resolver git_status --data '{"cwd":"<a repo>"}'
 *   -> exit 1, ENOENT ... /workspace/goal-host-vessel/.git/refs/heads/master
 * — wrong repository, and `master` where these repositories use `dev`.
 *
 * The env var is kept as the DEFAULT only, so existing callers that relied on it are unchanged.
 */
export async function resolveGitStatus(
  pointer: Readonly<{ type: "gitStatus"; cwd?: string; repoPath?: string }>,
): Promise<ResolverResult> {
  const requested = pointer.repoPath ?? pointer.cwd;
  const repoPath =
    requested !== undefined && requested.trim() !== ""
      ? requested
      : env("GOAL_HOST_VESSEL_REPO", "/workspace/goal-host-vessel");

  // Bun.file().text() throws a plain ENOENT that escapes to the dispatcher and aborts the whole
  // request; report it as a resolver-level error instead so callers get a shaped answer.
  try {
    // GIT WORKTREE INDIRECTION (2026-09-11). In a LINKED WORKTREE `.git` is a FILE
    // holding "gitdir: <path>", not a directory — so `${repoPath}/.git/HEAD` does not
    // exist, the read throws ENOENT into the catch below, and the returned body carries
    // an `error` and NO `commitHash`. Measured: isolated composes stage into a fresh
    // worktree, so this resolver failed for every one of them, and the vessel's own
    // integration test ("resolves git_status in the development-vessel repo itself")
    // then failed with `Received value must be a string: undefined` — rolling the
    // compose back and reporting a test name rather than the cause.
    let gitDir = `${repoPath}/.git`;
    try {
      const dotGitText = await Bun.file(gitDir).text();
      if (dotGitText.startsWith("gitdir:")) gitDir = dotGitText.slice("gitdir:".length).trim();
    } catch { /* .git is a directory (ordinary checkout) — keep the default */ }

    const rebaseInProgress = await Bun.file(`${gitDir}/rebase-merge`).exists() || await Bun.file(`${gitDir}/rebase-apply`).exists();
    const conflictInProgress = await Bun.file(`${gitDir}/MERGE_HEAD`).exists() || await Bun.file(`${gitDir}/CHERRY_PICK_HEAD`).exists();

    const headRaw = await Bun.file(`${gitDir}/HEAD`).text();
    const head = headRaw.trim();

    // `ref: refs/heads/<branch>` — resolve the ref the repo ACTUALLY points at rather than
    // assuming a branch name. The previous code inherited whatever ref HEAD named, which is
    // correct; what was wrong was reading it from the wrong repository.
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      const refPath = `${gitDir}/${ref}`;
      const commitHash = (await Bun.file(refPath).text()).trim();
      return { shape: "gitStatus", body: { commitHash, repoPath, ref, rebaseInProgress, conflictInProgress } };
    }

    // Detached HEAD: the file holds the hash directly.
    return { shape: "gitStatus", body: { commitHash: head, repoPath, ref: null, rebaseInProgress, conflictInProgress } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { shape: "gitStatus", body: { error: `failed to read HEAD at ${repoPath}: ${msg}`, repoPath } };
  }
}
