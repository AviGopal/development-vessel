/**
 * recommend — returns scored candidates for goal routing.
 *
 * Each candidate receives a Thompson score drawn from
 * P(success | activity, shape).  Scores are NEVER null:
 * unseen pairs fall back to Beta(1,1) prior (uniform).
 *
 * Candidates are sorted descending by score so the top entry
 * is the recommended routing target.
 */

import { thompsonScore } from "./thompson-score.ts";
import { getRecord } from "./activity-shape-store.ts";

export interface Candidate {
  activity: string;
  shape: string;
  /** Populated by recommend(); never null after scoring. */
  thompsonScore?: number;
  /** Any additional fields passed through untouched. */
  [key: string]: unknown;
}

export interface ScoredCandidate extends Candidate {
  thompsonScore: number;
}

/**
 * Score and rank candidates.
 *
 * @param candidates  Raw candidates from the goal planner.
 * @returns           Same candidates with thompsonScore filled in,
 *                    sorted highest-score first.
 */
export function recommend(candidates: Candidate[]): ScoredCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const record = getRecord(c.activity, c.shape);
    // thompsonScore() always returns a number — never null/undefined
    const score = thompsonScore(record);
    return { ...c, thompsonScore: score };
  });

  // Descending sort: highest Thompson score first
  scored.sort((a, b) => b.thompsonScore - a.thompsonScore);

  return scored;
}
