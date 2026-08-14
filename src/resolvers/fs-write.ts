import { truncatingRewriteReason } from "../vacuous-edit.js";
import { resolve, relative, dirname } from "path";
import { mkdir } from "fs/promises";
import type { ResolverResult } from "./types.js";
import { assertInAnyWorkspace } from "./workspace-roots.js";

export interface FsWritePointer {
  type: "fs_write";
  path: string;
  content: string;
  createDirs?: boolean;
}

function assertInWorkspace(path: string, workspaceRoot: string): void {
  assertInAnyWorkspace(path, workspaceRoot);
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
  const WRITE_ALLOWLIST = process.env["WRITE_ALLOWLIST"]; const raw = WRITE_ALLOWLIST;
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
  // A TRUNCATION GUARD MUST LIVE WITH EVERY PRODUCER OF THE SHAPE, NOT ONE OF THEM.
  //
  // `fs_write` is advertised by BOTH this vessel (config.ts discovery.shapes) and
  // local-tools-vessel, and `registry_query mode:vessels shape:fs_write` returns
  // four producers including `development-vessel-local@spoke-cfda39e7`. Routing is
  // dynamic by design (law 1), so a caller that resolves the SHAPE can land on
  // either implementation. local-tools-vessel/src/index.ts:170 refuses a write
  // that discards >90% of a substantial file; this one refused nothing, so the
  // protection was producer-local — which in a shape-routed system means it was
  // a coin flip.
  //
  // The guards above bound WHERE a write may land. This one bounds WHAT it may
  // contain, and the two are not substitutes: the deployed unit sets
  // EXTRA_WORKSPACE_ROOTS=/vessels/packages (live shared source) and
  // WORKSPACE_ROOT=/workspace (the super-repo clones pull-sync mirrors into
  // /vessels), both legitimately writable and both destroyable by a whole-file
  // write that collapses.
  //
  // Advisory on a stat failure, deliberately: a guard that cannot read the
  // previous file must not block a legitimate write.
  try {
    const existing = Bun.file(pointer.path);
    if (await existing.exists()) {
      const prev = await existing.text();
      const reason = truncatingRewriteReason(prev, pointer.content, pointer.path);
      if (reason) {
        console.error(`[development-vessel] fs_write REFUSED: ${reason}`);
        return {
          shape: "structuredError",
          body: {
            resolver: "fs_write",
            failure_mode: "would_truncate",
            detail: `${reason} — use fs_edit with a verbatim anchor for a partial change.`,
            path: pointer.path,
          },
        };
      }
    }
  } catch { /* existence/read probe is advisory — never block a write on a stat failure */ }
  await Bun.write(pointer.path, pointer.content);
  const bytesWritten = new TextEncoder().encode(pointer.content).byteLength;
  return { shape: "fileWriteResult", body: { path: pointer.path, bytesWritten } };
}
