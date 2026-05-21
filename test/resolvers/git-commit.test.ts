import { describe, it, expect, beforeAll } from "bun:test";
import { resolveGitCommit } from "../../src/resolvers/git-commit.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoDir = join(tmpdir(), `dev-vessel-git-commit-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(repoDir, { recursive: true });
  Bun.spawnSync(["git", "init"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir });
  // Create and stage an initial file for the first commit
  writeFileSync(join(repoDir, "init.txt"), "init");
  Bun.spawnSync(["git", "add", "--", "init.txt"], { cwd: repoDir });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: repoDir });
});

describe("git-commit resolver", () => {
  it("commits staged changes and returns commandResult", async () => {
    writeFileSync(join(repoDir, "change.txt"), "change");
    Bun.spawnSync(["git", "add", "--", "change.txt"], { cwd: repoDir });
    const result = await resolveGitCommit({ type: "git_commit", message: "test commit", cwd: repoDir });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain("test commit");
  });

  it("returns non-zero with output when nothing is staged", async () => {
    const result = await resolveGitCommit({ type: "git_commit", message: "empty", cwd: repoDir });
    const body = result.body as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).not.toBe(0);
    // Git writes "nothing to commit" to stdout or stderr depending on version
    expect(body.stdout.length + body.stderr.length).toBeGreaterThan(0);
  });
});
