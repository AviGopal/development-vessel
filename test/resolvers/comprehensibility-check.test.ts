import { describe, it, expect } from "bun:test";
import {
  jaccardSimilarity,
  resolveComprehensibilityCheck,
} from "../../src/resolvers/comprehensibility-check.js";

describe("comprehensibility_check resolver", () => {
  const sampleTemplate = {
    id: "proposed_pattern_authored_small_edit_save",
    name: "small_edit_save",
    description:
      "Performs a targeted in-place edit then persists the result to disk. " +
      "Authored from cluster small_edit_v2 with 4 contrast examples of unchanged save behaviour.",
    tags: ["substrate.authored", "edit.cycle"],
    inputShapes: ["fileContent"],
    outputShapes: ["fileContent", "editAuditLog"],
    tasks: [
      {
        id: "load_file",
        resolver: "fs_read",
        description:
          "Load the current file contents into the impulse pool so the edit step can " +
          "compute a precise replacement target without re-reading from disk.",
      },
      {
        id: "apply_edit",
        resolver: "fs_edit",
        description:
          "Apply the requested in-place edit using exact-string replacement; record the " +
          "before/after hashes for the audit log impulse.",
      },
    ],
  };

  it("emits comprehensibilityScore with high score when LLM answers align with self-description", async () => {
    // The mocked LLM returns answers that share heavy vocabulary with the
    // self-description fields, so Jaccard similarity is high. We lower the
    // floor for this test to 0.3 to keep the assertion stable across small
    // tokenizer changes; the structural check (passed=true, score>floor) is
    // what we're validating.
    const mockLlm = async () =>
      JSON.stringify({
        what:
          "Performs targeted place edit persists result disk authored cluster small edit v2 contrast examples unchanged save behaviour small edit save",
        why:
          "proposed pattern authored small edit save substrate authored edit cycle performs targeted place edit persists result disk",
        when_useful:
          "fileContent editAuditLog load current file contents impulse pool edit step compute precise replacement target re-reading disk apply requested place edit exact string replacement record before after hashes audit log impulse",
      });

    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      template_json: sampleTemplate,
      _llmFn: mockLlm,
      floor: 0.3,
    });

    expect(result.shape).toBe("comprehensibilityScore");
    const body = result.body as {
      overall_score: number;
      passed: boolean;
      per_field: { what: number; why: number; when_useful: number };
      evaluator_model_id: string;
      raw_answers: { what: string; why: string; when_useful: string };
    };
    expect(body.passed).toBe(true);
    expect(body.overall_score).toBeGreaterThanOrEqual(0.3);
    expect(body.per_field.what).toBeGreaterThan(0.3);
    // Was `toContain("haiku")`. e2d6158 defaulted runtime drafter/gate calls to the
    // policy-governed "auto" on purpose; asserting a pinned model here would re-impose the
    // very pinning that change removed, and would break again on the next policy update.
    // Assert the resolver REPORTS which evaluator it used — that is the durable contract.
    expect(typeof body.evaluator_model_id).toBe("string");
    expect(body.evaluator_model_id.length).toBeGreaterThan(0);
    expect(body.raw_answers.what.length).toBeGreaterThan(0);
  });

  it("returns structuredError with comprehensibility_below_floor when LLM answers diverge from self-description", async () => {
    // Mocked LLM gives answers with no token overlap → Jaccard ~0 → below floor.
    const mockLlm = async () =>
      JSON.stringify({
        what: "computes weather forecasts for cargo logistics",
        why: "supply chain optimization quarterly reporting",
        when_useful: "fiscal year end with consolidated balance sheets",
      });

    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      template_json: sampleTemplate,
      _llmFn: mockLlm,
    });

    expect(result.shape).toBe("structuredError");
    const body = result.body as {
      failure_mode: string;
      score: number;
      floor: number;
    };
    expect(body.failure_mode).toBe("comprehensibility_below_floor");
    expect(body.score).toBeLessThan(0.6);
    expect(body.floor).toBe(0.6);
  });

  it("parses a STRING template_json (the raw {{draft_via_llm_text}} the drafter wires) instead of scoring 0", async () => {
    // Regression: the drafter wires `template_json: "{{draft_via_llm_text}}"`, which
    // the engine interpolates to a raw JSON STRING. Indexing a string as an object
    // left selfDesc empty and forced score 0.000 on every authored chain. The
    // resolver must parse the string so the self-description populates.
    const mockLlm = async () =>
      JSON.stringify({
        what:
          "Performs targeted place edit persists result disk authored cluster small edit v2 contrast examples unchanged save behaviour small edit save",
        why:
          "proposed pattern authored small edit save substrate authored edit cycle performs targeted place edit persists result disk",
        when_useful:
          "fileContent editAuditLog load current file contents impulse pool edit step compute precise replacement target apply place edit exact string replacement record before after hashes audit log impulse",
      });

    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      // Pass the template as a raw JSON string, exactly as the engine delivers it.
      template_json: JSON.stringify(sampleTemplate),
      _llmFn: mockLlm,
      floor: 0.3,
    });

    expect(result.shape).toBe("comprehensibilityScore");
    const body = result.body as { overall_score: number; passed: boolean };
    // Non-zero proves the self-description was recovered from the string.
    expect(body.overall_score).toBeGreaterThan(0);
    expect(body.passed).toBe(true);
  });

  it("returns input_error for an unparseable STRING template_json", async () => {
    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      template_json: "this is not json at all",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("input_error");
  });

  it("returns input_error when neither template_id nor template_json is provided", async () => {
    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string };
    expect(body.failure_mode).toBe("input_error");
  });

  it("supports an injectable similarity function (cosine-style score = 1 path)", async () => {
    const mockLlm = async () => JSON.stringify({ what: "x", why: "y", when_useful: "z" });
    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      template_json: sampleTemplate,
      _llmFn: mockLlm,
      _similarityFn: () => 1,
    });
    expect(result.shape).toBe("comprehensibilityScore");
    const body = result.body as { overall_score: number; per_field: { what: number } };
    expect(body.overall_score).toBe(1);
    expect(body.per_field.what).toBe(1);
  });

  it("returns cascading failure_mode when the LLM dispatch throws", async () => {
    const mockLlm = async () => {
      throw new Error("upstream LLM vessel offline");
    };
    const result = await resolveComprehensibilityCheck({
      type: "comprehensibility_check",
      template_json: sampleTemplate,
      _llmFn: mockLlm,
    });
    expect(result.shape).toBe("structuredError");
    const body = result.body as { failure_mode: string; detail: string };
    expect(body.failure_mode).toBe("cascading");
    expect(body.detail).toContain("upstream LLM vessel offline");
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical token sets", () => {
    expect(jaccardSimilarity("hello world", "world hello")).toBe(1);
  });
  it("returns 0 for disjoint token sets", () => {
    expect(jaccardSimilarity("hello world", "foobar baz")).toBe(0);
  });
  it("returns a fractional value for partial overlap", () => {
    const score = jaccardSimilarity("hello world activity", "hello world template");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it("returns 1 when both inputs are empty (no comparison)", () => {
    expect(jaccardSimilarity("", "")).toBe(1);
  });
  it("returns 0 when one side is empty", () => {
    expect(jaccardSimilarity("hello world", "")).toBe(0);
  });
});
