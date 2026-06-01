import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveGhPrCreate } from "../../src/resolvers/gh-pr-create.js";

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

describe("gh_pr_create resolver", () => {
  it("refuses a body missing Substrate-Authored-By trailer (safety_breach)", async () => {
    process.env["GITHUB_TOKEN"] = "test-token";
    const result = await resolveGhPrCreate({
      type: "gh_pr_create",
      owner: "octocat",
      repo: "hello",
      source_branch: "substrate-authored/2026-06-01-x",
      target_branch: "dev",
      title: "test",
      body: "no provenance line here",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("safety_breach");
  });

  it("refuses when no GITHUB_TOKEN/GH_TOKEN env is set", async () => {
    const result = await resolveGhPrCreate({
      type: "gh_pr_create",
      owner: "octocat",
      repo: "hello",
      source_branch: "substrate-authored/2026-06-01-x",
      target_branch: "dev",
      title: "test",
      body: "Substrate-Authored-By: substrate-live",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { detail: string };
    expect(body.detail).toContain("TOKEN");
  });
});
