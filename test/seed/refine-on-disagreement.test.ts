import { describe, it, expect } from "bun:test";
import { REFINE_ON_DISAGREEMENT_TEMPLATE } from "../../src/seed/refine-on-disagreement.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";

describe("REFINE_ON_DISAGREEMENT_TEMPLATE", () => {
  it("declares the Phase 3 refiner identity + shape contract", () => {
    expect(REFINE_ON_DISAGREEMENT_TEMPLATE.id).toBe(
      "development-vessel:refine-on-disagreement",
    );
    expect(REFINE_ON_DISAGREEMENT_TEMPLATE.inputShapes).toContain("predictionDisagreement");
    expect(REFINE_ON_DISAGREEMENT_TEMPLATE.inputShapes).toContain("recurringPatternCluster");
    expect(REFINE_ON_DISAGREEMENT_TEMPLATE.outputShapes).toContain(
      "authoredActivityCandidate",
    );
    expect(REFINE_ON_DISAGREEMENT_TEMPLATE.tags).toContain("refinement");
  });

  it("ships the seven-task refinement pipeline in spec order", () => {
    const ids = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual([
      "fetch_disagreement_trace",
      "fetch_authored_metadata",
      "fetch_passing_traces",
      "read_dispatched_map",
      "build_contrast_pair",
      "write_dispatched_record",
      "dispatch_drafter",
    ]);
  });

  it("every resolver is in the vessel's advertised shape contract", () => {
    for (const task of REFINE_ON_DISAGREEMENT_TEMPLATE.tasks) {
      expect(DISCOVERY_SHAPES).toContain(task.resolver);
    }
  });

  it("contrast pair builder pulls passing traces alongside the failing trace", () => {
    const passing = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "fetch_passing_traces",
    )!;
    const cfg = passing.config as { url: string };
    expect(cfg.url).toContain("success_only=true");
    expect(cfg.url).toContain("{{failed_activity_id}}");

    const build = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "build_contrast_pair",
    )!;
    const buildCfg = build.config as { prompt: string };
    expect(buildCfg.prompt).toContain("passing_traces");
    expect(buildCfg.prompt).toContain("failing_trace");
    expect(buildCfg.prompt).toContain("contrast_pair");
  });

  it("enforces 3-per-24h backoff per (pattern_id, sub_type)", () => {
    const build = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "build_contrast_pair",
    )!;
    const cfg = build.config as { prompt: string };
    // The backoff key is "<pattern_id>::<sub_type>"; the prompt MUST tell the
    // LLM to emit skipped:true when 3 or more dispatches exist in the last 24h.
    expect(cfg.prompt).toContain("<pattern_id>::<sub_type>");
    expect(cfg.prompt).toContain("count >= 3");
    expect(cfg.prompt).toContain('"skipped":true');
    expect(cfg.prompt).toContain('"reason":"backoff"');
    // The dispatch map sits next to /workspace/refinement.
    const refDir = REFINE_ON_DISAGREEMENT_TEMPLATE.variables!.find(
      (v) => v.name === "refinement_dir",
    );
    expect(refDir).toBeDefined();
    expect(refDir!.description).toContain("backoff");
  });

  it("read_dispatched_map is best-effort and feeds the build step", () => {
    const read = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "read_dispatched_map",
    )!;
    const cfg = read.config as { path: string };
    expect(cfg.path).toContain("_dispatched.json");
    expect(cfg.path).toContain("{{refinement_dir}}");
    expect(read.description).toContain("Best-effort");
  });

  it("dispatch_drafter targets draft-activity-from-pattern with parent_execution_id", () => {
    const dispatch = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "dispatch_drafter",
    )!;
    const cfg = dispatch.config as { url: string; body: string };
    expect(cfg.url).toBe("http://127.0.0.1:8210/run-goal");
    // The dispatched goal carries parent_execution_id so the refined candidate
    // inherits chain-credit via propagateCreditAlongChain on the activity-api side.
    expect(cfg.body).toContain("parent_execution_id");
    expect(cfg.body).toContain("{{disagreement_execution_id}}");
    expect(cfg.body).toContain("{{drafter_template_id}}");
    const drafterVar = REFINE_ON_DISAGREEMENT_TEMPLATE.variables!.find(
      (v) => v.name === "drafter_template_id",
    );
    expect(drafterVar!.description).toContain("draft-activity-from-pattern");
  });

  it("emits the refined authoredActivityCandidate as the final shape", () => {
    const dispatch = REFINE_ON_DISAGREEMENT_TEMPLATE.tasks.find(
      (t) => t.id === "dispatch_drafter",
    )!;
    expect(dispatch.outputShapes).toContain("authoredActivityCandidate");
  });
});
