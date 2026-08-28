import { describe, it, expect } from "bun:test";
import { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "../../src/seed/draft-gap-closing-activity.js";

describe("DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.id).toContain("draft-gap-closing-activity");
    expect(typeof DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.name).toBe("string");
    expect(typeof DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.description).toBe("string");
  });

  it("declares NO template-level inputShapes, and the two output shapes", () => {
    // inputShapes is deliberately empty: tasks 1-2 fs_read the report and scenario
    // from variable-supplied paths. Declaring failureModeReport/gapScenario as
    // pool-seeded inputs triggered F25 precondition-rejection at /recommend,
    // because the autonomous dispatch path cannot seed those impulses. Asserting
    // them here is what went stale — do not reintroduce them.
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.inputShapes).toEqual([]);
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.outputShapes).toContain("activityTemplateProposal");
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.outputShapes).toContain("activityTemplateVariant");
  });

  it("keeps the load -> draft -> register spine in order", () => {
    // Pinned as RELATIVE order, not an exact task count. The previous form asserted
    // exactly 6 tasks and broke on every legitimate addition (the template now has
    // 20), which is why it sat red and unread for months. The durable contract is
    // that inputs are read before the draft, and the variant is registered after it.
    const ids = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.map((t) => t.id);
    for (const required of [
      "read_report",
      "read_scenario",
      "draft_via_llm",
      "write_proposal",
      "register_variant",
    ]) {
      expect(ids).toContain(required);
    }
    expect(ids.indexOf("read_report")).toBeLessThan(ids.indexOf("draft_via_llm"));
    expect(ids.indexOf("read_scenario")).toBeLessThan(ids.indexOf("draft_via_llm"));
    expect(ids.indexOf("draft_via_llm")).toBeLessThan(ids.indexOf("write_proposal"));
    expect(ids.indexOf("write_proposal")).toBeLessThan(ids.indexOf("register_variant"));
  });

  it("read_report uses fs_read resolver with report_path variable", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "read_report")!;
    expect(task.resolver).toBe("fs_read");
    expect(JSON.stringify(task.config)).toContain("{{report_path}}");
  });

  it("read_scenario uses fs_read resolver with scenario_id variable", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "read_scenario")!;
    expect(task.resolver).toBe("fs_read");
    expect(JSON.stringify(task.config)).toContain("{{scenario_id}}");
  });

  it("draft_via_llm uses llm_completion_dispatch resolver", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "draft_via_llm")!;
    expect(task.resolver).toBe("llm_completion_dispatch");
    const config = task.config as { type: string; prompt: string; system_prompt?: string };
    expect(config.type).toBe("llm_completion_dispatch");
    expect(typeof config.prompt).toBe("string");
    expect(config.prompt.length).toBeGreaterThan(0);
  });

  it("write_proposal uses fs_write and embeds authored_by=make_activity_autonomous", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "write_proposal")!;
    expect(task.resolver).toBe("fs_write");
    const content = JSON.stringify(task.config);
    expect(content).toContain("make_activity_autonomous");
    expect(content).toContain("{{scenario_id}}");
  });

  it("register_variant uses activity_create_variant resolver", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "register_variant")!;
    expect(task.resolver).toBe("activity_create_variant");
  });

  it("extract_required_shapes uses json_path_extract targeting output_shapes_must_include", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "extract_required_shapes")!;
    expect(task.resolver).toBe("json_path_extract");
    const content = JSON.stringify(task.config);
    expect(content).toContain("output_shapes_must_include");
    expect(content).toContain("{{read_scenario_content}}");
  });

  it("register_variant declares the HONEST literal output shape, not the gap's shape", () => {
    // INVERTED deliberately (V25/V37). This test used to require that
    // output_shapes_override interpolate {{extract_required_shapes}}, i.e. stamp the
    // gap's expected shape onto the variant. That made declared != produced: the
    // variant's analyze task emits patch_proposal, so the reachability gate rejected
    // it and beta-penalised the whole draft even though the proposal file succeeded.
    // The override is now a literal ["patch_proposal"]. Asserting the old form would
    // reintroduce a known, fixed defect — so assert its ABSENCE.
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "register_variant")!;
    const content = JSON.stringify(task.config);
    expect(content).toContain("output_shapes_override");
    expect(content).toContain("patch_proposal");
    expect(content).not.toContain("{{extract_required_shapes}}");
  });

  it("all resolvers are known dev-vessel shapes or declared resolver names", () => {
    const knownResolvers = new Set([
      "fs_read", "fs_write", "fs_edit",
      "git_status", "git_diff", "git_log", "git_add", "git_commit",
      "activity_fetch", "activity_create_variant",
      "llm_completion_dispatch", "json_path_extract",
      // http_fetch drives the substrate-priming tasks (prime_substrate_concepts/edges,
      // fetch_prior_failures, fetch_prior_successes) — they POST to dev-vessel /resolve.
      "http_fetch",
      // registered dev-vessel resolver shapes used by the drafter's learning tasks
      "convergent_validity_check", "credit_primed_concepts",
    ]);
    for (const task of DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks) {
      expect(knownResolvers.has(task.resolver)).toBe(true);
    }
  });

  it("has the autonomous_loop tag", () => {
    const tags = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tags ?? [];
    const hasAutonomousTag = tags.some((t) => t.includes("autonomous.loop") || t.includes("autonomous_loop"));
    expect(hasAutonomousTag).toBe(true);
  });
});
