/**
 * failure-recall seed templates — goal-host's recall of a goal's earlier failures as an activity with a variant
 * (goal-host src/failure-recall.ts). The catalogue must carry both, the variant linked to its base by variant_of (a
 * standalone variant is a second, uninformed cell), both with seed_version >= 1 (else a populated catalogue never
 * receives them), the shape signature the goal-host traces carry (goal -> failureRecall), and the consumer grade.
 * Read from SEED_TEMPLATES by id, so a missing template fails on its absence.
 */
import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "../../src/seed/index.js";

const byId = (id: string) => SEED_TEMPLATES.find((t) => t.id === id) as (typeof SEED_TEMPLATES)[number] & { variant_of?: string; metadata?: Record<string, unknown> } | undefined;

describe("template contract — goal-host:failure-recall and its variant-1", () => {
  it("[MUST-FAIL] both are registered: the control and goal-host:failure-recall-v1, variant_of the base", () => {
    const base = byId("goal-host:failure-recall");
    const v1 = byId("goal-host:failure-recall-v1");
    expect(base).toBeDefined();
    expect(v1).toBeDefined();
    expect(v1!.variant_of).toBe("goal-host:failure-recall");
    expect(base!.variant_of).toBeUndefined();
  });
  it("[MUST-FAIL] both carry the traced shape signature (goal -> failureRecall), one deterministic task, the consumer grade, and seed_version >= 1", () => {
    for (const id of ["goal-host:failure-recall", "goal-host:failure-recall-v1"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t!.inputShapes).toEqual(["goal"]);
      expect(t!.outputShapes).toEqual(["failureRecall"]);
      expect(t!.tasks).toHaveLength(1);
      expect(t!.tasks[0]!.resolver).toBe("deterministic");
      expect(t!.tasks[0]!.outputShapes).toEqual(["failureRecall"]);
      expect(t!.metadata?.["reach_decided_by"]).toBe("consumer");
      expect(Number(t!.metadata?.["seed_version"] ?? 0)).toBeGreaterThanOrEqual(1);
    }
    expect(byId("goal-host:failure-recall")!.metadata?.["variant_role"]).toBe("control");
    expect(byId("goal-host:failure-recall-v1")!.metadata?.["variant_role"]).toBe("treatment");
  });
  it("[CONTROL] the catalogue's ids stay unique", () => {
    const ids = SEED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
