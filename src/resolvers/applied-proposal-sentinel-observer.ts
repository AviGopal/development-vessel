import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * applied_proposal_sentinel_observer — promotes the .applied/ sentinel
 * directory (the only durable signal that a drafter proposal has been
 * consumed by apply_proposal_as_patch) into impulse form.
 *
 * Reads WORKSPACE_ROOT/proposals/.applied/ and emits one
 * appliedProposalSentinelState impulse with the recent applied list +
 * last-applied timestamp.
 */

export interface AppliedProposalSentinelObserverPointer {
  type: "applied_proposal_sentinel_observer";
  workspaceRoot?: string;
  recentLimit?: number;
}

export async function resolveAppliedProposalSentinelObserver(
  pointer: AppliedProposalSentinelObserverPointer,
): Promise<ResolverResult> {
  const root = pointer.workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const recentLimit = pointer.recentLimit ?? 20;
  const appliedDir = join(root, "proposals", ".applied");

  let entries: string[] = [];
  try {
    entries = await readdir(appliedDir);
  } catch {
    return {
      shape: "appliedProposalSentinelState",
      body: {
        applied_count: 0,
        recent_applied: [],
        last_applied_iso: null,
        last_applied_name: null,
        sentinel_dir_present: false,
        generated_at: new Date().toISOString(),
      },
    };
  }

  // Stat each to derive mtime; tolerate missing entries between readdir and stat.
  const withMtime: Array<{ name: string; mtime_ms: number }> = [];
  for (const name of entries) {
    try {
      const s = await stat(join(appliedDir, name));
      withMtime.push({ name, mtime_ms: s.mtimeMs });
    } catch {
      // skip
    }
  }
  withMtime.sort((a, b) => b.mtime_ms - a.mtime_ms);

  const recent = withMtime.slice(0, recentLimit).map((e) => ({
    name: e.name,
    applied_at_iso: new Date(e.mtime_ms).toISOString(),
  }));
  const last = withMtime[0] ?? null;

  return {
    shape: "appliedProposalSentinelState",
    body: {
      applied_count: withMtime.length,
      recent_applied: recent,
      last_applied_iso: last !== null ? new Date(last.mtime_ms).toISOString() : null,
      last_applied_name: last?.name ?? null,
      sentinel_dir_present: true,
      generated_at: new Date().toISOString(),
    },
  };
}
