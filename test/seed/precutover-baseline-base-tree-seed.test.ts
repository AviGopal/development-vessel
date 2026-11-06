/**
 * precutover-baseline-base-tree seed templates — the pre-cutover gate's choice of baseline when the vessel has none usable,
 * as an activity with a variant (src/resolvers/vessel-mitosis-cutover.ts precutoverBaselineBaseTreeDecision). The catalogue must carry both, the variant
 * linked to its base by variant_of (a standalone variant is a second, uninformed cell), both with seed_version >= 1
 * (else a populated catalogue never receives them), the shape signature the decision traces carry
 * (test_suite -> precutoverBaseline), and the consumer grade. Read from SEED_TEMPLATES by id, so a missing template
 * fails on its absence.
 */
import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "../../src/seed/index.js";

const byId = (id: string) => SEED_TEMPLATES.find((t) => t.id === id) as (typeof SEED_TEMPLATES)[number] & { variant_of?: string; metadata?: Record<string, unknown> } | undefined;

describe("template contract — development-vessel:precutover-baseline-base-tree and its variant-1", () => {
  it("[MUST-FAIL] both are registered: the control and development-vessel:precutover-baseline-base-tree-v1, variant_of the base", () => {
    const base = byId("development-vessel:precutover-baseline-base-tree");
    const v1 = byId("development-vessel:precutover-baseline-base-tree-v1");
    expect(base).toBeDefined();
    expect(v1).toBeDefined();
    expect(v1!.variant_of).toBe("development-vessel:precutover-baseline-base-tree");
    expect(base!.variant_of).toBeUndefined();
  });
  it("[MUST-FAIL] both carry the traced shape signature (test_suite -> precutoverBaseline), one deterministic task, the consumer grade, and seed_version >= 1", () => {
    for (const id of ["development-vessel:precutover-baseline-base-tree", "development-vessel:precutover-baseline-base-tree-v1"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t!.inputShapes).toEqual(["test_suite"]);
      expect(t!.outputShapes).toEqual(["precutoverBaseline"]);
      expect(t!.tasks).toHaveLength(1);
      expect(t!.tasks[0]!.resolver).toBe("deterministic");
      expect(t!.tasks[0]!.outputShapes).toEqual(["precutoverBaseline"]);
      expect(t!.metadata?.["reach_decided_by"]).toBe("consumer");
      expect(Number(t!.metadata?.["seed_version"] ?? 0)).toBeGreaterThanOrEqual(1);
    }
    expect(byId("development-vessel:precutover-baseline-base-tree")!.metadata?.["variant_role"]).toBe("control");
    expect(byId("development-vessel:precutover-baseline-base-tree-v1")!.metadata?.["variant_role"]).toBe("treatment");
  });
  it("[CONTROL] the catalogue's ids stay unique", () => {
    const ids = SEED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
