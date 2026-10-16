/**
 * GAP PRIORITY RANKING, THE TERMS VARIANT (I3; user demonstration direction 2026-10-16: the system prioritises by
 * contingency, impact, cost and viability read from SHAPED fields; general-case gate G1–G6).
 *
 * The auto-pick (gap-to-feature pickMostLandable) ranks by a hand-set score: landabilityScore's category lists and id
 * regexes, blockingWeight's `+0.6` regex over edit_site, impactOf's text-citation count, HUMAN ×1.5, route-edit ×0.5,
 * mostly introduced by autonomous commits and never graded. This is the variant that competes with it (the BASELINE stays
 * today's score, unchanged); which one picks is the posterior's verdict, not an edit (I3b/I3c).
 *
 * Every term is computed from records the system already keeps (G3), and RANK-normalised within the pool, so no term
 * carries a scale constant:
 *   - impact:       the goals that reach-failed on this gap (demand_goals goal_reach links, linkedGoalHashes);
 *   - contingency:  the open work that depends on it (its decomposition children and lineage descendants still open);
 *   - cost:         the lineage's spend in the window (spend_ledger, lineageWindowSpendUsd), INVERTED: cheaper ranks higher;
 *   - viability:    the gap's class posterior, sampled (sampleClassTheta over I4's held class table).
 * Score = Σ θ_t · rank_t, with θ_t ~ Beta(α_t, β_t) from the shaped gapPriorityWeights record (absent → Beta(1,1) for
 * every term: equal weight, never a refusal). θ is sampled per pick, so the ranking explores by construction.
 * No wording is read: ids and summaries never enter a term (the paraphrase control pins it).
 */
import { linkedGoalHashes } from "../lib/demand-goals.js";
import { gapClassOf, sampleClassTheta } from "../judge/gap-attempt-credit.js";

export const PRIORITY_TERMS = ["impact", "contingency", "cost", "viability"] as const;
export type PriorityTerm = (typeof PRIORITY_TERMS)[number];
export type TermBeta = { alpha: number; beta: number };
export type PriorityWeights = Partial<Record<PriorityTerm, TermBeta>>;
type Row = Record<string, unknown>;

const metaOf = (g: Row): Row => ((g.classification_metadata ?? g.metadata ?? {}) as Row);
const isOpen = (g: Row | undefined): boolean => !!g && String(g.status ?? "open") === "open";

/** The raw term values of one gap, from records already on the rows. `spendOf` and `classTheta` are the caller's
 *  (the residue's lineage spend and the sampled class posterior), passed in so this module reads no store itself. */
export function termValues(g: Row, ctx: { byId: Map<string, Row>; spendOf: (g: Row) => number; classTheta: (cls: string) => number }): Record<PriorityTerm, number> {
  const id = String(g.id ?? "");
  const m = metaOf(g);
  const impact = linkedGoalHashes(m.demand_goals).length;
  const children = Array.isArray((m.decomposition as { children?: unknown } | undefined)?.children) ? ((m.decomposition as { children: unknown[] }).children.map(String)) : [];
  const dependents = new Set<string>(children.filter((c) => isOpen(ctx.byId.get(c))));
  for (const [oid, o] of ctx.byId) {
    if (oid === id || !isOpen(o)) continue;
    const om = metaOf(o);
    if (String(om.parent_gap_id ?? o.parent_gap_id ?? "") === id || String(om.source_gap_id ?? "") === id) dependents.add(oid);
  }
  return { impact, contingency: dependents.size, cost: -ctx.spendOf(g), viability: ctx.classTheta(gapClassOf(g)) };
}

/** Rank-normalise one term over the pool: the fraction of OTHER pool members this gap beats (ties share), in [0, 1]. */
export function rankNormalise(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  return values.map((v) => {
    let below = 0, equal = 0;
    for (const w of values) { if (w < v) below++; else if (w === v) equal++; }
    return (below + (equal - 1) / 2) / (n - 1);
  });
}

/** Sample one θ per term from the shaped weights (Beta(1,1) where the record says nothing). */
export function sampleTermWeights(weights: PriorityWeights | null | undefined): Record<PriorityTerm, number> {
  const posteriors = Object.fromEntries(PRIORITY_TERMS.map((t) => [t, weights?.[t] ?? { alpha: 1, beta: 1 }])) as Record<string, TermBeta>;
  return Object.fromEntries(PRIORITY_TERMS.map((t) => [t, sampleClassTheta(t, posteriors)])) as Record<PriorityTerm, number>;
}

export type RankedByTerms = { g: Row; s: number; ranks: Record<PriorityTerm, number>; values: Record<PriorityTerm, number> };
/** The TERMS variant's ranking of a pool, best first. Ties keep the pool's own order (a stable sort). */
export function rankByTerms(pool: Row[], ctx: { byId: Map<string, Row>; spendOf: (g: Row) => number; classTheta: (cls: string) => number }, theta: Record<PriorityTerm, number>): RankedByTerms[] {
  const vals = pool.map((g) => termValues(g, ctx));
  const ranks = Object.fromEntries(PRIORITY_TERMS.map((t) => [t, rankNormalise(vals.map((v) => v[t]))])) as Record<PriorityTerm, number[]>;
  const out = pool.map((g, i) => {
    const r = Object.fromEntries(PRIORITY_TERMS.map((t) => [t, ranks[t][i]!])) as Record<PriorityTerm, number>;
    return { g, values: vals[i]!, ranks: r, s: PRIORITY_TERMS.reduce((acc, t) => acc + theta[t] * r[t], 0) };
  });
  return out.map((x, i) => ({ x, i })).sort((a, b) => (b.x.s - a.x.s) || (a.i - b.i)).map(({ x }) => x);
}
