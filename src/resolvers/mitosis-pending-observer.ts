import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * mitosis_pending_observer — promotes the staging pointer file
 * (WORKSPACE_ROOT/mitosis-pending.json) into impulse form. This is what
 * the host-sync worker watches; if it sits stale, the autonomous self-repair
 * loop is stuck at "patch applied but never published".
 *
 * Emits mitosisPendingState with the current pending entry (or null) and
 * the file's age.
 */

interface PendingShape {
  vessel_name?: string;
  base_version_id?: string;
  mitosis_version_id?: string;
  mitosis_root?: string;
  base_sha?: string;
  staged_at?: string;
  authored_by?: string;
  proposal?: string;
  target_file?: string;
  staged_files?: string[];
}

export interface MitosisPendingObserverPointer {
  type: "mitosis_pending_observer";
  workspaceRoot?: string;
}

export async function resolveMitosisPendingObserver(
  pointer: MitosisPendingObserverPointer,
): Promise<ResolverResult> {
  const root = pointer.workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const path = join(root, "mitosis-pending.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      shape: "mitosisPendingState",
      body: {
        has_pending: false,
        pending: null,
        file_present: false,
        file_age_ms: null,
        generated_at: new Date().toISOString(),
      },
    };
  }

  let parsed: PendingShape | null = null;
  try {
    parsed = JSON.parse(raw) as PendingShape;
  } catch {
    parsed = null;
  }

  let ageMs: number | null = null;
  try {
    const s = await stat(path);
    ageMs = Math.max(0, Date.now() - s.mtimeMs);
  } catch {
    // ignore
  }

  const hasPending = parsed !== null && Object.keys(parsed).length > 0;

  return {
    shape: "mitosisPendingState",
    body: {
      has_pending: hasPending,
      pending: hasPending
        ? {
            vessel_name: parsed?.vessel_name ?? null,
            mitosis_version_id: parsed?.mitosis_version_id ?? null,
            base_sha: parsed?.base_sha ?? null,
            proposal: parsed?.proposal ?? null,
            target_file: parsed?.target_file ?? null,
            staged_files: parsed?.staged_files ?? [],
            staged_at: parsed?.staged_at ?? null,
            authored_by: parsed?.authored_by ?? null,
          }
        : null,
      file_present: true,
      file_age_ms: ageMs,
      generated_at: new Date().toISOString(),
    },
  };
}
