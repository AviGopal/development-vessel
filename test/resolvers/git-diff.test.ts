import { describe, it, expect } from "bun:test";
import { resolveGitDiff } from "../../src/resolvers/git-diff.js";

describe("git-diff resolver", () => {
  it("uses shortstat format by default and returns commandResult", async () => {
    const result = await resolveGitDiff({ type: "git_diff", cwd: process.cwd() });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number; stdout: string; stderr: string };
    expect(body.exitCode).toBe(0);
    expect(typeof body.stdout).toBe("string");
  });

  it("uses name-only format when specified", async () => {
    const result = await resolveGitDiff({ type: "git_diff", cwd: process.cwd(), format: "name-only" });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number };
    expect(body.exitCode).toBe(0);
  });
});
