import type { ResolverResult } from "./types.js";

export interface GitAddPointer {
  type: "git_add";
  paths: string[];
  cwd?: string;
}

export async function resolveGitAdd(pointer: GitAddPointer): Promise<ResolverResult> {
  const cwd = pointer.cwd;
  const proc = Bun.spawn(["git", "add", "--", ...pointer.paths], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { shape: "commandResult", body: { exitCode, stdout, stderr } };
}
