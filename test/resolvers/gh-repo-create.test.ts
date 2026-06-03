import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveGhRepoCreate } from "../../src/resolvers/gh-repo-create.js";

const savedGh = process.env["GH_TOKEN"];
const savedGithub = process.env["GITHUB_TOKEN"];
const savedFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env["GH_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
});
afterEach(() => {
  if (savedGh === undefined) delete process.env["GH_TOKEN"]; else process.env["GH_TOKEN"] = savedGh;
  if (savedGithub === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = savedGithub;
  globalThis.fetch = savedFetch;
});

describe("gh_repo_create resolver", () => {
  it("refuses a metabob-* name without allow_canonical_prefix (safety_breach)", async () => {
    process.env["GITHUB_TOKEN"] = "t";
    const result = await resolveGhRepoCreate({
      type: "gh_repo_create",
      name: "metabob-shiny-new-vessel",
    });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { failure_mode: string }).failure_mode).toBe("safety_breach");
  });

  it("refuses with no GITHUB_TOKEN/GH_TOKEN", async () => {
    const result = await resolveGhRepoCreate({ type: "gh_repo_create", name: "ok-name" });
    expect(result.shape).toBe("structuredError");
    expect((result.body as { detail: string }).detail).toContain("TOKEN");
  });

  it("refuses when pre-check finds the repo already exists (safety_breach)", async () => {
    process.env["GITHUB_TOKEN"] = "t";
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/repos/")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const result = await resolveGhRepoCreate({
      type: "gh_repo_create",
      name: "already-here",
      owner: "AviGopal",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; error_code?: string };
    expect(body.failure_mode).toBe("safety_breach");
    expect(body.error_code).toBe("repo_already_exists");
  });

  it("creates a repo (stubbed fetch returns 201)", async () => {
    process.env["GITHUB_TOKEN"] = "t";
    globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === "GET" || (!init?.method && u.endsWith("/some-vessel"))) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/AviGopal/some-vessel",
          clone_url: "https://github.com/AviGopal/some-vessel.git",
          ssh_url: "git@github.com:AviGopal/some-vessel.git",
          full_name: "AviGopal/some-vessel",
          default_branch: "dev",
          private: true,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await resolveGhRepoCreate({
      type: "gh_repo_create",
      name: "some-vessel",
      owner: "AviGopal",
    });
    expect(result.shape).toBe("ghRepoCreateResult");
    const body = result.body as { full_name: string; html_url: string };
    expect(body.full_name).toBe("AviGopal/some-vessel");
    expect(body.html_url).toContain("github.com");
  });
});
