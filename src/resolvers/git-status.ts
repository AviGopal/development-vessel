import type { ResolverResult } from "./types.js";

export interface GitStatusPointer {
  type: "git_status";
  cwd?: string;
}

export async function resolveGitStatus(pointer: GitStatusPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
