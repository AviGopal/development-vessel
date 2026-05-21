import { describe, it, expect } from "bun:test";
import { SEED_TEMPLATES } from "../src/seed/index.js";
import { DISCOVERY_SHAPES } from "../src/config.js";

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
        expect(DISCOVERY_SHAPES).toContain(task.resolver);
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
