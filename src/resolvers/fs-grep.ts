import { resolve, relative, join } from "path";
import { readdir, readFile } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

export interface FsGrepPointer {
  type: "fs_grep";
  path: string;
  pattern: string;
  caseInsensitive?: boolean;
  maxMatches?: number;
  maxDepth?: number;
  maxFilesScanned?: number;
  includeHidden?: boolean;
  fileGlob?: string;
  contextLines?: number;
}

const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES_SCANNED = 1500;
const DEFAULT_CONTEXT_LINES = 0;
const FILE_BYTE_CAP = 512 * 1024;
const TEXT_LIKE_EXT = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".sh", ".bash", ".py", ".go", ".rs", ".sql", ".html", ".css",
  ".scss", ".vue", ".svelte", ".ini", ".env", ".cfg", ".conf",
]);

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

function looksTextLike(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return true;
  const ext = name.slice(dot).toLowerCase();
  return TEXT_LIKE_EXT.has(ext);
}

interface Match {
  path: string;
  line: number;
  text: string;
  context?: string[];
}

async function walk(
  dir: string,
  workspaceRoot: string,
  currentDepth: number,
  maxDepth: number,
  includeHidden: boolean,
  fileGlob: string | undefined,
  files: string[],
): Promise<void> {
  if (currentDepth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, workspaceRoot, currentDepth + 1, maxDepth, includeHidden, fileGlob, files);
    } else if (entry.isFile()) {
      if (fileGlob && !matchGlob(entry.name, fileGlob)) continue;
      if (!looksTextLike(entry.name)) continue;
      files.push(full);
    }
  }
}

/**
 * Workspace-scoped grep. Walks `path` recursively, reads each text-like file
 * up to FILE_BYTE_CAP, and returns line-level matches for `pattern`. Designed
 * for goal-answer grounding: callers (e.g. summarize-and-emit-concept) use it
 * to find local references to the goal's topic before asking the LLM.
 *
 * Limits: maxMatches (default 50), maxDepth (default 8), per-file 512 KiB cap,
 * skips node_modules / .git / hidden-by-default. Binary-looking files are
 * filtered by extension. caseInsensitive defaults to true.
 */
export async function resolveFsGrep(pointer: FsGrepPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);

  if (!pointer.pattern || pointer.pattern.trim().length === 0) {
    throw new Error("fs_grep: pattern is required");
  }

  const maxMatches = pointer.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxDepth = pointer.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFilesScanned = pointer.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED;
  const ctxLines = pointer.contextLines ?? DEFAULT_CONTEXT_LINES;
  const caseInsensitive = pointer.caseInsensitive ?? true;

  let regex: RegExp;
  try {
    regex = new RegExp(pointer.pattern, caseInsensitive ? "gi" : "g");
  } catch (err) {
    throw new Error(`fs_grep: invalid regex: ${(err as Error).message}`);
  }

  const files: string[] = [];
  await walk(pointer.path, workspaceRoot, 0, maxDepth, pointer.includeHidden ?? false, pointer.fileGlob, files);

  const matches: Match[] = [];
  let filesScanned = 0;
  let filesCappedAt = files.length > maxFilesScanned ? maxFilesScanned : files.length;
  for (let fi = 0; fi < filesCappedAt; fi++) {
    const file = files[fi]!;
    if (matches.length >= maxMatches) break;
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      continue;
    }
    if (buf.byteLength > FILE_BYTE_CAP) {
      buf = buf.subarray(0, FILE_BYTE_CAP);
    }
    filesScanned++;
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      regex.lastIndex = 0;
      if (regex.test(line)) {
        const m: Match = {
          path: relative(workspaceRoot, file),
          line: i + 1,
          text: line.length > 240 ? line.slice(0, 240) + "…" : line,
        };
        if (ctxLines > 0) {
          const from = Math.max(0, i - ctxLines);
          const to = Math.min(lines.length, i + ctxLines + 1);
          m.context = lines.slice(from, to).map((l) => (l.length > 240 ? l.slice(0, 240) + "…" : l));
        }
        matches.push(m);
        if (matches.length >= maxMatches) break;
      }
    }
  }

  return {
    shape: "fileSearchResult",
    body: {
      path: pointer.path,
      pattern: pointer.pattern,
      filesScanned,
      filesFound: files.length,
      filesCappedAt: files.length > maxFilesScanned ? maxFilesScanned : files.length,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches || files.length > maxFilesScanned,
      matches,
    },
  };
}
