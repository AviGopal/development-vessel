import type { ResolverResult } from "./types.js";

export interface GhPrCreatePointer {
  type: "gh_pr_create";
  owner: string;
  repo: string;
  source_branch: string;
  target_branch: string;
  title: string;
  body: string;
  draft?: boolean;
}

const PROVENANCE_REQUIRED = /Substrate-Authored-By:\s*\S+/;

export async function resolveGhPrCreate(p: GhPrCreatePointer): Promise<ResolverResult> {
  if (!PROVENANCE_REQUIRED.test(p.body)) {
    return {
      shape: "structuredError",
      body: {
        resolver: "gh_pr_create",
        detail: "body must contain a 'Substrate-Authored-By: <identity>' line",
        failure_mode: "safety_breach",
      },
    };
  }
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_create", detail: "GITHUB_TOKEN/GH_TOKEN not set", failure_mode: "cascading" },
    };
  }
  const url = `https://api.github.com/repos/${p.owner}/${p.repo}/pulls`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        head: p.source_branch,
        base: p.target_branch,
        title: p.title,
        body: p.body,
        draft: p.draft ?? false,
        maintainer_can_modify: true,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_create", detail: msg, failure_mode: "cascading" },
    };
  }
  const text = await res.text();
  if (!res.ok) {
    return {
      shape: "structuredError",
      body: { resolver: "gh_pr_create", status: res.status, detail: text.slice(0, 400), failure_mode: "cascading" },
    };
  }
  let parsed: { number?: number; html_url?: string; id?: number };
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return {
    shape: "prCreateResult",
    body: {
      number: parsed.number ?? null,
      url: parsed.html_url ?? null,
      id: parsed.id ?? null,
      source_branch: p.source_branch,
      target_branch: p.target_branch,
    },
  };
}
