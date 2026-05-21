import { describe, it, expect } from "bun:test";
import { resolveGitStatus } from "../../src/resolvers/git-status.js";

describe("git-status resolver", () => {
  it("runs in a git repo and returns commandResult shape", async () => {
    const result = await resolveGitStatus({ type: "git_status", cwd: process.cwd() });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number; stdout: string; stderr: string };
    expect(typeof body.exitCode).toBe("number");
    expect(typeof body.stdout).toBe("string");
    expect(typeof body.stderr).toBe("string");
  });

  it("returns exit 128 and stderr for a non-git directory", async () => {
    const result = await resolveGitStatus({ type: "git_status", cwd: "/tmp" });
    const body = result.body as { exitCode: number; stderr: string };
    expect(body.exitCode).toBe(128);
    expect(body.stderr.length).toBeGreaterThan(0);
  });
});
