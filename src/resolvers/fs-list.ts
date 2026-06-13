import { resolve, relative, join } from "path";
import { readdir } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

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
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path outside workspace root: ${path}`);
  }
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
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);

  const absPath = resolve(pointer.path);
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
