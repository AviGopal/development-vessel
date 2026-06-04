import { describe, it, expect } from "bun:test";
import { DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE } from "../../src/seed/detect-feature-flag-zero-exercise.js";

const ALLOWED_RESOLVERS = new Set([
  "fs_read",
  "fs_write",
  "http_fetch",
  "json_path_extract",
  "llm_completion_dispatch",
  "bash",
]);

describe("DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE", () => {
  it("has the required top-level fields and canonical id", () => {
    expect(DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.id).toBe(
      "development-vessel:detect-feature-flag-zero-exercise",
    );
    expect(DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.name).toBe(
      "detect-feature-flag-zero-exercise",
    );
    expect(
      (DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.description as string).length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("cites substrate anchor concept_7_yVEeVfMKQV in description", () => {
    expect(DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.description).toContain(
      "concept_7_yVEeVfMKQV",
    );
  });

  it("declares mechanismHealthFinding as an output shape", () => {
    expect(DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.outputShapes).toContain(
      "mechanismHealthFinding",
    );
  });

  it("declares the 4 expected variables", () => {
    const names = (
      DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.variables ?? []
    ).map((v) => v.name);
    for (const expected of [
      "flag_env_var",
      "observable_sql",
      "expected_nonzero_threshold",
      "mechanism_concept_id",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("uses only the permitted deterministic resolver allowlist", () => {
    for (const t of DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks) {
      expect(ALLOWED_RESOLVERS.has(t.resolver)).toBe(true);
    }
    const resolvers = DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks.map(
      (t) => t.resolver,
    );
    expect(resolvers).not.toContain("llm_completion_dispatch");
    expect(resolvers).not.toContain("llm");
  });

  it("has a config object on every task whose type matches the resolver", () => {
    for (const t of DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks) {
      const cfg = t.config as { type?: string };
      expect(cfg).toBeDefined();
      expect(cfg.type).toBe(t.resolver);
    }
  });

  it("reads the flag via printenv and queries SurrealDB SQL endpoint at localhost:8000/sql", () => {
    const tasks = DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks;
    const readFlag = tasks.find((t) => t.id === "read_flag")!;
    expect(readFlag.resolver).toBe("bash");
    expect(JSON.stringify(readFlag.config)).toContain("printenv");
    expect(JSON.stringify(readFlag.config)).toContain("{{flag_env_var}}");
    const queryObs = tasks.find((t) => t.id === "query_observable")!;
    const body = JSON.stringify(queryObs.config);
    expect(body).toContain("localhost:8000/sql");
    expect(body).toContain("surreal-ns");
    expect(body).toContain("surreal-db");
  });

  it("ends with a concept_create_write http_fetch to concept-db on port 8260", () => {
    const last =
      DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks[
        DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks.length - 1
      ]!;
    expect(last.resolver).toBe("http_fetch");
    const body = JSON.stringify(last.config);
    expect(body).toContain("concept_create_write");
    expect(body).toContain("127.0.0.1:8260");
  });

  it("every task description is >= 40 chars (comprehensibility rule 2)", () => {
    for (const t of DETECT_FEATURE_FLAG_ZERO_EXERCISE_TEMPLATE.tasks) {
      expect(t.description.length).toBeGreaterThanOrEqual(40);
    }
  });
});
