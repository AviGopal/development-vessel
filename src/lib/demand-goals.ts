/**
 * demand_goals entries on gap classification_metadata — the goal↔gap linkage.
 *
 * TWO WRITERS share this array:
 *   1. goal-host `fileCapabilityGap` (goal-host-vessel src/index.ts, demand-counted filing) writes
 *      plain STRINGS (goal text, last 10) and derives `demand_count` from them; its reader keeps
 *      strings only (`dg.filter((x) => typeof x === "string")`). Those entries are the minting
 *      floor ("a shape is real demand once a SECOND distinct goal needs it").
 *   2. the goal-reach seam (resolvers/goal-reach-tick.ts) writes STRUCTURED entries tagged
 *      `{source: "goal_reach", goal_hash, dispatch_id, origin}`: "this goal is blocked on this gap".
 *
 * Linkage reads ONLY source:"goal_reach" entries; legacy strings are never linkage, and a
 * goal_reach entry must never change what writer 1 counts. This module is the one merge both the
 * store (substrate-gap.ts, under its write lock) and the tick use, so it lives in lib/ rather than
 * in either of them (the store must not import the tick).
 */

export type GoalReachOrigin = "operator" | "surface" | "autonomous";

export interface GoalReachDemandEntry {
  source: "goal_reach";
  goal_hash: string;
  dispatch_id: string;
  origin: GoalReachOrigin;
}

/** True iff `e` is a well-formed goal_reach linkage entry (anything else is legacy/foreign). */
export function isGoalReachEntry(e: unknown): e is GoalReachDemandEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  return o["source"] === "goal_reach" && typeof o["goal_hash"] === "string" && o["goal_hash"].length > 0
    && typeof o["dispatch_id"] === "string";
}

const entryKey = (e: GoalReachDemandEntry): string => `${e.goal_hash}\u0000${e.dispatch_id}`;

/**
 * Append `entry` to an existing demand_goals value. Idempotent on (goal_hash, dispatch_id);
 * every existing entry (legacy strings, foreign objects, other goal_reach entries) is kept in
 * place and in order. A non-array `existing` is treated as empty. Never mutates its input.
 */
export function mergeDemandGoal(existing: unknown, entry: GoalReachDemandEntry): unknown[] {
  const base = Array.isArray(existing) ? existing.slice() : [];
  if (!isGoalReachEntry(entry)) return base;
  const k = entryKey(entry);
  if (base.some((x) => isGoalReachEntry(x) && entryKey(x) === k)) return base;
  base.push({ source: "goal_reach", goal_hash: entry.goal_hash, dispatch_id: entry.dispatch_id, origin: entry.origin });
  return base;
}

/**
 * The store-side carry-forward. `incoming` is what a writer sent for demand_goals (possibly a
 * legacy string-only rewrite from goal-host, which drops objects it cannot read); `prior` is the
 * stored value. Returns `incoming` with every goal_reach entry of `prior` it omitted appended, so
 * a legacy rewrite cannot erase linkage, and the legacy strings stay exactly as the writer sent
 * them (order and content), which keeps writer 1's count and floor byte-identical.
 */
export function carryGoalReachEntries(prior: unknown, incoming: unknown): unknown[] {
  let out = Array.isArray(incoming) ? incoming.slice() : [];
  if (!Array.isArray(prior)) return out;
  for (const p of prior) if (isGoalReachEntry(p)) out = mergeDemandGoal(out, p);
  return out;
}

/** The goal hashes a gap's demand_goals links (goal_reach entries only). */
export function linkedGoalHashes(demandGoals: unknown): string[] {
  if (!Array.isArray(demandGoals)) return [];
  return [...new Set(demandGoals.filter(isGoalReachEntry).map((e) => e.goal_hash))];
}
