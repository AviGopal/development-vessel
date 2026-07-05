import { resolve, relative, isAbsolute } from "path";
import type { ResolverResult } from "./types.js";

export interface FsReadPointer {
  type: "fs_read";
  path: string;
  encoding?: BufferEncoding;
  byteLimit?: number;
  allow_missing?: boolean;
}

const DEFAULT_BYTE_LIMIT = 1024 * 1024; // 1 MiB

function assertInWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const allowedRoots: string[] = [workspaceRoot];
  const runtimeDir = process.env["MITOSIS_RUNTIME_DIR"];
  if (runtimeDir) allowedRoots.push(runtimeDir);
  allowedRoots.push("/vessels");
  const extraRoots = process.env["FS_READ_EXTRA_ROOTS"];
  if (extraRoots) {
    for (const entry of extraRoots.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) allowedRoots.push(trimmed);
    }
  }
  const extraWorkspaceRoots = process.env["EXTRA_WORKSPACE_ROOTS"];
  if (extraWorkspaceRoots) {
    for (const entry of extraWorkspaceRoots.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) allowedRoots.push(trimmed);
    }
  }
  for (const root of allowedRoots) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return;
  }
  throw new Error(`path outside workspace root: ${path}`);
}

export async function resolveFsRead(pointer: FsReadPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  if (pointer.allow_missing && !pointer.path) {
    return {
      shape: "fileContent",
      body: { path: pointer.path, bytes: 0, content: "", truncated: false, missing: true },
    };
  }
  assertInWorkspace(pointer.path, workspaceRoot);
  const byteLimit = pointer.byteLimit ?? DEFAULT_BYTE_LIMIT;

  const file = Bun.file(pointer.path);
  const stat = await file.exists();
  if (!stat) {
    if (pointer.allow_missing) {
      return {
        shape: "fileContent",
        body: { path: pointer.path, bytes: 0, content: "", truncated: false, missing: true },
      };
    }
    throw new Error(`file not found: ${pointer.path}`);
  }

  const bytes = await file.arrayBuffer();
  const truncated = bytes.byteLength > byteLimit;
  const sliced = truncated ? bytes.slice(0, byteLimit) : bytes;
  const content = new TextDecoder(pointer.encoding ?? "utf-8").decode(sliced);

  return {
    shape: "fileContent",
    body: { path: pointer.path, bytes: bytes.byteLength, content, truncated },
  };
}
