import { describe, it, expect } from "bun:test";
import { resolveGitPush } from "../../src/resolvers/git-push.js";

describe("git_push resolver", () => {
  for (const branch of ["main", "dev", "master", "trunk", "release"]) {
    it(`refuses push to protected branch '${branch}' (safety_breach)`, async () => {
      const result = await resolveGitPush({ type: "git_push", branch });
      expect(result.shape).toBe("structuredError");
      const body = result.body as { failure_mode: string; detail: string };
      expect(body.failure_mode).toBe("safety_breach");
      expect(body.detail).toContain(branch);
    });
  }

  it("attempts to push a non-protected branch (may fail due to no remote, but not safety_breach)", async () => {
    const result = await resolveGitPush({
      type: "git_push",
      branch: "substrate-authored/2026-06-01-test-not-real",
    });
    if (result.shape === "structuredError") {
      const body = result.body as { failure_mode: string };
      expect(body.failure_mode).not.toBe("safety_breach");
    }
  });
});
