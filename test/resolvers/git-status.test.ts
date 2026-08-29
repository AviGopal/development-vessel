import { resolveGitStatus } from "../../src/resolvers/git-status.js";
import { describe, expect, test } from "bun:test";

describe("resolveGitStatus", () => {
  // The resolver used to hardcode `/workspace/goal-host-vessel` and ignore its `cwd`, so this
  // suite asked for "the current HEAD" and was answered about a different vessel's repository —
  // or, when that path did not exist, not answered at all. It now honours `cwd`, so the test
  // says WHICH repository it means instead of depending on a path that may not exist.
  test("returns the HEAD commit hash of the repository it was asked about", async () => {
    const result = await resolveGitStatus({ type: "gitStatus", cwd: process.cwd() });
    expect(result).toMatchObject({ shape: "gitStatus" });
    expect(result.body).toHaveProperty("commitHash");
    expect(typeof result.body.commitHash).toBe("string");
    expect((result.body as { commitHash: string }).commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect((result.body as { repoPath: string }).repoPath).toBe(process.cwd());
  });

  // THE DISCRIMINATOR. Without it, the case above passes just as well against the old resolver
  // that ignored `cwd` entirely — it would still return *a* valid-looking hash, just somebody
  // else's. Assert the ANSWER IS ABOUT THE REPO THAT WAS ASKED FOR.
  //
  // Deliberately compares repoPath, NOT the two HEAD hashes. A first version of this test did
  // compare hashes and went flaky the moment the two checkouts converged on the same commit —
  // two different repositories are perfectly entitled to share a HEAD.
  test("reads the argument: the answer names the repository that was requested", async () => {
    const here = await resolveGitStatus({ type: "gitStatus", cwd: process.cwd() });
    const other = await resolveGitStatus({
      type: "gitStatus",
      cwd: "/workspace/repos/development-vessel",
    });
    expect((here.body as { repoPath: string }).repoPath).toBe(process.cwd());
    expect((other.body as { repoPath: string }).repoPath).toBe("/workspace/repos/development-vessel");
    expect((here.body as { repoPath: string }).repoPath).not.toBe(
      (other.body as { repoPath: string }).repoPath,
    );
  });

  test("reports a shaped error for a path that is not a git repository", async () => {
    const result = await resolveGitStatus({ type: "gitStatus", cwd: "/nonexistent-xyz" });
    expect(result.shape).toBe("gitStatus");
    expect(result.body).toHaveProperty("error");
  });
});
