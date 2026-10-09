// The one lane shell call that writes the LIVE super-repo clone: feature_compose's
// in-tree materialization, `git -C <super> checkout origin/dev -- repos/<vessel>`.
// In-tree vessels (plain directories of the super-repo, no clone of their own) are
// refreshed from origin/dev this way before a compose reads them.
//
// local-tools gates its shell (shell-containment.ts, after floor run 27c1c600 wrote
// GPT-5.md into the live clone through shellResult): a write or mutating git command
// aimed at a super-repo clone is refused unless the request carries a lane write
// grant signed over the exact cwd string it sends. This builds the call with that
// grant, using the same write-containment helper (signWriteGrant, WRITE_GRANT_FIELD)
// the lane's file-tool writes use. A local-tools without the gate ignores the field.
//
// Every other lane shell call was checked against the gate and needs no grant: its
// write targets are under the vessel runtime, a compose worktree or /tmp (lexically,
// never the super-repo path), its paths are shell variables, or it only reads.
import { signWriteGrant, type WriteGrant } from "./write-containment.js";
import { shq } from "./shell-quote.js";

export type SuperRepoCheckoutCall = { command: string; cwd: string; write_grant?: WriteGrant };

/** The shell args for refreshing `repos/<vessel>` in the super-repo clone from origin/dev, with a grant bound to `superRoot` when a key is held. */
export function superRepoCheckoutCall(superRoot: string, vesselName: string, key: string | undefined, now: number = Date.now()): SuperRepoCheckoutCall {
  const call: SuperRepoCheckoutCall = {
    command: `git -C ${shq(superRoot)} checkout origin/dev -- ${shq(`repos/${vesselName}`)} 2>&1`,
    cwd: superRoot,
  };
  if (key) call.write_grant = signWriteGrant(key, superRoot, now);
  return call;
}
