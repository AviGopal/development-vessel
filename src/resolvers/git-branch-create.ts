import type { ResolverResult } from "./types.js";

export interface GitBranchCreatePointer {
  type: "git_branch_create";
  branch_name: string;
  base?: string;
  cwd?: string;
}

const DEFAULT_ALLOWED = "^(substrate-authored|substrate)/.+$";

function allowedPattern(): RegExp {
  const raw = process.env["SUBSTRATE_ALLOWED_BRANCH_PATTERNS"] ?? DEFAULT_ALLOWED;
  return new RegExp(raw);
}

export async function resolveGitBranchCreate(p: GitBranchCreatePointer): Promise<ResolverResult> {
  const pattern = allowedPattern();
  if (!pattern.test(p.branch_name)) {
    return {
      shape: "structuredError",
      body: {
        resolver: "git_branch_create",
        detail: `branch_name '${p.branch_name}' does not match SUBSTRATE_ALLOWED_BRANCH_PATTERNS /${pattern.source}/`,
        failure_mode: "safety_breach",
      },
    };
  }
  const args = p.base
    ? ["checkout", "-b", p.branch_name, p.base]
    : ["checkout", "-b", p.branch_name];
  const proc = Bun.spawn(["git", ...args], { cwd: p.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return {
      shape: "structuredError",
      body: { resolver: "git_branch_create", detail: stderr.slice(0, 400), failure_mode: "cascading" },
    };
  }
  return {
    shape: "branchCreateResult",
    body: { branch_name: p.branch_name, base: p.base ?? null, stdout, stderr },
  };
}
