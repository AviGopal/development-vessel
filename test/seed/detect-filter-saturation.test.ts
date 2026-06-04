import { describe, it, expect } from "bun:test";
import { DETECT_FILTER_SATURATION_TEMPLATE } from "../../src/seed/detect-filter-saturation.js";

const ALLOWED_RESOLVERS = new Set([
  "fs_read",
  "fs_write",
  "http_fetch",
  "json_path_extract",
  "llm_completion_dispatch",
  "bash",
]);

describe("DETECT_FILTER_SATURATION_TEMPLATE", () => {
  it("has the required top-level fields and canonical id", () => {
    expect(DETECT_FILTER_SATURATION_TEMPLATE.id).toBe(
      "development-vessel:detect-filter-saturation",
    );
    expect(DETECT_FILTER_SATURATION_TEMPLATE.name).toBe(
      "detect-filter-saturation",
    );
    expect(
      (DETECT_FILTER_SATURATION_TEMPLATE.description as string).length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("cites substrate anchor concept_-rQijiezhmMZ in description", () => {
    expect(DETECT_FILTER_SATURATION_TEMPLATE.description).toContain(
      "concept_-rQijiezhmMZ",
    );
  });

  it("declares mechanismHealthFinding as an output shape", () => {
    expect(DETECT_FILTER_SATURATION_TEMPLATE.outputShapes).toContain(
      "mechanismHealthFinding",
    );
  });

  it("declares the 7 expected variables", () => {
    const names = (DETECT_FILTER_SATURATION_TEMPLATE.variables ?? []).map(
      (v) => v.name,
    );
    for (const expected of [
      "positive_event_pattern",
      "negative_event_pattern",
      "log_unit_name",
      "time_window_minutes",
      "saturation_threshold",
      "min_volume",
      "mechanism_concept_id",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("uses only the permitted deterministic resolver allowlist", () => {
    for (const t of DETECT_FILTER_SATURATION_TEMPLATE.tasks) {
      expect(ALLOWED_RESOLVERS.has(t.resolver)).toBe(true);
    }
    const resolvers = DETECT_FILTER_SATURATION_TEMPLATE.tasks.map(
      (t) => t.resolver,
    );
    expect(resolvers).not.toContain("llm_completion_dispatch");
    expect(resolvers).not.toContain("llm");
  });

  it("uses bash + journalctl + grep to count positive/negative events over the window", () => {
    const pos = DETECT_FILTER_SATURATION_TEMPLATE.tasks.find(
      (t) => t.id === "count_positive_events",
    )!;
    expect(pos.resolver).toBe("bash");
    const posBody = JSON.stringify(pos.config);
    expect(posBody).toContain("journalctl");
    expect(posBody).toContain("{{log_unit_name}}");
    expect(posBody).toContain("{{time_window_minutes}}");
    expect(posBody).toContain("{{positive_event_pattern}}");
    const neg = DETECT_FILTER_SATURATION_TEMPLATE.tasks.find(
      (t) => t.id === "count_negative_events",
    )!;
    expect(neg.resolver).toBe("bash");
    expect(JSON.stringify(neg.config)).toContain("{{negative_event_pattern}}");
  });

  it("ends with a concept_create_write http_fetch to concept-db on port 8260", () => {
    const last =
      DETECT_FILTER_SATURATION_TEMPLATE.tasks[
        DETECT_FILTER_SATURATION_TEMPLATE.tasks.length - 1
      ]!;
    expect(last.resolver).toBe("http_fetch");
    const body = JSON.stringify(last.config);
    expect(body).toContain("concept_create_write");
    expect(body).toContain("127.0.0.1:8260");
  });

  it("every task description is >= 40 chars (comprehensibility rule 2)", () => {
    for (const t of DETECT_FILTER_SATURATION_TEMPLATE.tasks) {
      expect(t.description.length).toBeGreaterThanOrEqual(40);
    }
  });

  it("every task has a config.type that matches its resolver", () => {
    for (const t of DETECT_FILTER_SATURATION_TEMPLATE.tasks) {
      const cfg = t.config as { type?: string };
      expect(cfg.type).toBe(t.resolver);
    }
  });
});
