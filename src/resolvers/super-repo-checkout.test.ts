// Pins the lane's in-tree materialization against local-tools' shell gate
// (shell-containment.ts): the gate lets a mutating git command into a super-repo clone
// through only when verifyWriteGrant(fleet key, the cwd string sent, pointer.write_grant)
// holds. That predicate is evaluated here, on the exact args feature_compose sends.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { superRepoCheckoutCall } from "./super-repo-checkout";
import { verifyWriteGrant, WRITE_GRANT_FIELD } from "./write-containment";

const KEY = "test-fleet-key-0123456789";
const SUPER = "/workspace/git/super-repo";

describe("feature_compose in-tree materialization carries a lane write grant", () => {
  it("passes the gate's grant check with the fleet key, bound to exactly the cwd it sends", () => {
    const call = superRepoCheckoutCall(SUPER, "human-surface-vessel", KEY);
    expect(call.command).toBe(`git -C '${SUPER}' checkout origin/dev -- 'repos/human-surface-vessel' 2>&1`);
    expect(call.cwd).toBe(SUPER);
    expect(WRITE_GRANT_FIELD).toBe("write_grant");
    expect(verifyWriteGrant(KEY, call.cwd, (call as Record<string, unknown>)[WRITE_GRANT_FIELD])).toBe(true);
  });

  it("is refused by the gate's grant check without a key, under another key, or for another cwd", () => {
    const bare = superRepoCheckoutCall(SUPER, "human-surface-vessel", undefined);
    expect((bare as Record<string, unknown>)[WRITE_GRANT_FIELD]).toBeUndefined();
    expect(verifyWriteGrant(KEY, bare.cwd, (bare as Record<string, unknown>)[WRITE_GRANT_FIELD])).toBe(false);
    const other = superRepoCheckoutCall(SUPER, "human-surface-vessel", "another-key");
    expect(verifyWriteGrant(KEY, other.cwd, other.write_grant)).toBe(false);
    const call = superRepoCheckoutCall(SUPER, "human-surface-vessel", KEY);
    expect(verifyWriteGrant(KEY, "/workspace", call.write_grant)).toBe(false);
    expect(verifyWriteGrant(KEY, SUPER, call.write_grant, Date.now() + 10 * 60_000)).toBe(false); // expired
  });

  it("feature_compose sends the materialization through this builder, not an ungranted literal", () => {
    const src = readFileSync(join(import.meta.dir, "feature-compose.ts"), "utf8");
    expect(src).toContain("superRepoCheckoutCall(SUPER_REPO_ROOT, vesselName, METABOB_API_KEY)");
    expect(src).not.toMatch(/checkout origin\/dev -- \$\{JSON\.stringify\(`repos\/\$\{vesselName\}`\)\}/);
    // callTool must not strip the field for a shell call (withWriteGrant returns non-write tools' args unchanged).
    expect(src).toMatch(/\.\.\.withWriteGrant\(tool, args as Record<string, unknown>, METABOB_API_KEY\)/);
  });
});
