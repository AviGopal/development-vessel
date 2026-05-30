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

/**
 * Optional sub-workspace allowlist. When WRITE_ALLOWLIST is set, every
 * write must additionally start with one of the comma-separated relative
 * prefixes (e.g. "openspec/changes/,validation/failure-modes/proposals/").
 * When unset, behavior is unchanged — any path inside WORKSPACE_ROOT is
 * writable. See openspec/changes/2026-05-30-draft-spec-from-gap-template
 * for the motivation.
 */
function assertInAllowlist(path: string, workspaceRoot: string): void {
  const raw = process.env["WRITE_ALLOWLIST"];
  if (!raw) return;
  const prefixes = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (prefixes.length === 0) return;
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  const ok = prefixes.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`) || rel.startsWith(p));
  if (!ok) {
    throw new Error(`path outside write allowlist: ${rel} (allowed prefixes: ${prefixes.join(", ")})`);
  }
}

export async function resolveFsWrite(pointer: FsWritePointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);
  assertInAllowlist(pointer.path, workspaceRoot);
  if (pointer.createDirs) {
    await mkdir(dirname(resolve(pointer.path)), { recursive: true });
  }
  await Bun.write(pointer.path, pointer.content);
  const bytesWritten = new TextEncoder().encode(pointer.content).byteLength;
  return { shape: "fileWriteResult", body: { path: pointer.path, bytesWritten } };
}
