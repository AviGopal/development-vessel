/**
 * compose-workspace.ts — per-compose filesystem isolation for feature_compose.
 *
 * WHY: composes used to apply ops directly to the shared runtime tree
 * (/vessels/<vessel>, often a symlink to the shared push clone) and to reset
 * that clone to origin/dev mid-flight. Two concurrent composes on overlapping
 * vessels therefore ENOENT'd each other's files (gap:
 * edit-intent-compose-shared-workspace-no-isolation), and the only guard was
 * an in-process busy-set that REFUSED the second compose — dropping work.
 * Contention was gating development throughput.
 *
 * WHAT: each compose gets its own detached git WORKTREE per touched vessel,
 * created off the vessel's push clone at origin/dev. Apply/typecheck/verify/
 * repair all run inside the worktree; the shared runtime and clone are never
 * mutated during the compose phase. Landing still flows through
 * vessel-mitosis-cutover, which holds the global maintenance lease and its
 * freshness gates — concurrent landings serialize THERE, on evidence, instead
 * of being refused up front. Rollback for an isolated compose is trivial:
 * the worktree is discarded.
 *
 * Worktrees share the clone's object store; `git reset --hard` on the clone's
 * own working tree does not touch a worktree's checkout, which is exactly the
 * property that removes the mid-flight stomping. node_modules is symlinked
 * from the clone when present so typecheck does not pay a fresh install.
 *
 * FAIL-OPEN: any acquisition failure (no clone, git error) simply leaves that
 * vessel un-isolated; the caller keeps the legacy busy-set serialization for
 * those. This module can only ever ADD isolation, never block a compose.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const CLONE_ROOT = process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels";
const WS_ROOT = process.env["COMPOSE_WS_DIR"] ?? "/workspace/git/compose";

export interface ComposeWorkspace {
  /** Unique id of this compose's workspace (directory name under WS_ROOT). */
  id: string;
  /** Absolute worktree root for a vessel (accepts "repos/x" or "x"), if isolated. */
  rootFor(vessel: string): string | undefined;
  /** True when the vessel got its own worktree. */
  isolated(vessel: string): boolean;
  /** Map an absolute path inside a worktree back to "<vessel>/<rest>". */
  rel(abs: string): string | undefined;
  /** Remove all worktrees + the workspace dir. Idempotent, best-effort. */
  release(): Promise<void>;
}

const strip = (v: string): string => v.replace(/^repos\//, "");

async function git(cloneDir: string, args: string[]): Promise<void> {
  await run("git", ["-C", cloneDir, ...args], { timeout: 60_000 });
}

export async function acquireComposeWorkspace(vessels: string[], id: string): Promise<ComposeWorkspace> {
  const roots = new Map<string, string>(); // vessel -> worktree abs
  const clones = new Map<string, string>(); // vessel -> clone abs (for release)

  for (const raw of vessels) {
    const vessel = strip(raw);
    if (!vessel || vessel === "__global__" || roots.has(vessel)) continue;
    const clone = `${CLONE_ROOT}/${vessel}`;
    if (!existsSync(`${clone}/.git`)) continue; // net-new vessel: scaffold path, un-isolated
    const dir = `${WS_ROOT}/${id}/${vessel}`;
    try {
      // Refresh the ref the worktree pins to; a fetch race with another compose
      // is harmless (git serializes ref updates internally).
      await git(clone, ["fetch", "origin", "dev"]).catch(() => { /* offline: use last-known origin/dev */ });
      await git(clone, ["worktree", "add", "--detach", dir, "origin/dev"]);
      if (existsSync(`${clone}/node_modules`) && !existsSync(`${dir}/node_modules`)) {
        await run("ln", ["-s", `${clone}/node_modules`, `${dir}/node_modules`], { timeout: 10_000 });
      }
      roots.set(vessel, dir);
      clones.set(vessel, clone);
    } catch (err) {
      // Fail-open: leave this vessel un-isolated; caller falls back to the busy-set.
      console.warn(`[compose-workspace] isolation unavailable for ${vessel}: ${(err as Error)?.message ?? err}`);
      try { await git(clone, ["worktree", "remove", "--force", dir]); } catch { /* not created */ }
    }
  }

  let released = false;
  return {
    id,
    rootFor: (vessel: string) => roots.get(strip(vessel)),
    isolated: (vessel: string) => roots.has(strip(vessel)),
    rel: (abs: string) => {
      for (const [vessel, root] of roots) {
        if (abs.startsWith(`${root}/`)) return `${vessel}/${abs.slice(root.length + 1)}`;
      }
      return undefined;
    },
    release: async () => {
      if (released) return;
      released = true;
      for (const [vessel, dir] of roots) {
        const clone = clones.get(vessel)!;
        try { await git(clone, ["worktree", "remove", "--force", dir]); } catch { /* fall through to rm */ }
        try { await git(clone, ["worktree", "prune"]); } catch { /* best-effort */ }
      }
      try { await run("rm", ["-rf", `${WS_ROOT}/${id}`], { timeout: 30_000 }); } catch { /* best-effort */ }
    },
  };
}
