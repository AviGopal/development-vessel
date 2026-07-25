import { resolve, relative, join } from "path";
import { readdir, stat } from "node:fs/promises";
import type { ResolverResult } from "./types.js";
import { assertInAnyWorkspaceForRead } from "./workspace-roots.js";

export interface FsListPointer {
  type: "fs_list";
  path: string;
  recursive?: boolean;
  maxDepth?: number;
  includeHidden?: boolean;
  glob?: string;
  /**
   * V26 (2026-06-09) — when true, shuffles the returned entries array.
   * Used by drafter-trigger-tick to rotate through scenarios: the trigger's
   * downstream `entries.0.name` extraction becomes a random pick instead of
   * always selecting the first alphabetical entry. Without shuffle, the
   * trigger hits the drafter's 3-per-7-day rate-limit on a single scenario
   * id and starves new variant production.
   */
  shuffle?: boolean;
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  assertInAnyWorkspaceForRead(path, workspaceRoot);
}

function matchGlob(name: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

interface Entry {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
}

async function walk(
  dir: string,
  workspaceRoot: string,
  currentDepth: number,
  maxDepth: number,
  includeHidden: boolean,
  glob: string | undefined,
  entries: Entry[],
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (!includeHidden && dirent.name.startsWith(".")) continue;

    const fullPath = join(dir, dirent.name);
    const relPath = relative(workspaceRoot, fullPath);

    const isDir = dirent.isDirectory();
    const entryType = isDir ? "directory" : "file";

    if (!glob || matchGlob(dirent.name, glob)) {
      entries.push({ path: relPath, name: dirent.name, type: entryType, depth: currentDepth });
    }

    if (isDir && currentDepth < maxDepth) {
      await walk(fullPath, workspaceRoot, currentDepth + 1, maxDepth, includeHidden, glob, entries);
    }
  }
}

export async function resolveFsList(pointer: FsListPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] || process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);

  // Location independence (law 11): resolve the path RELATIVE TO the workspace root, NOT
  // process.cwd(). Otherwise the same listing (e.g. "docs") depends on where THIS vessel
  // process happens to run — a location-dependence bug that made "count files in docs"
  // resolve to a wrong path (../../../vessels/...) and silently return 0.
  const absPath = resolve(workspaceRoot, pointer.path);

  // Honest-reach (the vessel is the validator): a non-existent / non-directory target must
  // FAIL, not silently return count 0 — a silent 0 lets the reach judge rubber-stamp a wrong
  // answer ("0 files in docs" when docs plainly exists).
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`fs_list: '${pointer.path}' is not an existing directory under the workspace (resolved ${absPath})`);
  }

  const maxDepth = pointer.recursive ? (pointer.maxDepth ?? 10) : 0;

  const entries: Entry[] = [];
  await walk(absPath, workspaceRoot, 0, maxDepth, pointer.includeHidden ?? false, pointer.glob, entries);

  // V26 (2026-06-09): Fisher–Yates shuffle when requested. Lets drafter-trigger-tick
  // rotate scenarios via the existing entries[0] extraction path without a new resolver.
  if (pointer.shuffle && entries.length > 1) {
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = entries[i]!;
      entries[i] = entries[j]!;
      entries[j] = tmp;
    }
  }

  return {
    shape: "directoryListing",
    body: {
      path: relative(workspaceRoot, absPath),
      entries,
      count: entries.length,
    },
  };
}
