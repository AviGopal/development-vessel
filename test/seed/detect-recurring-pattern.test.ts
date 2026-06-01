import { describe, it, expect } from "bun:test";
import { DETECT_RECURRING_PATTERN_TEMPLATE } from "../../src/seed/detect-recurring-pattern.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";

describe("DETECT_RECURRING_PATTERN_TEMPLATE", () => {
  it("declares the Phase 3 closed-loop identity + shape contract", () => {
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.id).toBe(
      "development-vessel:detect-recurring-pattern",
    );
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.name).toBe("detect-recurring-pattern");
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.inputShapes).toContain("obsidianEpisode");
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.outputShapes).toContain(
      "recurringPatternCluster",
    );
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.tags).toContain("phase:3");
    expect(DETECT_RECURRING_PATTERN_TEMPLATE.tags).toContain("closed.loop.learning");
  });

  it("ships exactly the five tasks the spec calls for, in order", () => {
    const ids = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual([
      "read_recent_episodes",
      "compute_signature_frequencies",
      "select_recurring",
      "emit_recurring_pattern_cluster",
      "dispatch_drafter",
    ]);
  });

  it("every resolver is in the vessel's advertised shape contract (lint gate)", () => {
    for (const task of DETECT_RECURRING_PATTERN_TEMPLATE.tasks) {
      expect(DISCOVERY_SHAPES).toContain(task.resolver);
    }
  });

  it("compute_signature_frequencies threshold is parameterised via min_occurrences", () => {
    const task = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find(
      (t) => t.id === "compute_signature_frequencies",
    )!;
    const cfg = task.config as { prompt: string };
    expect(cfg.prompt).toContain("{{min_occurrences}}");
    // The spec default is 5; the variable description pins the default.
    const v = DETECT_RECURRING_PATTERN_TEMPLATE.variables!.find(
      (x) => x.name === "min_occurrences",
    );
    expect(v).toBeDefined();
    expect(v!.description).toContain("5");
  });

  it("clusters lacking any contrast example are suppressed (prompt enforces it)", () => {
    const task = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find(
      (t) => t.id === "compute_signature_frequencies",
    )!;
    const cfg = task.config as { prompt: string };
    // The prompt MUST instruct that zero-contrast candidates collapse to an
    // empty cluster set. This is the spec scenario:
    //   "Cluster with insufficient contrast suppressed".
    expect(cfg.prompt).toContain("zero contrast_examples");
    expect(cfg.prompt).toContain('"clusters":[]');
  });

  it("deduplicates against /workspace/patterns/_dispatched.json", () => {
    const task = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find(
      (t) => t.id === "compute_signature_frequencies",
    )!;
    const cfg = task.config as { prompt: string };
    expect(cfg.prompt).toContain("_dispatched.json");
    // patterns_dir is the configurable root; the LLM prompt references it.
    const patternsVar = DETECT_RECURRING_PATTERN_TEMPLATE.variables!.find(
      (v) => v.name === "patterns_dir",
    );
    expect(patternsVar).toBeDefined();
  });

  it("dispatch_drafter targets the Phase 2 draft-activity-from-pattern", () => {
    const dispatch = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find(
      (t) => t.id === "dispatch_drafter",
    )!;
    const cfg = dispatch.config as { url: string; body: string };
    expect(cfg.url).toBe("http://127.0.0.1:8210/run-goal");
    expect(cfg.body).toContain("{{drafter_template_id}}");
    const drafterVar = DETECT_RECURRING_PATTERN_TEMPLATE.variables!.find(
      (v) => v.name === "drafter_template_id",
    );
    expect(drafterVar!.description).toContain("draft-activity-from-pattern");
  });

  it("emits a recurringPatternCluster as the final shape", () => {
    const emit = DETECT_RECURRING_PATTERN_TEMPLATE.tasks.find(
      (t) => t.id === "emit_recurring_pattern_cluster",
    )!;
    expect(emit.outputShapes).toContain("recurringPatternCluster");
  });
});
