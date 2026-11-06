/**
 * test-writing-arm-parity seed templates — which inputs the test-writing verify's arm precheck judges a drafted check by, as an
 * activity with a variant (src/resolvers/feature-compose.ts testWritingArmPrecheck / armParityDecision). The catalogue must carry both,
 * the variant linked to its base by variant_of, both with seed_version >= 1, the shape signature the decision traces
 * carry (test_suite -> testWritingArmParity), and the consumer grade. Read from SEED_TEMPLATES by id.
 */
import { describe, expect, it } from "bun:test";
import { SEED_TEMPLATES } from "../../src/seed/index.js";

const byId = (id: string) => SEED_TEMPLATES.find((t) => t.id === id) as (typeof SEED_TEMPLATES)[number] & { variant_of?: string; metadata?: Record<string, unknown> } | undefined;

describe("template contract — development-vessel:test-writing-arm-parity and its variant-1", () => {
  it("[MUST-FAIL] both are registered: the control and development-vessel:test-writing-arm-parity-v1, variant_of the base", () => {
    const base = byId("development-vessel:test-writing-arm-parity");
    const v1 = byId("development-vessel:test-writing-arm-parity-v1");
    expect(base).toBeDefined();
    expect(v1).toBeDefined();
    expect(v1!.variant_of).toBe("development-vessel:test-writing-arm-parity");
    expect(base!.variant_of).toBeUndefined();
  });
  it("[MUST-FAIL] both carry the traced shape signature (test_suite -> testWritingArmParity), one deterministic task, the consumer grade, and seed_version >= 1", () => {
    for (const id of ["development-vessel:test-writing-arm-parity", "development-vessel:test-writing-arm-parity-v1"]) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t!.inputShapes).toEqual(["test_suite"]);
      expect(t!.outputShapes).toEqual(["testWritingArmParity"]);
      expect(t!.tasks).toHaveLength(1);
      expect(t!.tasks[0]!.resolver).toBe("deterministic");
      expect(t!.tasks[0]!.outputShapes).toEqual(["testWritingArmParity"]);
      expect(t!.metadata?.["reach_decided_by"]).toBe("consumer");
      expect(Number(t!.metadata?.["seed_version"] ?? 0)).toBeGreaterThanOrEqual(1);
    }
    expect(byId("development-vessel:test-writing-arm-parity")!.metadata?.["variant_role"]).toBe("control");
    expect(byId("development-vessel:test-writing-arm-parity-v1")!.metadata?.["variant_role"]).toBe("treatment");
  });
  it("[CONTROL] the catalogue's ids stay unique", () => {
    const ids = SEED_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
