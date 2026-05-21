import type { ResolverResult } from "./types.js";

export interface GitDiffPointer {
  type: "git_diff";
  cwd?: string;
  revision?: string;
  format?: "shortstat" | "name-only";
}

export async function resolveGitDiff(pointer: GitDiffPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const format = pointer.format ?? "shortstat";
  const revision = pointer.revision ?? "HEAD";
  const proc = Bun.spawn(["git", "diff", `--${format}`, revision], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
