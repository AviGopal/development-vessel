import { expect, test } from "bun:test";
import { resolveGitHeadCommit } from "../../src/resolvers/git-head-commit.js";

test("resolveGitHeadCommit returns expected shape and commit hash", async () => {
  const result = await resolveGitHeadCommit({ type: "gitHeadCommit" });
  expect(result).toHaveProperty("shape", "gitHeadCommit");
  expect(result).toHaveProperty("body");
  expect(result.body).toHaveProperty("shape", "gitHeadCommit");
  expect(result.body).toHaveProperty("commitHash");
  expect(typeof result.body.commitHash).toBe("string");
  expect(result.body.commitHash).toMatch(/^[0-9a-f]{40}$/);
});
