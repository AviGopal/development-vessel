import { describe, it, expect } from "bun:test";
import { MECHANISM_HEALTH_TICK_TEMPLATE } from "../../src/seed/mechanism-health-tick.js";

const ALLOWED_RESOLVERS = new Set([
  "fs_read",
  "fs_write",
  "http_fetch",
  "json_path_extract",
  "llm_completion_dispatch",
  "bash",
]);

describe("MECHANISM_HEALTH_TICK_TEMPLATE", () => {
  it("has the required top-level fields and canonical id", () => {
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.id).toBe(
      "development-vessel:mechanism-health-tick",
    );
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.name).toBe("mechanism-health-tick");
    expect(
      (MECHANISM_HEALTH_TICK_TEMPLATE.description as string).length,
    ).toBeGreaterThanOrEqual(40);
  });

  it("cites substrate anchor concept_q2n0_XaSvphV in description", () => {
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.description).toContain(
      "concept_q2n0_XaSvphV",
    );
  });

  it("declares substrateHealthReport and mechanismHealthFinding as output shapes", () => {
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.outputShapes).toContain(
      "substrateHealthReport",
    );
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.outputShapes).toContain(
      "mechanismHealthFinding",
    );
  });

  it("uses only the permitted deterministic resolver allowlist", () => {
    for (const t of MECHANISM_HEALTH_TICK_TEMPLATE.tasks) {
      expect(ALLOWED_RESOLVERS.has(t.resolver)).toBe(true);
    }
  });

  it("dispatches each of M1/M2/M3/M4/M6 via http_fetch to goal-host-vessel /run-goal", () => {
    const expected = [
      ["dispatch_m1_feature_flag", "concept_vugylIHzIMvk"],
      ["dispatch_m2_filter_saturation", "concept_uTVZPoaxMmo2"],
      ["dispatch_m3_filter_saturation", "concept_YinkepAheImS"],
      ["dispatch_m4_classifier_skew", "concept_SDerP4GcuhGm"],
      ["dispatch_m6_classifier_skew", "concept_iae171XpW50_"],
    ];
    for (const [taskId, mechanismId] of expected as [string, string][]) {
      const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find(
        (x) => x.id === taskId,
      );
      expect(t).toBeDefined();
      expect(t!.resolver).toBe("http_fetch");
      const body = JSON.stringify(t!.config);
      expect(body).toContain("127.0.0.1:8210/run-goal");
      expect(body).toContain(mechanismId);
      expect(body).toContain("targetTemplateId");
    }
  });

  it("M1 dispatch targets detect-feature-flag-zero-exercise", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find(
      (x) => x.id === "dispatch_m1_feature_flag",
    )!;
    expect(JSON.stringify(t.config)).toContain(
      "development-vessel:detect-feature-flag-zero-exercise",
    );
  });

  it("M2 + M3 dispatches target detect-filter-saturation", () => {
    for (const id of [
      "dispatch_m2_filter_saturation",
      "dispatch_m3_filter_saturation",
    ]) {
      const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find((x) => x.id === id)!;
      expect(JSON.stringify(t.config)).toContain(
        "development-vessel:detect-filter-saturation",
      );
    }
  });

  it("M4 + M6 dispatches target detect-classifier-distribution-skew", () => {
    for (const id of [
      "dispatch_m4_classifier_skew",
      "dispatch_m6_classifier_skew",
    ]) {
      const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find((x) => x.id === id)!;
      expect(JSON.stringify(t.config)).toContain(
        "development-vessel:detect-classifier-distribution-skew",
      );
    }
  });

  it("emits a final rollup substrateHealthReport via concept_create_write to concept-db", () => {
    const last =
      MECHANISM_HEALTH_TICK_TEMPLATE.tasks[
        MECHANISM_HEALTH_TICK_TEMPLATE.tasks.length - 1
      ]!;
    expect(last.id).toBe("emit_rollup_report");
    expect(last.resolver).toBe("http_fetch");
    const body = JSON.stringify(last.config);
    expect(body).toContain("concept_create_write");
    expect(body).toContain("substrateHealthReport");
    expect(body).toContain("127.0.0.1:8260");
    // Cites all 5 mechanism concepts in the rollup content
    for (const m of [
      "concept_vugylIHzIMvk",
      "concept_uTVZPoaxMmo2",
      "concept_YinkepAheImS",
      "concept_SDerP4GcuhGm",
      "concept_iae171XpW50_",
    ]) {
      expect(body).toContain(m);
    }
  });

  it("carries authored_from_pattern + cited_concept_ids + composition_rationales (comprehensibility rules 3-5)", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE as unknown as Record<
      string,
      unknown
    >;
    expect(t.authored_from_pattern).toBeDefined();
    expect(t.cited_concept_ids).toBeDefined();
    expect(Array.isArray(t.cited_concept_ids)).toBe(true);
    expect((t.cited_concept_ids as string[]).length).toBeGreaterThanOrEqual(3);
    expect(t.composition_rationales).toBeDefined();
    expect(Array.isArray(t.composition_rationales)).toBe(true);
    // every dispatch_* task has a rationale entry
    const rationaleIds = new Set(
      (
        t.composition_rationales as Array<{ task_id: string }>
      ).map((r) => r.task_id),
    );
    for (const taskId of [
      "dispatch_m1_feature_flag",
      "dispatch_m2_filter_saturation",
      "dispatch_m3_filter_saturation",
      "dispatch_m4_classifier_skew",
      "dispatch_m6_classifier_skew",
    ]) {
      expect(rationaleIds.has(taskId)).toBe(true);
    }
  });

  it("every task description is >= 40 chars (comprehensibility rule 2)", () => {
    for (const t of MECHANISM_HEALTH_TICK_TEMPLATE.tasks) {
      expect(t.description.length).toBeGreaterThanOrEqual(40);
    }
  });

  it("has 9 tasks after adding the 3 substrate-self-gate rows", () => {
    expect(MECHANISM_HEALTH_TICK_TEMPLATE.tasks.length).toBe(9);
  });

  it("includes the three new self-gate task ids", () => {
    const ids = new Set(MECHANISM_HEALTH_TICK_TEMPLATE.tasks.map((t) => t.id));
    expect(ids.has("dispatch_self_gate_placeholder")).toBe(true);
    expect(ids.has("dispatch_self_gate_surrealdb_conflicts")).toBe(true);
    expect(ids.has("dispatch_self_gate_self_emission_rate")).toBe(true);
  });

  it("row 6 (placeholder) targets detect-filter-saturation with placeholder regex", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find(
      (x) => x.id === "dispatch_self_gate_placeholder",
    )!;
    expect(t.resolver).toBe("http_fetch");
    const body = JSON.stringify(t.config);
    expect(body).toContain("development-vessel:detect-filter-saturation");
    expect(body).toContain("concept-db.service");
    expect(body).toContain("Created concept");
    // The literal placeholder pattern (JSON-escaped backslashes)
    expect(body).toContain("_stdout");
    expect(body).toContain("mechanism-health-tick-self-gate");
  });

  it("row 7 (surrealdb conflicts) targets detect-filter-saturation with conflict regex", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find(
      (x) => x.id === "dispatch_self_gate_surrealdb_conflicts",
    )!;
    expect(t.resolver).toBe("http_fetch");
    const body = JSON.stringify(t.config);
    expect(body).toContain("development-vessel:detect-filter-saturation");
    expect(body).toContain("concept-db.service");
    expect(body).toContain("failed transaction");
    expect(body).toContain("read or write conflict");
    expect(body).toContain("mechanism-health-tick-self-gate");
  });

  it("row 8 (self-emission rate) targets detect-feature-flag-zero-exercise with mechanismHealthFinding SQL", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE.tasks.find(
      (x) => x.id === "dispatch_self_gate_self_emission_rate",
    )!;
    expect(t.resolver).toBe("http_fetch");
    const body = JSON.stringify(t.config);
    expect(body).toContain(
      "development-vessel:detect-feature-flag-zero-exercise",
    );
    expect(body).toContain("mechanismHealthFinding");
    expect(body).toContain("HOSTNAME");
    expect(body).toContain("mechanism-health-tick-self-gate");
  });

  it("each new self-gate task has a composition_rationales entry", () => {
    const t = MECHANISM_HEALTH_TICK_TEMPLATE as unknown as Record<
      string,
      unknown
    >;
    const rationaleIds = new Set(
      (
        t.composition_rationales as Array<{ task_id: string }>
      ).map((r) => r.task_id),
    );
    for (const id of [
      "dispatch_self_gate_placeholder",
      "dispatch_self_gate_surrealdb_conflicts",
      "dispatch_self_gate_self_emission_rate",
    ]) {
      expect(rationaleIds.has(id)).toBe(true);
    }
  });

  it("cited_concept_ids includes the 3 self-gate empirical anchors (totals >= 14)", () => {
    const ids = MECHANISM_HEALTH_TICK_TEMPLATE.cited_concept_ids as string[];
    expect(ids.length).toBeGreaterThanOrEqual(14);
    expect(ids).toContain("concept_4eNd7BFuAJK0");
    expect(ids).toContain("concept_D9GHCGYCt9T1");
    expect(ids).toContain("concept_Orn4yVaJYD24");
  });
});
