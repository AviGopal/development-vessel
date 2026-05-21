import { resolve, relative } from "path";
import type { ResolverResult } from "./types.js";

export interface FsEditPointer {
  type: "fs_edit";
  path: string;
  oldString: string;
  newString: string;
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const rel = relative(workspaceRoot, abs);
  if (rel.startsWith("..")) {
    throw new Error(`path outside workspace root: ${path}`);
  }
}

export async function resolveFsEdit(pointer: FsEditPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  assertInWorkspace(pointer.path, workspaceRoot);

  if (pointer.oldString === pointer.newString) {
    throw new Error("oldString and newString are identical — no edit needed");
  }

  const file = Bun.file(pointer.path);
  if (!(await file.exists())) throw new Error(`file not found: ${pointer.path}`);

  const content = await file.text();
  const occurrences = content.split(pointer.oldString).length - 1;
  if (occurrences === 0) throw new Error(`oldString not found in ${pointer.path}`);
  if (occurrences > 1) throw new Error(`oldString matches ${occurrences} times in ${pointer.path} — use a more specific string`);

  const updated = content.replace(pointer.oldString, pointer.newString);
  await Bun.write(pointer.path, updated);
  return { shape: "fileEditResult", body: { path: pointer.path, replacedCount: 1 } };
}
