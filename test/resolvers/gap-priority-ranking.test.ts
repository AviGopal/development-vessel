// I3a: THE TERMS VARIANT RANKS BY IMPACT, CONTINGENCY, COST AND VIABILITY FROM EXISTING RECORDS, WEIGHTED BY A SHAPED
// BETA PER TERM. No term carries a scale constant (rank-normalised within the pool) and no wording is read (ids and
// summaries never enter a term). The baseline (today's hand-set score) is not touched here.
import { describe, expect, it } from "bun:test";
import { PRIORITY_TERMS, rankByTerms, rankNormalise, sampleTermWeights, termValues } from "../../src/resolvers/gap-priority-ranking.js";

type Row = Record<string, unknown>;
const goal = (h: string) => ({ source: "goal_reach", goal_hash: h, dispatch_id: `d-${h}`, origin: "operator" });
const gap = (id: string, meta: Row = {}, extra: Row = {}): Row => ({ id, status: "open", category: "systematic_failure", source: "operator", summary: `fixture ${id}`, classification_metadata: meta, ...extra });
const ctxFor = (pool: Row[], spend: Record<string, number> = {}, theta: Record<string, number> = {}) => ({
  byId: new Map(pool.map((g) => [String(g.id), g])),
  spendOf: (g: Row) => spend[String(g.id)] ?? 0,
  classTheta: (cls: string) => theta[cls] ?? 0.5,
});
const ids = (r: Array<{ g: Row }>) => r.map((x) => String(x.g.id));
const impactHeavy = { impact: 0.95, contingency: 0.05, cost: 0.05, viability: 0.05 };

describe("rankByTerms: the TERMS variant", () => {
  it("[MUST-FAIL] equal class and spend: the gap three goals reach-failed on ranks first when impact's weight is high", () => {
    const a = gap("gap-a", { demand_goals: [goal("g1"), goal("g2"), goal("g3")] });
    const b = gap("gap-b", {});
    const pool = [b, a];
    expect(ids(rankByTerms(pool, ctxFor(pool), impactHeavy))).toEqual(["gap-a", "gap-b"]);
  });

  it("[MUST-FAIL] contingency: a gap whose open children and lineage descendants depend on it outranks one with none", () => {
    const parent = gap("gap-p", { decomposition: { children: ["gap-p-step-1", "gap-p-step-2"] } });
    const kids = [gap("gap-p-step-1", { parent_gap_id: "gap-p" }), gap("gap-p-step-2", { parent_gap_id: "gap-p" }), gap("gap-desc", { source_gap_id: "gap-p" })];
    const lone = gap("gap-lone");
    const pool = [lone, parent];
    const byId = new Map([...pool, ...kids].map((g) => [String(g.id), g]));
    expect(termValues(parent, { ...ctxFor(pool), byId }).contingency).toBe(3);
    expect(ids(rankByTerms(pool, { ...ctxFor(pool), byId }, { impact: 0.05, contingency: 0.95, cost: 0.05, viability: 0.05 }))[0]).toBe("gap-p");
  });

  it("[CONTROL] a closed child is not a dependent; demand_goals legacy strings are not goal links", () => {
    const parent = gap("gap-q", { decomposition: { children: ["gap-q-1"] }, demand_goals: ["a legacy goal string"] });
    const closedKid = gap("gap-q-1", { parent_gap_id: "gap-q" }, { status: "closed" });
    const byId = new Map([parent, closedKid].map((g) => [String(g.id), g]));
    const v = termValues(parent, { ...ctxFor([parent]), byId });
    expect(v.contingency).toBe(0);
    expect(v.impact).toBe(0);
  });

  it("[PARAPHRASE] rewording a gap's id and summary (adding or removing the baseline's regex tokens) does not move its rank", () => {
    const meta = { demand_goals: [goal("g1"), goal("g2")] };
    const other = gap("gap-other", { demand_goals: [goal("g9")] });
    const variants = [
      gap("gap-plain", meta),
      gap("recommit-gap-plain", meta, { summary: "recommit backlog unknown stale-proposal" }),
      gap("gap-plain-backlog-unknown", meta, { summary: "a completely different wording of the same need" }),
    ];
    const fixedTheta = { impact: 0.7, contingency: 0.2, cost: 0.4, viability: 0.3 };
    for (const v of variants) {
      const pool = [other, v];
      expect(ids(rankByTerms(pool, ctxFor(pool), fixedTheta))[0]).toBe(String(v.id));
    }
  });

  it("[HELD-OUT] a gap of a class with no posterior row and no demand still ranks (Beta(1,1)), never excluded", () => {
    const fresh = gap("brand-new-class-gap");
    const pool = [gap("gap-x", { demand_goals: [goal("g1")] }), fresh];
    const r = rankByTerms(pool, ctxFor(pool), sampleTermWeights(null));
    expect(r.length).toBe(2);
    expect(ids(r)).toContain("brand-new-class-gap");
  });

  it("[HELD-OUT] cost: equal demand, three times the lineage spend ranks LOWER when cost's weight is high", () => {
    const cheap = gap("gap-cheap", { demand_goals: [goal("g1")] });
    const dear = gap("gap-dear", { demand_goals: [goal("g2")] });
    const pool = [dear, cheap];
    expect(ids(rankByTerms(pool, ctxFor(pool, { "gap-dear": 3, "gap-cheap": 1 }), { impact: 0.05, contingency: 0.05, cost: 0.95, viability: 0.05 }))).toEqual(["gap-cheap", "gap-dear"]);
  });
});

describe("the weights: shaped Beta per term, sampled per pick", () => {
  it("[UNIT] an absent record is Beta(1,1) for every term; a Beta(20,1) term samples high", () => {
    const flat = sampleTermWeights(null);
    expect(Object.keys(flat).sort()).toEqual([...PRIORITY_TERMS].sort());
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += sampleTermWeights({ impact: { alpha: 20, beta: 1 } }).impact;
    expect(sum / 300).toBeGreaterThan(0.85);
  });
  it("[UNIT] rankNormalise: [0, 1] by position among the others, ties share, a single member is 0.5", () => {
    expect(rankNormalise([1, 2, 3])).toEqual([0, 0.5, 1]);
    expect(rankNormalise([2, 2])).toEqual([0.5, 0.5]);
    expect(rankNormalise([7])).toEqual([0.5]);
  });
});
