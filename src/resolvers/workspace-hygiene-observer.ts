import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * workspace_hygiene_observer (2026-06-13) — promotes /vessels directory-count
 * pollution into impulse form. Abandoned mitosis staging dirs
 * (`<vessel>-mitosis-<ISO>`) accumulate when mitosis_evaluate returns
 * UNFAVORABLE / a run is abandoned and nothing tears the staged dir down. At
 * scale (245/263 dirs observed 2026-06-13) they silently swamp the
 * vessel-responsibility-audit's scan cap, blinding the substrate's own
 * architectural self-audit.
 *
 * This observer is deliberately STANDALONE (does not depend on the audit it
 * protects) so it breaks the chicken-and-egg: it counts the mitosis dirs by
 * pattern and emits workspaceHygieneState with abandoned_count + oldest age +
 * an over_threshold flag. `pinned` dirs (the active mitosis-pending entry) are
 * never counted as abandoned. Disk-space-observer can't see this — these dirs
 * are mostly symlinks (cheap on bytes); the harm is COUNT, not bytes.
 */

const DEFAULT_VESSELS_ROOT = "/vessels";
const DEFAULT_PENDING_PATH = "/workspace/mitosis-pending.json";

export interface WorkspaceHygieneObserverPointer {
  type: "workspace_hygiene_observer";
  vesselsRoot?: string;
  mitosisPendingPath?: string;
  /** abandoned mitosis dirs above this → over_threshold=true. Default 25. */
  countThreshold?: number;
}

export async function resolveWorkspaceHygieneObserver(
  pointer: WorkspaceHygieneObserverPointer,
): Promise<ResolverResult> {
  const root = pointer.vesselsRoot ?? DEFAULT_VESSELS_ROOT;
  const pendingPath = pointer.mitosisPendingPath ?? DEFAULT_PENDING_PATH;
  const countThreshold = pointer.countThreshold ?? 25;

  // Pin the active mitosis dir(s) so they are never reported as abandoned.
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
      shape: "workspaceHygieneState",
      body: {
        vessels_root: root,
        mitosis_dir_count: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        generated_at: new Date().toISOString(),
      },
    };
  }

  const now = Date.now();
  let oldestAgeDays = 0;
  const sample: Array<{ name: string; age_days: number; pinned: boolean }> = [];
  for (const name of names) {
    let ageDays = 0;
    try {
      const st = await stat(join(root, name));
      ageDays = Math.round(((now - st.mtimeMs) / 86_400_000) * 10) / 10;
    } catch {
      // ignore unstattable entry
    }
    if (ageDays > oldestAgeDays) oldestAgeDays = ageDays;
    if (sample.length < 10) sample.push({ name, age_days: ageDays, pinned: pinned.has(name) });
  }

  const total = names.length;
  const pinnedCount = names.filter((n) => pinned.has(n)).length;
  const abandoned = total - pinnedCount;
  const overThreshold = abandoned > countThreshold;

  return {
    shape: "workspaceHygieneState",
    body: {
      vessels_root: root,
      mitosis_dir_count: total,
      pinned_count: pinnedCount,
      abandoned_count: abandoned,
      oldest_age_days: oldestAgeDays,
      count_threshold: countThreshold,
      over_threshold: overThreshold,
      recommended_action: overThreshold
        ? `prune ${abandoned} abandoned mitosis dirs (keep ${pinnedCount} pinned + recent); fix root cause: add teardown to vessel_mitosis lifecycle on UNFAVORABLE/abandonment`
        : "none",
      sample,
      generated_at: new Date().toISOString(),
    },
  };
}
