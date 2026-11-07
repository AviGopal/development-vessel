/**
 * check-region-cause-anchor seed templates — which region of a gap's edit site its check is anchored on, as an
 * activity with a variant (src/resolvers/check-region-cause-anchor.ts causeAnchorRegion). The catalogue must carry both,
 * the variant linked to its base by variant_of, both with seed_version >= 1, the shape signature the decision traces
 * carry (substrateGap -> checkRegionAnchor), and the consumer grade. Read from SEED_TEMPLATES by id.
 */
import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "../../src/seed/index.js";

const byId = (id: string) => SEED_TEMPLATES.find((t) => t.id === id) as (typeof SEED_TEMPLATES)[number] & { variant_of?: string; metadata?: Record<string, unknown> } | undefined;

describe("template contract — development-vessel:check-region-cause-anchor and its variant-1", () => {
  it("[MUST-FAIL] both are registered: the control and development-vessel:check-region-cause-anchor-v1, variant_of the base", () => {
    const base = byId("development-vessel:check-region-cause-anchor");
    const v1 = byId("development-vessel:check-region-cause-anchor-v1");
    expect(base).toBeDefined();
    expect(v1).toBeDefined();
    expect(v1!.variant_of).toBe("development-vessel:check-region-cause-anchor");
    expect(base!.variant_of).toBeUndefined();
  });
  it("[MUST-FAIL] both carry the traced shape signature (substrateGap -> checkRegionAnchor), one deterministic task, the consumer grade, and seed_version >= 1", () => {
    for (const id of ["development-vessel:check-region-cause-anchor", "development-vessel:check-region-cause-anchor-v1"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t!.inputShapes).toEqual(["substrateGap"]);
      expect(t!.outputShapes).toEqual(["checkRegionAnchor"]);
      expect(t!.tasks).toHaveLength(1);
      expect(t!.tasks[0]!.resolver).toBe("deterministic");
      expect(t!.tasks[0]!.outputShapes).toEqual(["checkRegionAnchor"]);
      expect(t!.metadata?.["reach_decided_by"]).toBe("consumer");
      expect(Number(t!.metadata?.["seed_version"] ?? 0)).toBeGreaterThanOrEqual(1);
    }
    expect(byId("development-vessel:check-region-cause-anchor")!.metadata?.["variant_role"]).toBe("control");
    expect(byId("development-vessel:check-region-cause-anchor-v1")!.metadata?.["variant_role"]).toBe("treatment");
  });
  it("[CONTROL] the catalogue's ids stay unique", () => {
    const ids = SEED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
