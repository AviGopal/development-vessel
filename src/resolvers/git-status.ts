import type { ResolverResult } from "../resolvers/types.js";

export async function resolveGitStatus(pointer: Readonly<{ type: "gitStatus" }>): Promise<ResolverResult> {
  const repoPath = process.env.GOAL_HOST_VESSEL_REPO ?? "/workspace/goal-host-vessel";
  const result = await fetch(`file://${repoPath}/.git/HEAD`, { signal: AbortSignal.timeout(5000) });
  if (!result.ok) {
    return { shape: "gitStatus", body: { error: `failed to read HEAD: HTTP ${result.status}` } };
  }
  const headRef = await result.text();
  const commitHash = headRef.trim().startsWith("ref: ")
    ? await Bun.file(`${repoPath}/${headRef.trim().slice(5)}`).text()
    : headRef.trim();
  return { shape: "gitStatus", body: { commitHash } };
}
