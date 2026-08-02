import { describe, it, expect } from "bun:test";
import { SEED_TEMPLATES } from "../src/seed/index.js";
import { DISCOVERY_SHAPES } from "../src/config.js";

// Seed templates may name a resolver either bare (`coverage_tick`) or VESSEL-QUALIFIED
// (`development-vessel:coverage_tick`) — the qualifier names the serving vessel, the shape
// is the part after it. DISCOVERY_SHAPES lists the shapes this vessel serves, unqualified.
// This test compared the raw string and so failed on every qualified task (17 cases), which
// mattered beyond hygiene: the mitosis landing gate runs `bun test` and, unlike the
// typecheck gate beside it, is not delta-aware — a red baseline refuses every staged patch.
//
// A few entries legitimately CONTAIN a colon (`obsidian:vessel_count`). So prefer an exact
// match and only fall back to the post-qualifier shape.
const shapeOf = (resolver: string): string =>
  DISCOVERY_SHAPES.includes(resolver) ? resolver : resolver.replace(/^[\w-]+vessel:/, "");

// A task may also name a resolver TIER (`llm`, `bash`, …) rather than a shape: the executor
// picks any registered resolver of that tier. Those are deliberately not discovery shapes,
// so asserting membership for them tests nothing real.
const RESOLVER_TIERS = ["llm", "bash", "deterministic", "pattern"];

describe("seed-templates dry-run", () => {
  it("SEED_TEMPLATES is non-empty", () => {
    expect(SEED_TEMPLATES.length).toBeGreaterThan(0);
  });

  for (const template of SEED_TEMPLATES) {
    it(`${template.id} has id, name, and at least one task`, () => {
      expect(typeof template.id).toBe("string");
      expect(template.id.length).toBeGreaterThan(0);
      expect(typeof template.name).toBe("string");
      expect(template.tasks.length).toBeGreaterThan(0);
    });

    it(`${template.id} — all resolvers are in DISCOVERY_SHAPES`, () => {
      for (const task of template.tasks) {
        if (RESOLVER_TIERS.includes(task.resolver)) continue;
        expect(DISCOVERY_SHAPES).toContain(shapeOf(task.resolver));
      }
    });

    it(`${template.id} — all task configs carry a matching type field`, () => {
      for (const task of template.tasks) {
        const config = task.config as Record<string, unknown> | undefined;
        if (config && "type" in config) {
          expect(config["type"]).toBe(task.resolver);
        }
      }
    });
  }
});
