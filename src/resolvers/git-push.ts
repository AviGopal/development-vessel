import type { ResolverResult } from "./types.js";

export interface GitPushPointer {
  type: "git_push";
  branch: string;
  remote?: string;
  cwd?: string;
  set_upstream?: boolean;
}

const FORBIDDEN_BRANCHES = new Set(["main", "dev", "master", "trunk", "release"]);

export async function resolveGitPush(p: GitPushPointer): Promise<ResolverResult> {
  if (FORBIDDEN_BRANCHES.has(p.branch)) {
    return {
      shape: "structuredError",
      body: {
        resolver: "git_push",
        detail: `refusing to push to protected branch '${p.branch}'`,
        failure_mode: "safety_breach",
      },
    };
  }
  const remote = p.remote ?? "origin";
  const args = ["push"];
  if (p.set_upstream !== false) args.push("-u");
  args.push(remote, p.branch);
  const proc = Bun.spawn(["git", ...args], { cwd: p.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return {
      shape: "structuredError",
      body: { resolver: "git_push", detail: stderr.slice(0, 400), failure_mode: "cascading", exitCode },
    };
  }
  return {
    shape: "gitPushResult",
    body: { remote, branch: p.branch, stdout, stderr },
  };
}
