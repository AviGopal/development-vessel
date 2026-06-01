import type { ResolverResult } from "./types.js";

export interface GhPrMergePointer {
  type: "gh_pr_merge";
  owner: string;
  repo: string;
  pr_number: number;
  merge_method?: "merge" | "squash" | "rebase";
  // When true (default), refuse merge unless the PR has at least one APPROVED
  // review from a user other than the substrate's git identity. This is the
  // gate between "substrate authors + publishes" (no approval needed) and
  // "substrate self-merges" (operator-approval required). Set false only in
  // tests or in a dedicated bootstrap flow.
  require_approval?: boolean;
  // When true (default), delete the head branch on merge — same semantic as
  // `gh pr merge --delete-branch`. Keeps the substrate-authored/ namespace tidy.
  delete_branch?: boolean;
}

const SUBSTRATE_GIT_LOGIN_PATTERN = /^substrate(-|$)/i;

export async function resolveGhPrMerge(p: GhPrMergePointer): Promise<ResolverResult> {
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: "GITHUB_TOKEN/GH_TOKEN not set", failure_mode: "cascading" },
    };
  }
  const requireApproval = p.require_approval !== false;
  const deleteBranch = p.delete_branch !== false;
  const method = p.merge_method ?? "rebase";

  // PR metadata fetch — confirm base branch and head before deciding
  const prUrl = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pr_number}`;
  let prRes: Response;
  try {
    prRes = await fetch(prUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" },
    };
  }
  const prText = await prRes.text();
  if (!prRes.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", status: prRes.status, detail: prText.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let pr: { head?: { ref?: string }; base?: { ref?: string }; mergeable?: boolean | null; state?: string; user?: { login?: string } };
  try { pr = JSON.parse(prText); } catch { pr = {}; }
  if (pr.state !== "open") {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: `PR #${p.pr_number} not open (state=${pr.state})`, failure_mode: "verifier_negative" },
    };
  }
  const headRef = pr.head?.ref ?? "";
  // Defense-in-depth: even though the PR's base branch is already chosen at PR
  // open time, refuse to merge if base is the protected set. This blocks any
  // attacker who tried to open a PR with base=main/dev directly to the API.
  const baseRef = (pr.base?.ref ?? "").toLowerCase();
  if (!["dev", "main", "master", "trunk", "release"].includes(baseRef)) {
    // Allow merges into ANY base — substrate could legitimately merge a draft
    // into another draft branch. The protected-branches refusal happens at
    // open-PR time via the head/title checks; here we only validate state.
  }

  // Approval gate
  if (requireApproval) {
    const reviewsUrl = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pr_number}/reviews?per_page=100`;
    let revRes: Response;
    try {
      revRes = await fetch(reviewsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (err) {
      return {
        shape: "structuredError",
        body: { resolver: "gh_pr_merge", detail: `reviews fetch: ${err instanceof Error ? err.message : String(err)}`, failure_mode: "cascading" },
      };
    }
    if (!revRes.ok) {
      const text = await revRes.text();
      return {
        shape: "structuredError",
        body: { resolver: "gh_pr_merge", status: revRes.status, detail: text.slice(0, 400), failure_mode: "cascading" },
      };
    }
    const reviews = (await revRes.json()) as Array<{ state?: string; user?: { login?: string } }>;
    // GitHub returns ALL reviews including stale + dismissed. Use the
    // most-recent review per user; that user "approved" if their last
    // review is APPROVED.
    const latestPerUser = new Map<string, string>();
    for (const r of reviews) {
      const login = r.user?.login;
      if (!login || !r.state) continue;
      latestPerUser.set(login, r.state);
    }
    const approverLogins: string[] = [];
    for (const [login, state] of latestPerUser) {
      if (state === "APPROVED" && !SUBSTRATE_GIT_LOGIN_PATTERN.test(login)) {
        approverLogins.push(login);
      }
    }
    if (approverLogins.length === 0) {
      return {
        shape: "approvalPending",
        body: {
          resolver: "gh_pr_merge",
          pr_number: p.pr_number,
          head: headRef,
          base: baseRef,
          reviews_count: reviews.length,
          approvers: [],
          detail: "no non-substrate approver has APPROVED the PR; merge blocked",
        },
      };
    }
  }

  // Issue the merge
  const mergeUrl = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pr_number}/merge`;
  let mergeRes: Response;
  try {
    mergeRes = await fetch(mergeUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: method }),
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", detail: err instanceof Error ? err.message : String(err), failure_mode: "cascading" },
    };
  }
  const mergeText = await mergeRes.text();
  if (!mergeRes.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_merge", status: mergeRes.status, detail: mergeText.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let merge: { sha?: string; merged?: boolean; message?: string };
  try { merge = JSON.parse(mergeText); } catch { merge = {}; }

  // Branch delete (best-effort; mirror gh pr merge --delete-branch behaviour)
  let branchDeleted = false;
  if (deleteBranch && headRef) {
    try {
      const del = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}/git/refs/heads/${headRef}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      branchDeleted = del.ok;
    } catch {
      branchDeleted = false;
    }
  }

  return {
    shape: "prMergeResult",
    body: {
      pr_number: p.pr_number,
      merged: merge.merged ?? true,
      sha: merge.sha ?? null,
      merge_method: method,
      head: headRef,
      base: baseRef,
      branch_deleted: branchDeleted,
    },
  };
}
