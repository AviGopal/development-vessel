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

// A RELATIVE PATH MUST RESOLVE AGAINST A ROOT, NOT AGAINST process.cwd().
//
// This guard used to do `resolve(path)` unconditionally. For a relative path
// node resolves against the CURRENT WORKING DIRECTORY, and no fs resolver runs
// with cwd == WORKSPACE_ROOT: measured on the live substrate, development-vessel
// runs with cwd=/vessels/development-vessel while WORKSPACE_ROOT is
// /workspace/git/super-repo. So `repos/activity-api/src/routes/activities.ts`
// resolved to /vessels/development-vessel/repos/... , `relative()` returned a
// `..`-prefixed path against every root, and the guard threw.
//
// The consequence was that EVERY relative path was rejected, always — and a
// relative `repos/<vessel>/src/...` is exactly the form the operator docs tell
// callers to name a file in, and exactly what feature_compose emits. Observed
// live as `fs_edit: HTTP 500 path outside workspace root:
// repos/identity-vessel/src/index.ts` on a file that demonstrably exists at
// /workspace/git/super-repo/repos/identity-vessel/src/index.ts. That made the
// substrate's autonomous edit path structurally unable to write vessel source.
//
// THIS DOES NOT WIDEN THE SANDBOX. A relative path is resolved against a
// candidate root and the containment check still runs against THAT SAME root,
// so nothing becomes reachable that an equivalent absolute path could not
// already reach. Traversal still fails: `../../etc/passwd` resolves out of the
// root and is rejected by the unchanged `..` test.
//
// Returns the resolved absolute path so callers stop operating on the raw
// relative string. That second half is load-bearing: `Bun.file(pointer.path)`
// on a relative path would read from cwd even once the guard passed, so a
// guard-only fix would trade a 500 for a silent wrong-file read.
function resolveWithin(path: string, roots: string[]): string {
  for (const root of roots) {
    const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return abs;
  }
  throw new Error(`path outside workspace root: ${path}`);
}

/** Validate a write/edit path and return its resolved absolute form. */
export function resolveInAnyWorkspace(path: string, workspaceRoot: string): string {
  return resolveWithin(path, allowedWorkspaceRoots(workspaceRoot));
}

/** Validate a read path and return its resolved absolute form. */
export function resolveInAnyWorkspaceForRead(path: string, workspaceRoot: string): string {
  return resolveWithin(path, [
    ...allowedWorkspaceRoots(workspaceRoot),
    process.env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
  ]);
}

export function assertInAnyWorkspace(path: string, workspaceRoot: string): void {
  resolveInAnyWorkspace(path, workspaceRoot);
}

export function assertInAnyWorkspaceForRead(path: string, workspaceRoot: string): void {
  resolveInAnyWorkspaceForRead(path, workspaceRoot);
}
