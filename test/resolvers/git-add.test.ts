import { describe, it, expect, beforeAll } from "bun:test";
import { resolveGitAdd } from "../../src/resolvers/git-add.js";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoDir = join(tmpdir(), `dev-vessel-git-add-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(repoDir, { recursive: true });
  const init = Bun.spawnSync(["git", "init"], { cwd: repoDir });
  if (init.exitCode !== 0) throw new Error("git init failed");
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: repoDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "file.txt"), "content");
});

describe("git-add resolver", () => {
  it("stages a file and returns commandResult", async () => {
    const result = await resolveGitAdd({ type: "git_add", paths: ["file.txt"], cwd: repoDir });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).toBe(0);
  });

  it("passes paths after the -- separator", async () => {
    // Verify the resolver adds -- between command and paths by staging a
    // file whose name begins with a dash (would be mistaken for a flag otherwise).
    writeFileSync(join(repoDir, "-dashed.txt"), "dash");
    const result = await resolveGitAdd({ type: "git_add", paths: ["-dashed.txt"], cwd: repoDir });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number };
    expect(body.exitCode).toBe(0);
  });

  it("returns non-zero exit for a non-existent path", async () => {
    const result = await resolveGitAdd({ type: "git_add", paths: ["no-such-file.txt"], cwd: repoDir });
    const body = result.body as { exitCode: number };
    expect(body.exitCode).not.toBe(0);
  });
});
