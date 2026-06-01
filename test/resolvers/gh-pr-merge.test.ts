import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveGhPrMerge } from "../../src/resolvers/gh-pr-merge.js";

const savedGh = process.env["GH_TOKEN"];
const savedGithub = process.env["GITHUB_TOKEN"];

beforeEach(() => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
});
afterEach(() => {
  if (savedGh === undefined) delete process.env["GH_TOKEN"]; else process.env["GH_TOKEN"] = savedGh;
  if (savedGithub === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = savedGithub;
});

describe("gh_pr_merge resolver", () => {
  it("refuses when no GITHUB_TOKEN/GH_TOKEN env is set", async () => {
    const result = await resolveGhPrMerge({
      type: "gh_pr_merge",
      owner: "octocat",
      repo: "hello",
      pr_number: 1,
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { detail: string };
    expect(body.detail).toContain("TOKEN");
  });

  it("merges when PR is open and reviews include APPROVED from non-substrate user (mocked fetch)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/pulls/42")) {
        return new Response(JSON.stringify({
          state: "open", head: { ref: "substrate-authored/foo" }, base: { ref: "dev" },
          user: { login: "substrate-live" },
        }), { status: 200 });
      }
      if (u.includes("/reviews")) {
        return new Response(JSON.stringify([
          { state: "APPROVED", user: { login: "AviGopal" } },
        ]), { status: 200 });
      }
      if (u.endsWith("/pulls/42/merge") && init?.method === "PUT") {
        return new Response(JSON.stringify({ merged: true, sha: "abc1234" }), { status: 200 });
      }
      if (u.includes("/git/refs/heads/")) {
        return new Response("", { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const r = await resolveGhPrMerge({
        type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 42,
      });
      expect(r.shape).toBe("prMergeResult");
      const body = r.body as { merged: boolean; sha: string; branch_deleted: boolean };
      expect(body.merged).toBe(true);
      expect(body.sha).toBe("abc1234");
      expect(body.branch_deleted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns approvalPending when no non-substrate user approved (mocked)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/pulls/43")) {
        return new Response(JSON.stringify({
          state: "open", head: { ref: "substrate-authored/bar" }, base: { ref: "dev" },
        }), { status: 200 });
      }
      if (u.includes("/reviews")) {
        // Only substrate-live "approved" — must not count as a valid approver.
        return new Response(JSON.stringify([
          { state: "APPROVED", user: { login: "substrate-live" } },
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const r = await resolveGhPrMerge({
        type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 43,
      });
      expect(r.shape).toBe("approvalPending");
      const body = r.body as { approvers: string[]; pr_number: number };
      expect(body.approvers).toEqual([]);
      expect(body.pr_number).toBe(43);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses PR not in open state", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      state: "closed", head: { ref: "x" }, base: { ref: "dev" },
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await resolveGhPrMerge({
        type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 44,
      });
      expect(r.shape).toBe("structuredError");
      const body = r.body as { failure_mode: string };
      expect(body.failure_mode).toBe("verifier_negative");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
