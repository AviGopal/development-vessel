/**
 * test-defect-localization-budget seed templates — what the check-supply tick's test-defect pass counts against max_per_tick, as an
 * activity with a variant (src/resolvers/gap-check-supply.ts testDefectPass). The catalogue must carry both,
 * the variant linked to its base by variant_of, both with seed_version >= 1, the shape signature the decision traces
 * carry (substrateGap -> testDefectLocalizationBudget), and the consumer grade. Read from SEED_TEMPLATES by id.
 */
import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "../../src/seed/index.js";

const byId = (id: string) => SEED_TEMPLATES.find((t) => t.id === id) as (typeof SEED_TEMPLATES)[number] & { variant_of?: string; metadata?: Record<string, unknown> } | undefined;

describe("template contract — development-vessel:test-defect-localization-budget and its variant-1", () => {
  it("[MUST-FAIL] both are registered: the control and development-vessel:test-defect-localization-budget-v1, variant_of the base", () => {
    const base = byId("development-vessel:test-defect-localization-budget");
    const v1 = byId("development-vessel:test-defect-localization-budget-v1");
    expect(base).toBeDefined();
    expect(v1).toBeDefined();
    expect(v1!.variant_of).toBe("development-vessel:test-defect-localization-budget");
    expect(base!.variant_of).toBeUndefined();
  });
  it("[MUST-FAIL] both carry the traced shape signature (substrateGap -> testDefectLocalizationBudget), one deterministic task, the consumer grade, and seed_version >= 1", () => {
    for (const id of ["development-vessel:test-defect-localization-budget", "development-vessel:test-defect-localization-budget-v1"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t!.inputShapes).toEqual(["substrateGap"]);
      expect(t!.outputShapes).toEqual(["testDefectLocalizationBudget"]);
      expect(t!.tasks).toHaveLength(1);
      expect(t!.tasks[0]!.resolver).toBe("deterministic");
      expect(t!.tasks[0]!.outputShapes).toEqual(["testDefectLocalizationBudget"]);
      expect(t!.metadata?.["reach_decided_by"]).toBe("consumer");
      expect(Number(t!.metadata?.["seed_version"] ?? 0)).toBeGreaterThanOrEqual(1);
    }
    expect(byId("development-vessel:test-defect-localization-budget")!.metadata?.["variant_role"]).toBe("control");
    expect(byId("development-vessel:test-defect-localization-budget-v1")!.metadata?.["variant_role"]).toBe("treatment");
  });
  it("[CONTROL] the catalogue's ids stay unique", () => {
    const ids = SEED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
