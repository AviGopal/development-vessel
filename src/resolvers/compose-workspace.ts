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
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

// Read at call time, not at module load: a value frozen at import is whatever the environment held
// when the first importer loaded this module (in one bun test process, another test file's), not what
// the caller runs under now.
const cloneRoot = (): string => process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels";
const wsRoot = (): string => process.env["COMPOSE_WS_DIR"] ?? "/workspace/git/compose";

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

/**
 * Janitor: a successful cutover RESTARTS the vessel, which kills sibling
 * in-flight composes before their release() runs (env_cutover_race) — their
 * worktrees leak. Sweep workspaces older than STALE_MS at acquire time;
 * `git worktree prune` on each clone then drops the dangling registrations.
 */
const STALE_MS = 2 * 60 * 60 * 1000;
// The shared-packages link (linkSharedPackages) lives beside the workspaces and is never swept.
const SHARED_PACKAGES = "packages";
async function sweepStaleWorkspaces(WS_ROOT: string, activeClones: Iterable<string>): Promise<void> {
  try {
    const { readdirSync, statSync } = await import("node:fs");
    for (const entry of readdirSync(WS_ROOT)) {
      if (entry === SHARED_PACKAGES) continue;
      const dir = `${WS_ROOT}/${entry}`;
      try {
        if (Date.now() - statSync(dir).mtimeMs < STALE_MS) continue;
        await run("rm", ["-rf", dir], { timeout: 30_000 });
      } catch { /* per-entry best-effort */ }
    }
    for (const clone of activeClones) {
      try { await git(clone, ["worktree", "prune"]); } catch { /* best-effort */ }
    }
  } catch { /* WS_ROOT absent or unreadable — nothing to sweep */ }
}

/**
 * A vessel names the super-repo's shared packages as file:../../packages/<pkg> (identity-vessel:
 * @avigopal/vessel-discovery-client). From a worktree at WS_ROOT/<id>/<vessel> that path is
 * WS_ROOT/packages, which nothing provided, so the verify's `bun install --dry-run` failed on every
 * identity-vessel compose. The runtime resolves the same dependency at $MITOSIS_RUNTIME_DIR/packages
 * (mirror-to-live and the image rewrite it there), so link WS_ROOT/packages to that copy. An existing
 * path (directory, file or any link) is never touched; with no runtime packages directory nothing is
 * linked and the dependency stays unresolved (the verify refuses, as before). Only the link is written;
 * nothing under the runtime tree. pull-sync gives its clone layout the same link (substrate-pull-sync.sh
 * clone_shared_packages).
 */
export function linkSharedPackages(WS_ROOT: string = wsRoot()): void {
  const target = `${process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels"}/packages`;
  const link = `${WS_ROOT}/${SHARED_PACKAGES}`;
  try {
    if (!existsSync(target)) return;
    try { lstatSync(link); return; } catch { /* absent: create it */ }
    mkdirSync(WS_ROOT, { recursive: true });
    symlinkSync(target, link);
  } catch (err) {
    console.warn(`[compose-workspace] shared packages link unavailable: ${(err as Error)?.message ?? err}`);
  }
}

export async function acquireComposeWorkspace(vessels: string[], id: string): Promise<ComposeWorkspace> {
  const roots = new Map<string, string>(); // vessel -> worktree abs
  const clones = new Map<string, string>(); // vessel -> clone abs (for release)

  const CLONE_ROOT = cloneRoot();
  const WS_ROOT = wsRoot(); // one value for the whole workspace: acquire and release agree
  const candidateClones = vessels.map((v) => `${CLONE_ROOT}/${strip(v)}`).filter((c) => existsSync(`${c}/.git`));
  await sweepStaleWorkspaces(WS_ROOT, candidateClones);
  linkSharedPackages(WS_ROOT);

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
      await git(clone, ["merge", "--ff-only", "origin/dev"]).catch(() => { /* dirty, detached or diverged: worktrees still pin to origin/dev */ });
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
