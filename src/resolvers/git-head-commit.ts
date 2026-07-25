import type { ResolverResult } from "../resolvers/types.js";

export async function resolveGitHeadCommit(pointer: Readonly<{ type: "gitHeadCommit" }>): Promise<ResolverResult> {
  const repoPath = process.env.GOAL_HOST_VESSEL_REPO ?? "/workspace/goal-host-vessel";
  const output = await new Response(
    new Blob([
      await Bun.$`git -C ${repoPath} rev-parse HEAD`.text(),
    ])
  ).text();
  const body = { shape: "gitHeadCommit", commitHash: output.trim() };
  return { shape: "gitHeadCommit", body };
}
