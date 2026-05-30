import { describe, it, expect } from "bun:test";
import { DETECT_STALE_POINTER_TEMPLATE } from "../../src/seed/detect-stale-pointer.js";

describe("DETECT_STALE_POINTER_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(DETECT_STALE_POINTER_TEMPLATE.id).toBe(
      "development-vessel:detect-stale-pointer",
    );
    expect(DETECT_STALE_POINTER_TEMPLATE.name).toBe("detect-stale-pointer");
    expect(typeof DETECT_STALE_POINTER_TEMPLATE.description).toBe("string");
  });

  it("declares stalePointerReport + substrateGap output shapes", () => {
    expect(DETECT_STALE_POINTER_TEMPLATE.outputShapes).toContain("stalePointerReport");
    expect(DETECT_STALE_POINTER_TEMPLATE.outputShapes).toContain("substrateGap");
  });

  it("is a SINGLE-TASK template (collapses the prior multi-step pipeline)", () => {
    const ids = DETECT_STALE_POINTER_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual(["scan_and_emit"]);
  });

  it("uses the deterministic stale_pointer_emit resolver — NOT an LLM", () => {
    const t = DETECT_STALE_POINTER_TEMPLATE.tasks[0]!;
    expect(t.resolver).toBe("stale_pointer_emit");
    const config = t.config as { type: string; dry_run: boolean; maxEmits: number };
    expect(config.type).toBe("stale_pointer_emit");
    expect(config.dry_run).toBe(false);
    expect(typeof config.maxEmits).toBe("number");
  });

  it("does NOT use llm_completion_dispatch anywhere (overflow root cause removed)", () => {
    const resolvers = DETECT_STALE_POINTER_TEMPLATE.tasks.map((t) => t.resolver);
    expect(resolvers).not.toContain("llm_completion_dispatch");
    // Also assert no nested LLM body inside any iteration task.
    for (const t of DETECT_STALE_POINTER_TEMPLATE.tasks) {
      const cfg = t.config as { body?: { resolver?: string } };
      if (cfg.body && typeof cfg.body.resolver === "string") {
        expect(cfg.body.resolver).not.toBe("llm_completion_dispatch");
      }
    }
  });

  it("carries the substrate.knowledge.curation tag family", () => {
    const tags = DETECT_STALE_POINTER_TEMPLATE.tags ?? [];
    expect(tags).toContain("concept.management");
    expect(tags).toContain("substrate.knowledge.curation");
  });
});
