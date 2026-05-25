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

  return {
    shape: "directoryListing",
    body: {
      path: relative(workspaceRoot, absPath),
      entries,
      count: entries.length,
    },
  };
}
