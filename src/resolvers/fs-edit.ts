import { resolve, relative } from "path";
import type { ResolverResult } from "./types.js";
import { resolveInAnyWorkspace } from "./workspace-roots.js";

export interface FsEditPointer {
  type: "fs_edit";
  path: string;
  oldString: string;
  newString: string;
}

export async function resolveFsEdit(pointer: FsEditPointer): Promise<ResolverResult> {
  const workspaceRoot = process.env["WORKSPACE_ROOT"] ?? process.cwd();
  pointer.oldString = pointer.oldString ?? (pointer as unknown as Record<string, string>)["old_string"];
  pointer.newString = pointer.newString ?? (pointer as unknown as Record<string, string>)["new_string"];
  // Validate AND resolve. A relative path must be read/written under the
  // workspace root, not under this process's cwd — see workspace-roots.ts.
  const absPath = resolveInAnyWorkspace(pointer.path, workspaceRoot);

  if (pointer.oldString === pointer.newString) {
    throw new Error("oldString and newString are identical — no edit needed");
  }

  const file = Bun.file(absPath);
  if (!(await file.exists())) throw new Error(`file not found: ${pointer.path}`);

  const content = await file.text();
  const occurrences = content.split(pointer.oldString).length - 1;
  if (occurrences === 0) throw new Error(`oldString not found in ${pointer.path}`);
  if (occurrences > 1) throw new Error(`oldString matches ${occurrences} times in ${pointer.path} — use a more specific string`);

  const updated = content.replace(pointer.oldString, pointer.newString);
  await Bun.write(absPath, updated);
  return { shape: "fileEditResult", body: { path: pointer.path, replacedCount: 1 } };
}
