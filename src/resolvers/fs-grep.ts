import { relative, join, isAbsolute } from "path";
import { readdir, readFile } from "node:fs/promises";
import type { ResolverResult } from "./types.js";
import { resolveInAnyWorkspaceForRead } from "./workspace-roots.js";

export interface FsGrepPointer {
  type: "fs_grep";
  /** A directory to search: absolute, workspace-relative, `repos/<vessel>/...`, or omitted / `repos`
   *  for every vessel's source (the runtime tree). */
  path?: string;
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
const MAX_MATCHES_CAP = 200;
const DEFAULT_MAX_DEPTH = 8;
// A repo-wide search walks every vessel's source (~1.3k text files, measured 10-02); 1500 truncated it.
const DEFAULT_MAX_FILES_SCANNED = 4000;
const SNIPPET_CHARS = 240;
const MAX_DEPTH_CAP = 12;
const MAX_FILES_SCANNED_CAP = 10_000;
/** The model-supplied regex runs against at most this much of a line (no unbounded backtracking
 *  over a minified one-line bundle); a match past it is not found. */
const LINE_SCAN_CHARS = 2_000;
/** Directories that are never source: dependencies, VCS, build output, caches. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".bun-cache"]);
/** Never searched, whatever a caller passes (local-tools tool-roots.ts NEVER_INSIDE_A_ROOT). */
const NEVER_SEARCHED: readonly string[] = ["/etc", "/proc", "/workspace/.substrate-secrets"];
const DEFAULT_CONTEXT_LINES = 0;
const FILE_BYTE_CAP = 512 * 1024;
const TEXT_LIKE_EXT = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".sh", ".bash", ".py", ".go", ".rs", ".sql", ".html", ".css",
  ".scss", ".vue", ".svelte", ".ini", ".env", ".cfg", ".conf",
]);

/** The runtime tree every vessel's source is installed in (the `/vessels/<vessel>` layout). */
function runtimeRoot(): string {
  return process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels";
}

/**
 * The directory a search walks, resolved against a ROOT and never against process.cwd() (the bug
 * workspace-roots.ts documents: this resolver walked the raw string, so a relative path searched
 * /vessels/development-vessel/<path> and found nothing). `repos/<vessel>/...` maps onto the runtime
 * tree, the convention local-tools mapPath uses; omitted or bare `repos` is every vessel. Read roots
 * apply (resolveInAnyWorkspaceForRead), and the never-searched locations are refused outright.
 */
export function searchRootFor(path: string | undefined, workspaceRoot: string): string {
  const p = (typeof path === "string" ? path.trim() : "") || "repos";
  let abs: string;
  if (p === "repos" || p === "repos/") abs = runtimeRoot();
  else if (p.startsWith("repos/")) abs = resolveInAnyWorkspaceForRead(join(runtimeRoot(), p.slice("repos/".length)), workspaceRoot);
  else abs = resolveInAnyWorkspaceForRead(p, workspaceRoot);
  // A root INSIDE a protected location is refused. A root that merely contains one (WORKSPACE_ROOT
  // itself holds .substrate-secrets) stays searchable: that file is skipped by name (isSecretBearing).
  for (const n of NEVER_SEARCHED) {
    const rel = relative(n, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(`path outside workspace root: ${p} (never searched)`);
    }
  }
  return abs;
}

/**
 * The vessel-qualified address of a matched file — the form a citation names and the citation
 * oracle (goal-host verifyCodeInvestigationCitation) re-reads under /workspace/git/super-repo/:
 * `repos/<vessel>/<rest>` for vessel source, `packages/<rest>` for the shared packages. A file under
 * neither layout keeps its workspace-relative path.
 */
export function qualifiedSourcePath(abs: string, workspaceRoot: string): string {
  const rt = relative(runtimeRoot(), abs);
  if (rt && !rt.startsWith("..") && !isAbsolute(rt)) return rt.startsWith("packages/") ? rt : `repos/${rt}`;
  const m = abs.match(/\/(?:repos|git\/vessels)\/([^/]+\/.+)$/);
  if (m) return `repos/${m[1]}`;
  return relative(workspaceRoot, abs);
}

/** Files that can hold credentials are never read, even with includeHidden: .env*, the substrate
 *  secrets file (and anything named after it), npmrc, private keys and ssh identities. */
export function isSecretBearing(name: string): boolean {
  return /^\.env(\.|$)/i.test(name)
    || /^\.?substrate-secrets/i.test(name)
    || /^\.?npmrc$/i.test(name)
    || /\.(pem|key)$/i.test(name)
    || /^id_/i.test(name);
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
  /** Vessel-qualified (`repos/<vessel>/...`), the address a citation names; see qualifiedSourcePath. */
  url: string;
  line: number;
  text: string;
  context?: string[];
}

/**
 * One search result in the webSearchResult form (local-tools web_search: `results: [{title, url,
 * snippet}]`), so one consumer reads web and code results alike. `url` is re-readable: for code it is
 * the vessel-qualified path the citation oracle opens; `title` adds the line.
 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  line: number;
}

async function walk(
  dir: string,
  workspaceRoot: string,
  currentDepth: number,
  maxDepth: number,
  includeHidden: boolean,
  fileGlob: string | undefined,
  files: string[],
  maxFiles: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  if (currentDepth > maxDepth || files.length > maxFiles) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name) || isSecretBearing(entry.name)) continue;
    const full = join(dir, entry.name);
    // Symlinks are neither isDirectory() nor isFile() on a Dirent, so none is followed out of the root.
    if (entry.isDirectory()) {
      // A mitosis backup of a vessel is a stale copy of source that is searched once already.
      if (/-mitosis-/.test(entry.name)) continue;
      await walk(full, workspaceRoot, currentDepth + 1, maxDepth, includeHidden, fileGlob, files, maxFiles);
      if (files.length > maxFiles) return;
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
  const root = searchRootFor(pointer.path, workspaceRoot);

  if (!pointer.pattern || pointer.pattern.trim().length === 0) {
    throw new Error("fs_grep: pattern is required");
  }

  const maxMatches = Math.max(1, Math.min(pointer.maxMatches ?? DEFAULT_MAX_MATCHES, MAX_MATCHES_CAP));
  // Caller-supplied bounds are clamped: a model passes these through the floor's tool call.
  const clamp = (v: unknown, dflt: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(Math.floor(v), hi)) : dflt);
  const maxDepth = clamp(pointer.maxDepth, DEFAULT_MAX_DEPTH, 0, MAX_DEPTH_CAP);
  const maxFilesScanned = clamp(pointer.maxFilesScanned, DEFAULT_MAX_FILES_SCANNED, 1, MAX_FILES_SCANNED_CAP);
  const ctxLines = pointer.contextLines ?? DEFAULT_CONTEXT_LINES;
  const caseInsensitive = pointer.caseInsensitive ?? true;

  let regex: RegExp;
  try {
    regex = new RegExp(pointer.pattern, caseInsensitive ? "gi" : "g");
  } catch (err) {
    throw new Error(`fs_grep: invalid regex: ${(err as Error).message}`);
  }

  const files: string[] = [];
  // Collect one file past the cap, so `truncated` can still say the tree was larger.
  await walk(root, workspaceRoot, 0, maxDepth, pointer.includeHidden ?? false, pointer.fileGlob, files, maxFilesScanned);

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
      if (regex.test(line.length > LINE_SCAN_CHARS ? line.slice(0, LINE_SCAN_CHARS) : line)) {
        const m: Match = {
          path: relative(workspaceRoot, file),
          url: qualifiedSourcePath(file, workspaceRoot),
          line: i + 1,
          text: line.length > SNIPPET_CHARS ? line.slice(0, SNIPPET_CHARS) + "…" : line,
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

  const results: SearchResultItem[] = matches.map((m) => ({ title: `${m.url}:${m.line}`, url: m.url, snippet: m.text.trim(), line: m.line }));
  return {
    shape: "fileSearchResult",
    body: {
      // results FIRST: a consumer that truncates the serialized body (the floor cuts each tool
      // observation at 4000 chars) must keep the webSearchResult-form list, not the legacy matches.
      // The webSearchResult form: the same consumer reads web and code search results.
      results,
      provider: "fs_grep",
      path: pointer.path ?? "repos",
      root,
      pattern: pointer.pattern,
      filesScanned,
      filesFound: files.length,
      filesCappedAt: files.length > maxFilesScanned ? maxFilesScanned : files.length,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches || files.length > maxFilesScanned,
      // Legacy line-level form, read by ias summarize-and-emit-concept (path/line/text).
      matches,
    },
  };
}
