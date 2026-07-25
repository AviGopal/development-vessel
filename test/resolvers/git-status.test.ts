import { resolveGitStatus } from "../../src/resolvers/git-status.js";
import { describe, expect, test } from "bun:test";

describe("resolveGitStatus", () => {
  test("returns current HEAD commit hash", async () => {
    const result = await resolveGitStatus({ type: "gitStatus" });
    expect(result).toMatchObject({ shape: "gitStatus" });
    expect(result.body).toHaveProperty("commitHash");
    expect(typeof result.body.commitHash).toBe("string");
  });
});
