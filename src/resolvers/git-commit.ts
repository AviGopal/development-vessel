import type { ResolverResult } from "./types.js";

export interface GitCommitPointer {
  type: "git_commit";
  message: string;
  cwd?: string;
}

export async function resolveGitCommit(pointer: GitCommitPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const proc = Bun.spawn(["git", "commit", "-m", pointer.message], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
