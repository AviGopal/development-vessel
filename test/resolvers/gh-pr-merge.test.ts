import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveGhPrMerge } from "../../src/resolvers/gh-pr-merge.js";

const savedGh = process.env["GH_TOKEN"];
const savedGithub = process.env["GITHUB_TOKEN"];

const PASSING_EVIDENCE = {
  lint_ok: true,
  tests_ok: true,
  comprehensibility_score: 0.85,
  convergent_validity_score: 0.7,
  phantom_trace_delta: 0,
  precondition_rejection_delta: 0,
};

beforeEach(() => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
});
afterEach(() => {
  if (savedGh === undefined) delete process.env["GH_TOKEN"]; else process.env["GH_TOKEN"] = savedGh;
  if (savedGithub === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = savedGithub;
});

describe("gh_pr_merge resolver (substrate-internal evaluation gate)", () => {
  it("refuses when no GITHUB_TOKEN/GH_TOKEN env is set", async () => {
    const result = await resolveGhPrMerge({
      type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 1,
      evaluation_evidence: PASSING_EVIDENCE,
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { detail: string };
    expect(body.detail).toContain("TOKEN");
  });

  it("refuses without evaluation_evidence (evaluationInsufficient)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const r = await resolveGhPrMerge({
      type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 42,
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { reasons: string[] };
    expect(body.reasons).toContain("evaluation_evidence missing or unparseable");
  });

  it("refuses when lint_ok=false", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const r = await resolveGhPrMerge({
      type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 42,
      evaluation_evidence: { ...PASSING_EVIDENCE, lint_ok: false },
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { reasons: string[] };
    expect(body.reasons.some((rea) => rea.includes("lint_ok=false"))).toBe(true);
  });

  it("refuses when comprehensibility_score below floor", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const r = await resolveGhPrMerge({
      type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 42,
      evaluation_evidence: { ...PASSING_EVIDENCE, comprehensibility_score: 0.2 },
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { reasons: string[] };
    expect(body.reasons.some((rea) => rea.includes("comprehensibility_score"))).toBe(true);
  });

  it("refuses when phantom_trace_delta > 0 (regression)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const r = await resolveGhPrMerge({
      type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 42,
      evaluation_evidence: { ...PASSING_EVIDENCE, phantom_trace_delta: 3 },
    });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { reasons: string[] };
    expect(body.reasons.some((rea) => rea.includes("phantom_trace_delta"))).toBe(true);
  });

  it("merges when evidence passes all checks (mocked fetch)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/pulls/42")) {
        return new Response(JSON.stringify({
          state: "open", head: { ref: "substrate-authored/foo" }, base: { ref: "dev" },
        }), { status: 200 });
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
        evaluation_evidence: PASSING_EVIDENCE,
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

  it("refuses PR not in open state", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      state: "closed", head: { ref: "x" }, base: { ref: "dev" },
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const r = await resolveGhPrMerge({
        type: "gh_pr_merge", owner: "octocat", repo: "hello", pr_number: 44,
        evaluation_evidence: PASSING_EVIDENCE,
      });
      expect(r.shape).toBe("structuredError");
      const body = r.body as { failure_mode: string };
      expect(body.failure_mode).toBe("verifier_negative");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
