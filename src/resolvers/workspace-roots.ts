import { resolve, relative, isAbsolute } from "path";

// Multi-root workspace guard shared by the fs resolvers. WORKSPACE_ROOT is
// always allowed; EXTRA_WORKSPACE_ROOTS (comma-separated absolute paths) opens
// additional roots — e.g. the super-repo packages/ tree, which feature_compose
// could not author under the single-root guard (gap
// capability-gap-fs-guard-multi-root-packages).
export function allowedWorkspaceRoots(workspaceRoot: string): string[] {
  const roots = [workspaceRoot];
  const extra = process.env["EXTRA_WORKSPACE_ROOTS"];
  if (extra) {
    for (const entry of extra.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) roots.push(trimmed);
    }
  }
  return roots;
}

export function assertInAnyWorkspace(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  for (const root of allowedWorkspaceRoots(workspaceRoot)) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return;
  }
  throw new Error(`path outside workspace root: ${path}`);
}

export function assertInAnyWorkspaceForRead(path: string, workspaceRoot: string): void {
  const abs = resolve(path);
  const roots = [...allowedWorkspaceRoots(workspaceRoot), process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels"];
  for (const root of roots) {
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return;
  }
  throw new Error(`path outside workspace root: ${path}`);
}
