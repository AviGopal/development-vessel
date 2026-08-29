import { expect, test } from "bun:test";
import { resolveGitHeadCommit } from "../../src/resolvers/git-head-commit.js";

// The resolver used to hardcode /workspace/goal-host-vessel and accept no directory, so this
// suite asked for "the HEAD commit" and was answered about a different vessel — or, where that
// path does not exist, not answered at all: it shelled out with Bun.$, which throws, so the
// failure arrived as an exception with no assertion diff. It now honours `cwd`.
test("resolveGitHeadCommit returns the HEAD hash of the repo it was asked about", async () => {
  const result = await resolveGitHeadCommit({ type: "gitHeadCommit", cwd: process.cwd() });
  expect(result).toHaveProperty("shape", "gitHeadCommit");
  expect(result.body).toHaveProperty("commitHash");
  expect(typeof result.body.commitHash).toBe("string");
  expect(result.body.commitHash).toMatch(/^[0-9a-f]{40}$/);
  expect((result.body as { repoPath: string }).repoPath).toBe(process.cwd());
});

// THE DISCRIMINATOR. Without it the case above passes just as well against the old resolver
// that ignored `cwd` — it would still return a valid-looking hash, just somebody else's.
// Compares repoPath rather than the two hashes, because two checkouts are entitled to share a
// HEAD and an equality-of-hashes assertion would go flaky the moment they converge.
test("reads the argument: the answer names the repository that was requested", async () => {
  const here = await resolveGitHeadCommit({ type: "gitHeadCommit", cwd: process.cwd() });
  const other = await resolveGitHeadCommit({
    type: "gitHeadCommit",
    cwd: "/workspace/repos/development-vessel",
  });
  expect((here.body as { repoPath: string }).repoPath).toBe(process.cwd());
  expect((other.body as { repoPath: string }).repoPath).toBe("/workspace/repos/development-vessel");
});

test("reports a shaped error instead of throwing for a non-repository path", async () => {
  const result = await resolveGitHeadCommit({ type: "gitHeadCommit", cwd: "/nonexistent-xyz" });
  expect(result.shape).toBe("gitHeadCommit");
  expect(result.body).toHaveProperty("error");
});
