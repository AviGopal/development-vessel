import { readdir, stat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * prune_stale_mitosis (2026-06-13) — the RESOLUTION half of the workspace-
 * hygiene loop. Deletes abandoned `<vessel>-mitosis-<ISO>` staging dirs that
 * (a) are not the active mitosis-pending entry, and (b) are older than
 * minAgeDays. Guarded + dry-run-capable because it is destructive:
 *   - pattern gate: only paths matching /-mitosis-/ under vesselsRoot
 *   - pinned gate: never touch the dir referenced by mitosis-pending.json
 *   - age gate: never touch a dir younger than minAgeDays (could be in-flight)
 *   - dry_run: list what WOULD be pruned without deleting
 * Returns mitosisPruneResult. Root-cause teardown (mitosis lifecycle deleting
 * its own staged dir on UNFAVORABLE) stops the leak; this clears the backlog.
 */

const DEFAULT_VESSELS_ROOT = "/vessels";
const DEFAULT_PENDING_PATH = "/workspace/mitosis-pending.json";

export interface PruneStaleMitosisPointer {
  type: "prune_stale_mitosis";
  vesselsRoot?: string;
  mitosisPendingPath?: string;
  /** Never prune dirs younger than this. Default 1 day. */
  minAgeDays?: number;
  /** Safety cap on deletions per run. Default 500. */
  maxDeletions?: number;
  /** When true, list candidates without deleting. */
  dry_run?: boolean;
}

export async function resolvePruneStaleMitosis(
  pointer: PruneStaleMitosisPointer,
): Promise<ResolverResult> {
  const root = pointer.vesselsRoot ?? DEFAULT_VESSELS_ROOT;
  const pendingPath = pointer.mitosisPendingPath ?? DEFAULT_PENDING_PATH;
  const minAgeDays = pointer.minAgeDays ?? 1;
  const maxDeletions = pointer.maxDeletions ?? 500;
  const dryRun = pointer.dry_run === true;

  const pinned = new Set<string>();
  try {
    const pj = JSON.parse(await readFile(pendingPath, "utf-8")) as Record<string, unknown>;
    for (const v of [pj["mitosis_root"], pj["staged_dir"], pj["dir"]]) {
      if (typeof v === "string" && v) pinned.add(v.replace(/\/+$/, "").split("/").pop()!);
    }
  } catch {
    // no pending file → nothing pinned
  }

  let names: string[] = [];
  try {
    const dirents = await readdir(root, { withFileTypes: true });
    names = dirents.filter((e) => e.isDirectory() && /-mitosis-/.test(e.name)).map((e) => e.name);
  } catch (err) {
    return {
      shape: "mitosisPruneResult",
      body: { vessels_root: root, error: err instanceof Error ? err.message.slice(0, 200) : String(err), pruned: 0 },
    };
  }

  const now = Date.now();
  const pruned: string[] = [];
  let keptPinned = 0;
  let keptRecent = 0;
  let errors = 0;
  for (const name of names) {
    if (pruned.length >= maxDeletions) break;
    if (pinned.has(name)) { keptPinned++; continue; }
    let ageDays = 0;
    try {
      const st = await stat(join(root, name));
      ageDays = (now - st.mtimeMs) / 86_400_000;
    } catch { errors++; continue; }
    if (ageDays < minAgeDays) { keptRecent++; continue; }
    if (dryRun) { pruned.push(name); continue; }
    try {
      // SAFETY: re-assert the pattern + root before deleting.
      if (!/-mitosis-/.test(name)) continue;
      await rm(join(root, name), { recursive: true, force: true });
      pruned.push(name);
    } catch { errors++; }
  }

  return {
    shape: "mitosisPruneResult",
    body: {
      vessels_root: root,
      dry_run: dryRun,
      candidates: names.length,
      pruned_count: pruned.length,
      kept_pinned: keptPinned,
      kept_recent: keptRecent,
      errors,
      min_age_days: minAgeDays,
      pruned: pruned.slice(0, 50),
      generated_at: new Date().toISOString(),
    },
  };
}
