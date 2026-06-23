/**
 * In-memory store for Thompson observation records keyed by
 * (activity, shape) pairs.
 *
 * Provides get/update helpers used by the selector.
 */

import type { ThompsonRecord } from "./thompson-score.ts";

export type ActivityShapeKey = string;

export function makeKey(activity: string, shape: string): ActivityShapeKey {
  return `${activity}\x00${shape}`;
}

const store = new Map<ActivityShapeKey, ThompsonRecord>();

/** Retrieve the record for (activity, shape), or null if unseen. */
export function getRecord(
  activity: string,
  shape: string
): ThompsonRecord | null {
  return store.get(makeKey(activity, shape)) ?? null;
}

/** Record an outcome (success=true/false) for (activity, shape). */
export function recordOutcome(
  activity: string,
  shape: string,
  success: boolean
): void {
  const key = makeKey(activity, shape);
  const existing = store.get(key) ?? { successes: 0, trials: 0 };
  store.set(key, {
    successes: existing.successes + (success ? 1 : 0),
    trials: existing.trials + 1,
  });
}

/** Bulk-load records (e.g. from a persisted snapshot). */
export function loadRecords(
  entries: Array<{ activity: string; shape: string; record: ThompsonRecord }>
): void {
  for (const { activity, shape, record } of entries) {
    store.set(makeKey(activity, shape), { ...record });
  }
}

/** Snapshot current store for persistence. */
export function snapshotRecords(): Array<{
  activity: string;
  shape: string;
  record: ThompsonRecord;
}> {
  const results: Array<{ activity: string; shape: string; record: ThompsonRecord }> = [];
  for (const [key, record] of store.entries()) {
    const [activity, shape] = key.split("\x00", 2);
    if (activity !== undefined && shape !== undefined) {
      results.push({ activity, shape, record });
    }
  }
  return results;
}
