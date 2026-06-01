import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveGitBranchCreate } from "../../src/resolvers/git-branch-create.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoDir = join(tmpdir(), `dev-vessel-git-branch-create-${Date.now()}`);
const savedEnv = process.env["SUBSTRATE_ALLOWED_BRANCH_PATTERNS"];

beforeAll(() => {
  mkdirSync(repoDir, { recursive: true });
  Bun.spawnSync(["git", "init"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "init.txt"), "init");
  Bun.spawnSync(["git", "add", "--", "init.txt"], { cwd: repoDir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: repoDir });
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env["SUBSTRATE_ALLOWED_BRANCH_PATTERNS"];
  else process.env["SUBSTRATE_ALLOWED_BRANCH_PATTERNS"] = savedEnv;
});

describe("git_branch_create resolver", () => {
  it("creates a branch whose name matches the default allowlist", async () => {
    const result = await resolveGitBranchCreate({
      type: "git_branch_create",
      branch_name: `substrate-authored/${Date.now()}-test`,
      cwd: repoDir,
    });
    expect(result.shape).toBe("branchCreateResult");
  });

  it("refuses a branch name that does not match the allowlist (safety_breach)", async () => {
    const result = await resolveGitBranchCreate({
      type: "git_branch_create",
      branch_name: "main",
      cwd: repoDir,
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("safety_breach");
  });

  it("respects SUBSTRATE_ALLOWED_BRANCH_PATTERNS env override", async () => {
    process.env["SUBSTRATE_ALLOWED_BRANCH_PATTERNS"] = "^feature/.+$";
    const refused = await resolveGitBranchCreate({
      type: "git_branch_create",
      branch_name: `substrate-authored/${Date.now()}-x`,
      cwd: repoDir,
    });
    expect(refused.shape).toBe("structuredError");
    const accepted = await resolveGitBranchCreate({
      type: "git_branch_create",
      branch_name: `feature/${Date.now()}-x`,
      cwd: repoDir,
    });
    expect(accepted.shape).toBe("branchCreateResult");
  });
});
