import type { ResolverResult } from "./types.js";
import { gateLanding, parseRemoteTarget } from "./push-policy.js";

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
  // Same gate as the cutover: the MITOSIS_DIRECT_PUSH=0 emergency stop, then the
  // pushPolicy scope for the remote's push URL. A volume with no policy file is
  // grandfathered and pushes as before.
  const gate = gateLanding({ remoteUrl: await pushUrlOf(remote, p.cwd), branch: p.branch });
  if (!gate.allowed) {
    return {
      shape: "structuredError",
      body: {
        resolver: "git_push",
        detail: gate.reason,
        failure_mode: "safety_breach",
        kind: gate.kind,
        ...(gate.scope ? { push_scope: gate.scope } : {}),
      },
    };
  }
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

/** Where `git push <remote>` goes: the remote's push URL, or the remote itself when it is already a URL. */
async function pushUrlOf(remote: string, cwd: string | undefined): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "--push", remote], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && out) return out;
  } catch {
    // fall through: not a configured remote name here
  }
  return parseRemoteTarget(remote) ? remote : null;
}
