import { describe, it, expect } from "bun:test";
import { PREDICT_AND_VERIFY_TEMPLATE } from "../../src/seed/predict-and-verify.js";
import { DISCOVERY_SHAPES } from "../../src/config.js";

describe("PREDICT_AND_VERIFY_TEMPLATE", () => {
  it("declares the Phase 3 verifier identity + shape contract", () => {
    expect(PREDICT_AND_VERIFY_TEMPLATE.id).toBe("development-vessel:predict-and-verify");
    expect(PREDICT_AND_VERIFY_TEMPLATE.inputShapes).toContain("authoredActivityCandidate");
    expect(PREDICT_AND_VERIFY_TEMPLATE.inputShapes).toContain("obsidianEpisode");
    expect(PREDICT_AND_VERIFY_TEMPLATE.outputShapes).toContain("verifierResult");
    expect(PREDICT_AND_VERIFY_TEMPLATE.outputShapes).toContain("predictionDisagreement");
    expect(PREDICT_AND_VERIFY_TEMPLATE.tags).toContain("verifier.routing");
  });

  it("ships exactly the six-task verifier pipeline plus the write_outcome step", () => {
    const ids = PREDICT_AND_VERIFY_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual([
      "fetch_authored_candidate",
      "classify_activity_type",
      "route_verifier",
      "verifier_action",
      "verifier_interpretation",
      "verifier_prediction",
      "write_outcome",
    ]);
  });

  it("every resolver is in the vessel's advertised shape contract", () => {
    for (const task of PREDICT_AND_VERIFY_TEMPLATE.tasks) {
      expect(DISCOVERY_SHAPES).toContain(task.resolver);
    }
  });

  it("classifier emits one of action / interpretation / prediction with multi-label support", () => {
    const cls = PREDICT_AND_VERIFY_TEMPLATE.tasks.find(
      (t) => t.id === "classify_activity_type",
    )!;
    const cfg = cls.config as { prompt: string };
    expect(cfg.prompt).toContain("assistanceAction");
    expect(cfg.prompt).toContain("intentLabel");
    expect(cfg.prompt).toContain("trajectoryPrediction");
    expect(cfg.prompt).toContain("'action'");
    expect(cfg.prompt).toContain("'interpretation'");
    expect(cfg.prompt).toContain("'prediction'");
    // Multi-label support: the prompt MUST tell the classifier to include
    // every applicable label so AND-conjunction can be enforced.
    expect(cfg.prompt.toLowerCase()).toContain("and-conjunction");
  });

  it("verifier_action emits prediction_disagreement.action_no_effect on miss", () => {
    const task = PREDICT_AND_VERIFY_TEMPLATE.tasks.find(
      (t) => t.id === "verifier_action",
    )!;
    const cfg = task.config as { prompt: string };
    expect(cfg.prompt).toContain("action_no_effect");
    expect(cfg.prompt).toContain("prediction_disagreement");
    expect(cfg.prompt).toContain("pre_signature");
    expect(cfg.prompt).toContain("post_signature");
  });

  it("verifier_interpretation emits prediction_disagreement.intent_inconsistency on miss", () => {
    const task = PREDICT_AND_VERIFY_TEMPLATE.tasks.find(
      (t) => t.id === "verifier_interpretation",
    )!;
    const cfg = task.config as { prompt: string };
    expect(cfg.prompt).toContain("intent_inconsistency");
    expect(cfg.prompt).toContain("consistency_set");
    expect(cfg.prompt).toContain("observed_continuation_signature");
  });

  it("verifier_prediction emits prediction_disagreement.trajectory_divergence on miss", () => {
    const task = PREDICT_AND_VERIFY_TEMPLATE.tasks.find(
      (t) => t.id === "verifier_prediction",
    )!;
    const cfg = task.config as { prompt: string };
    expect(cfg.prompt).toContain("trajectory_divergence");
    expect(cfg.prompt).toContain("divergence_index");
    expect(cfg.prompt).toContain("predicted_signatures");
  });

  it("each verifier honours routing — skips when its label is not in route_verifier_text", () => {
    const verifiers = ["verifier_action", "verifier_interpretation", "verifier_prediction"];
    for (const id of verifiers) {
      const task = PREDICT_AND_VERIFY_TEMPLATE.tasks.find((t) => t.id === id)!;
      const cfg = task.config as { prompt: string };
      // Routing types reference must be present so the LLM short-circuits
      // when its specific label is absent from the multi-label routing array.
      expect(cfg.prompt).toContain("{{route_verifier_text}}");
      expect(cfg.prompt.toLowerCase()).toContain("skipped");
    }
  });

  it("write_outcome POSTs the AND-conjunction verdict to activity-api", () => {
    const write = PREDICT_AND_VERIFY_TEMPLATE.tasks.find((t) => t.id === "write_outcome")!;
    const cfg = write.config as { url: string; method: string; body: string };
    expect(cfg.method).toBe("POST");
    expect(cfg.url).toContain("/v2/activities/execution-traces");
    // Every applicable verifier's result is folded in.
    expect(cfg.body).toContain("verifier_action");
    expect(cfg.body).toContain("verifier_interpretation");
    expect(cfg.body).toContain("verifier_prediction");
  });
});
