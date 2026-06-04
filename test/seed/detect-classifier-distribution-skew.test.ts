import { describe, it, expect } from "bun:test";
import { DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE } from "../../src/seed/detect-classifier-distribution-skew.js";

const ALLOWED_RESOLVERS = new Set([
  "fs_read",
  "fs_write",
  "http_fetch",
  "json_path_extract",
  "llm_completion_dispatch",
  "bash",
]);

describe("DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE", () => {
  it("has the required top-level fields and canonical id", () => {
    expect(DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.id).toBe(
      "development-vessel:detect-classifier-distribution-skew",
    );
    expect(DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.name).toBe(
      "detect-classifier-distribution-skew",
    );
    expect(typeof DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.description).toBe(
      "string",
    );
    expect(
      (DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.description as string).length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("cites substrate anchor concept_9L8PB5tQzc7l in description", () => {
    expect(DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.description).toContain(
      "concept_9L8PB5tQzc7l",
    );
  });

  it("declares mechanismHealthFinding as an output shape", () => {
    expect(DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.outputShapes).toContain(
      "mechanismHealthFinding",
    );
  });

  it("declares the 5 expected variables", () => {
    const names = (
      DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.variables ?? []
    ).map((v) => v.name);
    for (const expected of [
      "endpoint_path",
      "payload_json_template",
      "jsonpath_to_class_field",
      "threshold_fraction",
      "mechanism_concept_id",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("uses only the permitted deterministic resolver allowlist (no llm tier)", () => {
    for (const t of DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.tasks) {
      expect(ALLOWED_RESOLVERS.has(t.resolver)).toBe(true);
    }
    const resolvers = DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.tasks.map(
      (t) => t.resolver,
    );
    expect(resolvers).not.toContain("llm_completion_dispatch");
    expect(resolvers).not.toContain("llm");
  });

  it("has a config object on every task whose type matches the resolver", () => {
    for (const t of DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.tasks) {
      const cfg = t.config as { type?: string };
      expect(cfg).toBeDefined();
      expect(typeof cfg.type).toBe("string");
      expect(cfg.type).toBe(t.resolver);
    }
  });

  it("first task probes endpoint_path via http_fetch and the last emits concept_create_write to concept-db", () => {
    const tasks = DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.tasks;
    expect(tasks[0]!.resolver).toBe("http_fetch");
    expect(JSON.stringify(tasks[0]!.config)).toContain("{{endpoint_path}}");
    const last = tasks[tasks.length - 1]!;
    expect(last.resolver).toBe("http_fetch");
    const body = JSON.stringify(last.config);
    expect(body).toContain("concept_create_write");
    expect(body).toContain("127.0.0.1:8260");
  });

  it("every task description is >= 40 chars (comprehensibility rule 2)", () => {
    for (const t of DETECT_CLASSIFIER_DISTRIBUTION_SKEW_TEMPLATE.tasks) {
      expect(t.description.length).toBeGreaterThanOrEqual(40);
    }
  });
});
