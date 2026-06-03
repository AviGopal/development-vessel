import type { ResolverResult } from "./types.js";

/**
 * gh_repo_create — create a new GitHub repo via the REST API. Closes Gap B
 * from iter 2026-06-03: scaffold-and-publish-vessel produces sub-directories
 * in the super-repo but never a separate vessel repo. With this resolver the
 * substrate can publish a new vessel as its own repo and only commit a
 * submodule pointer in the super-repo.
 *
 * Safety:
 *   - Refuses if a repo with the same name already exists under the owner
 *     (one round-trip GET before POST) — substrate cannot accidentally
 *     overwrite an operator-canonical repo.
 *   - Refuses names starting with "metabob-" unless allow_canonical_prefix
 *     is explicitly true — the operator owns the metabob-* prefix for
 *     curated repos; substrate-authored vessels go under their own names.
 *
 * Auth: GITHUB_TOKEN or GH_TOKEN env. Same pattern as gh_pr_create.
 * Default visibility: private. Default branch: dev (substrate convention).
 */
export interface GhRepoCreatePointer {
  type: "gh_repo_create";
  name: string;
  owner?: string;
  description?: string;
  private?: boolean;
  default_branch?: string;
  allow_canonical_prefix?: boolean;
}

export async function resolveGhRepoCreate(p: GhRepoCreatePointer): Promise<ResolverResult> {
  if (!p.name || typeof p.name !== "string") {
    return {
      shape: "structuredError",
      body: { resolver: "gh_repo_create", detail: "name is required", failure_mode: "cascading" },
    };
  }
  if (p.name.startsWith("metabob-") && p.allow_canonical_prefix !== true) {
    return {
      shape: "structuredError",
      body: {
        resolver: "gh_repo_create",
        detail: `refusing to create '${p.name}': the metabob-* prefix is operator-canonical (set allow_canonical_prefix=true to override)`,
        failure_mode: "safety_breach",
      },
    };
  }
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_repo_create", detail: "GITHUB_TOKEN/GH_TOKEN not set", failure_mode: "cascading" },
    };
  }
  const owner = p.owner ?? process.env["GITHUB_OWNER"] ?? "AviGopal";

  // Pre-check: refuse if the repo already exists.
  let existsRes: Response;
  try {
    existsRes = await fetch(`https://api.github.com/repos/${owner}/${p.name}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_repo_create", detail: `existence pre-check fetch failed: ${(err as Error).message}`, failure_mode: "cascading" },
    };
  }
  if (existsRes.status === 200) {
    return {
      shape: "structuredError",
      body: {
        resolver: "gh_repo_create",
        detail: `repo ${owner}/${p.name} already exists`,
        failure_mode: "safety_breach",
        error_code: "repo_already_exists",
      },
    };
  }
  // 404 means safe to create; anything else (403, 500…) means abort.
  if (existsRes.status !== 404) {
    const text = await existsRes.text().catch(() => "");
    return {
      shape: "structuredError",
      body: {
        resolver: "gh_repo_create",
        detail: `pre-check HTTP ${existsRes.status}: ${text.slice(0, 200)}`,
        failure_mode: "cascading",
      },
    };
  }

  // Decide endpoint: user-owned vs org. The simplest heuristic — POST /user/repos
  // creates under the authenticated user. POST /orgs/<owner>/repos creates under
  // an org. We don't have a cheap signal which is which, so try user/repos first
  // for the case where owner matches the authenticated user. If owner is set
  // explicitly to something different, prefer /orgs/<owner>/repos.
  const authedUser = process.env["GITHUB_USER"] ?? process.env["GITHUB_OWNER"] ?? "AviGopal";
  const useOrg = owner !== authedUser;
  const endpoint = useOrg
    ? `https://api.github.com/orgs/${owner}/repos`
    : `https://api.github.com/user/repos`;

  const payload: Record<string, unknown> = {
    name: p.name,
    description: p.description ?? `Substrate-authored vessel ${p.name}`,
    private: p.private ?? true,
    auto_init: true,
    default_branch: p.default_branch ?? "dev",
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_repo_create", detail: `fetch failed: ${(err as Error).message}`, failure_mode: "cascading" },
    };
  }
  const text = await res.text();
  if (!res.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_repo_create", status: res.status, detail: text.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let parsed: {
    html_url?: string;
    clone_url?: string;
    ssh_url?: string;
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return {
    shape: "ghRepoCreateResult",
    body: {
      name: p.name,
      owner,
      full_name: parsed.full_name ?? `${owner}/${p.name}`,
      html_url: parsed.html_url ?? null,
      clone_url: parsed.clone_url ?? null,
      ssh_url: parsed.ssh_url ?? null,
      default_branch: parsed.default_branch ?? payload["default_branch"],
      private: parsed.private ?? payload["private"],
    },
  };
}
