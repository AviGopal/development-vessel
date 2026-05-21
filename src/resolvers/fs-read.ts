import { resolve, relative } from "path";
import type { ResolverResult } from "./types.js";

export interface FsReadPointer {
  type: "fs_read";
  path: string;
  encoding?: BufferEncoding;
  byteLimit?: number;
}

const DEFAULT_BYTE_LIMIT = 1024 * 1024; // 1 MiB

function assertInWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path outside workspace root: ${path}`);
  }
}

export async function resolveFsRead(pointer: FsReadPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);
  const byteLimit = pointer.byteLimit ?? DEFAULT_BYTE_LIMIT;

  const file = Bun.file(pointer.path);
  const stat = await file.exists();
  if (!stat) throw new Error(`file not found: ${pointer.path}`);

  const bytes = await file.arrayBuffer();
  const truncated = bytes.byteLength > byteLimit;
  const sliced = truncated ? bytes.slice(0, byteLimit) : bytes;
  const content = new TextDecoder(pointer.encoding ?? "utf-8").decode(sliced);

  return {
    shape: "fileContent",
    body: { path: pointer.path, bytes: bytes.byteLength, content, truncated },
  };
}
