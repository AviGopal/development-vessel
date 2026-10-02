import { resolve } from "node:path";

import { assertWriteContained } from "./fs-write-containment.js";
import type { ResolverResult } from "./types.js";

export interface GitCommitPointer {
  type: "git_commit";
  message: string;
  cwd?: string;
  /** A lane write grant for exactly `cwd` (see write-containment.ts). */
  write_grant?: unknown;
}

/**
 * A commit is a write, and the one pull-sync trusts most (it installs from HEAD), so its
 * directory passes the same containment as fs_write / fs_edit: the live super-repo clone is
 * refused always, push clones / compose worktrees / the vessel runtime need the lane's grant,
 * secrets never. With no `cwd` the commit runs in this process's cwd, which is checked too.
 */
export async function resolveGitCommit(pointer: GitCommitPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const absCwd = resolve(process.cwd(), cwd ?? ".");
  assertWriteContained(absCwd, cwd ?? absCwd, pointer.write_grant);
  const proc = Bun.spawn(["git", "commit", "-m", pointer.message], { cwd: absCwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
