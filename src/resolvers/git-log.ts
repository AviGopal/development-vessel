import type { ResolverResult } from "./types.js";

export interface GitLogPointer {
  type: "git_log";
  cwd?: string;
  limit?: number;
  format?: string;
}

export async function resolveGitLog(pointer: GitLogPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const limit = pointer.limit ?? 5;
  const format = pointer.format ?? "%s";
  const proc = Bun.spawn(["git", "log", `-${limit}`, `--pretty=${format}`], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
