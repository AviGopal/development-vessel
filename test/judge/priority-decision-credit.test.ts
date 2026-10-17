// I3b/c: WHICH RANKING PICKS IS LEARNED (qa ruling (A) + refinement). The baseline score and the terms ranking are arms
// of the priority_weights learning-credit table; the pick samples one, records the priority decision (variant, θ, the full
// pool term-rank vector) on the chosen gap's approach decision, and the decision's outcome credits the arm (and, under the
// terms variant, each term that ranked the chosen gap above the pool median: CORRELATED credit, the vector is kept).
// Written through the I4a recorder (journal, idempotency, decision reference) to the holder; here the holder is this
// process (GAP_STORE_ENDPOINT unset) over a temp gap store and temp table files.
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateLearnedStateInProcess } from "../resolvers/isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "priority-credit-"));
const KEYS = ["WORKSPACE_ROOT", "GAP_STORE_ENDPOINT", "GAP_CLASS_POSTERIOR_PATH", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env["WORKSPACE_ROOT"] = join(ROOT, "ws"); mkdirSync(process.env["WORKSPACE_ROOT"], { recursive: true });
isolateLearnedStateInProcess(process.env["WORKSPACE_ROOT"]); // learned state (posteriors, calibration, credit) under the temp root too, never /workspace
// The priority weights and the journal live beside the class posteriors (no locations of their own).
process.env["GAP_CLASS_POSTERIOR_PATH"] = join(ROOT, "class.json");
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const sg = await import("../../src/resolvers/substrate-gap.js");
const credit = await import("../../src/judge/gap-attempt-credit.js");
const lc = await import("../../src/judge/learning-credit.js");
const warn = spyOn(console, "warn").mockImplementation(() => {});
const RUN = Math.random().toString(36).slice(2, 8);
afterAll(() => { warn.mockRestore(); for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ } });
const table = (): Record<string, { alpha: number; beta: number }> => { try { return JSON.parse(readFileSync(join(ROOT, "gap-priority-weights.json"), "utf8")); } catch { return {}; } };
beforeEach(() => { rmSync(join(ROOT, "gap-priority-weights.json"), { force: true }); rmSync(join(ROOT, "gap-priority-weights.json.applied.json"), { force: true }); rmSync(join(ROOT, "learning-credit-journal.json"), { force: true }); });

async function seedAndDecide(id: string, priority?: Record<string, unknown>): Promise<{ meta: Record<string, unknown>; decisionId: string }> {
  await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `priority fixture ${id}`, classification_metadata: {} } } as never);
  await (sg as any).__settleBirthEvaluationsForTests?.();
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const g = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? [])[0]!;
  if (priority) credit.setPendingPriorityDecision(id, priority);
  const decisionId = (await credit.recordApproachDecision(g))!;
  const r2 = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const g2 = ((r2.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? [])[0]!;
  return { meta: g2.classification_metadata as Record<string, unknown>, decisionId };
}
const settle = async () => { for (let i = 0; i < 5; i++) { await lc.replayLearningJournal(); await new Promise((r) => setTimeout(r, 20)); } };

describe("the priority decision is stamped and credited when its outcome joins", () => {
  it("[MUST-FAIL] a terms-variant pick that LANDS credits variant:terms, and the terms that ranked the gap above the median", async () => {
    const id = `prio-terms-${RUN}`;
    const { meta, decisionId } = await seedAndDecide(id, { variant: "terms", theta: { impact: 0.9 }, pool: [{ id, ranks: { impact: 0.9, contingency: 0.75, cost: 0.2, viability: 0.5 } }, { id: "other", ranks: { impact: 0.1, contingency: 0.25, cost: 0.8, viability: 0.5 } }] });
    const entry = (meta.approach_decisions as Array<Record<string, unknown>>).find((e) => e.decision_id === decisionId)!;
    expect((entry.priority as { variant?: string }).variant).toBe("terms");
    expect(credit.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "abc1234" }, { decision_id: decisionId, gap_id: id })).toBe(true);
    await settle();
    const t = table();
    expect(t["variant:terms"]).toEqual({ alpha: 2, beta: 1 });
    expect(t["term:impact"]).toEqual({ alpha: 2, beta: 1 });
    expect(t["term:contingency"]).toEqual({ alpha: 2, beta: 1 });
    expect(t["term:cost"]).toBeUndefined();
    expect(t["term:viability"]).toBeUndefined(); // exactly the median is not above it
    expect(t["variant:baseline"]).toBeUndefined();
  });

  it("[MUST-FAIL] a miss credits the arm beta", async () => {
    const id = `prio-miss-${RUN}`;
    const { meta, decisionId } = await seedAndDecide(id, { variant: "terms", theta: {}, pool: [{ id, ranks: { impact: 1 } }] });
    credit.joinDecisionOutcome(meta, { landed: false }, { decision_id: decisionId, gap_id: id });
    await settle();
    expect(table()["variant:terms"]).toEqual({ alpha: 1, beta: 2 });
    expect(table()["term:impact"]).toEqual({ alpha: 1, beta: 2 });
  });

  it("[CONTROL] a baseline-variant pick credits only variant:baseline (the terms did not decide)", async () => {
    const id = `prio-base-${RUN}`;
    const { meta, decisionId } = await seedAndDecide(id, { variant: "baseline", theta: {}, pool: [{ id, ranks: { impact: 1, contingency: 1 } }] });
    credit.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "def5678" }, { decision_id: decisionId, gap_id: id });
    await settle();
    expect(Object.keys(table())).toEqual(["variant:baseline"]);
  });

  it("[HELD-OUT] a decision with no priority (an older pick) joins as before and credits nothing", async () => {
    const id = `prio-none-${RUN}`;
    const { meta, decisionId } = await seedAndDecide(id);
    expect(credit.joinDecisionOutcome(meta, { landed: true, verdict: "FAVORABLE", commit: "0a0b0c0" }, { decision_id: decisionId, gap_id: id })).toBe(true);
    await settle();
    expect(table()).toEqual({});
  });

  it("[WIRING] the pick samples the variant from the held priority_weights, scores by it, and registers the decision", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    expect(src).toContain('const prio = (heldLearningTable("priority_weights") ?? {})');
    expect(src).toContain("const variant = choosePriorityVariant(prio, priorityRng);");
    expect(src).toContain('return sampleClassTheta("variant:terms", prio, rng) > sampleClassTheta("variant:baseline", prio, rng) ? "terms" : "baseline";');
    expect(src).toContain('score: (g) => variant === "terms" ? (termsScore.get(g) ?? 0) : landabilityScore(g) * impactOf(g) * humanWeight(g),');
    expect(src).toContain("setPendingPriorityDecision(String(chosen.g.id");
    // the baseline variant's score is byte-identical to today's
    expect(src).toContain("landabilityScore(g) * impactOf(g) * humanWeight(g)");
  });
});

describe("I3 cold start and draw isolation (qa rulings (a), (b))", () => {
  const ftf = () => import("../../src/resolvers/gap-to-feature.js");
  it("[MUST-FAIL] the baseline arm's seed is its EARNED record: joined baseline decisions, landed vs not; terms decisions excluded", () => {
    const row = (decisions: unknown[]) => ({ id: "g", classification_metadata: { approach_decisions: decisions } }) as never;
    const r = sg.baselineEarnedRecord([
      row([{ decision_id: "a", outcome: { landed: true } }, { decision_id: "b", outcome: { landed: false } }, { decision_id: "u" }]),
      row([{ decision_id: "c", outcome: { landed: true }, priority: { variant: "baseline" } }, { decision_id: "d", outcome: { landed: true }, priority: { variant: "terms" } }]),
      row([{ decision_id: "e", outcome: { landed: false } }, { decision_id: "f", outcome: { landed: false } }]),
    ]);
    expect(r).toEqual({ alpha: 1 + 2, beta: 1 + 3 });
  });
  it("[CONTROL] with no joined decisions the seed is uninformed, Beta(1,1): nothing is declared", () => {
    expect(sg.baselineEarnedRecord([{ id: "g", classification_metadata: {} } as never])).toEqual({ alpha: 1, beta: 1 });
  });
  it("[MUST-FAIL] the baseline arm's FIRST credit persists from its seed (seed + 1), not from Beta(1,1); the terms arm starts uninformed", async () => {
    const seed = await sg.baselineEarnedRecordFromStore();
    await lc.creditLearning({ table: "priority_weights", key: "variant:baseline", outcome: "landed", gap_id: "x", event_id: "decision:d" });
    await lc.creditLearning({ table: "priority_weights", key: "variant:terms", outcome: "landed", gap_id: "x", event_id: "decision:d" });
    expect(table()["variant:baseline"]).toEqual({ alpha: seed.alpha + 1, beta: seed.beta });
    expect(table()["variant:terms"]).toEqual({ alpha: 2, beta: 1 });
  });
  it("[MUST-FAIL] the variant draw uses its own stream: Math.random is never called by it", async () => {
    const { choosePriorityVariant } = await ftf();
    let calls = 0;
    const real = Math.random;
    Math.random = () => { calls++; return real(); };
    try {
      let n = 0;
      const rng = () => ((n = (n * 9301 + 49297) % 233280) / 233280) || 0.5;
      for (let i = 0; i < 20; i++) choosePriorityVariant({ "variant:baseline": { alpha: 30, beta: 5 } }, rng);
    } finally { Math.random = real; }
    expect(calls).toBe(0);
  });
  it("[CONTROL] an earned baseline (30,5) against an uninformed terms arm is chosen most of the time: the same effect as 'stay baseline', derived", async () => {
    const { choosePriorityVariant } = await ftf();
    let baseline = 0;
    for (let i = 0; i < 400; i++) if (choosePriorityVariant({ "variant:baseline": { alpha: 30, beta: 5 } }, Math.random) === "baseline") baseline++;
    expect(baseline).toBeGreaterThan(300);
  });
});
