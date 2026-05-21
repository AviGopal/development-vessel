import { resolve, relative, dirname } from "path";
import { mkdir } from "fs/promises";
import type { ResolverResult } from "./types.js";

export interface FsWritePointer {
  type: "fs_write";
  path: string;
  content: string;
  createDirs?: boolean;
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path outside workspace root: ${path}`);
  }
}

export async function resolveFsWrite(pointer: FsWritePointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);
  if (pointer.createDirs) {
    await mkdir(dirname(resolve(pointer.path)), { recursive: true });
  }
  await Bun.write(pointer.path, pointer.content);
  const bytesWritten = new TextEncoder().encode(pointer.content).byteLength;
  return { shape: "fileWriteResult", body: { path: pointer.path, bytesWritten } };
}
