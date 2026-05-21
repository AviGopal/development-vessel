import { describe, it, expect } from "bun:test";
import { resolveGitLog } from "../../src/resolvers/git-log.js";

describe("git-log resolver", () => {
  it("defaults to limit 5 and returns commandResult", async () => {
    const result = await resolveGitLog({ type: "git_log", cwd: process.cwd() });
    expect(result.shape).toBe("commandResult");
    const body = result.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    const lines = body.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("respects explicit limit", async () => {
    const result = await resolveGitLog({ type: "git_log", cwd: process.cwd(), limit: 2 });
    const body = result.body as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    const lines = body.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("uses a custom format when provided", async () => {
    const result = await resolveGitLog({ type: "git_log", cwd: process.cwd(), limit: 1, format: "%H" });
    const body = result.body as { stdout: string };
    expect(body.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
