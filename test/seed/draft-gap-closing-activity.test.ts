import { describe, it, expect } from "bun:test";
import { DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE } from "../../src/seed/draft-gap-closing-activity.js";

describe("DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.id).toContain("draft-gap-closing-activity");
    expect(typeof DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.name).toBe("string");
    expect(typeof DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.description).toBe("string");
  });

  it("declares correct input and output shapes", () => {
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.inputShapes).toContain("failureModeReport");
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.inputShapes).toContain("gapScenario");
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.outputShapes).toContain("activityTemplateProposal");
    expect(DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.outputShapes).toContain("activityTemplateVariant");
  });

  it("has exactly 6 tasks in the correct order", () => {
    const tasks = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks;
    expect(tasks).toHaveLength(6);

    const ids = tasks.map((t) => t.id);
    expect(ids).toEqual([
      "read_report",
      "read_scenario",
      "draft_via_llm",
      "extract_required_shapes",
      "write_proposal",
      "register_variant",
    ]);
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

  it("register_variant passes output_shapes_override from extract_required_shapes", () => {
    const task = DRAFT_GAP_CLOSING_ACTIVITY_TEMPLATE.tasks.find((t) => t.id === "register_variant")!;
    const content = JSON.stringify(task.config);
    expect(content).toContain("output_shapes_override");
    expect(content).toContain("extract_required_shapes");
  });

  it("all resolvers are known dev-vessel shapes or declared resolver names", () => {
    const knownResolvers = new Set([
      "fs_read", "fs_write", "fs_edit",
      "git_status", "git_diff", "git_log", "git_add", "git_commit",
      "activity_fetch", "activity_create_variant",
      "llm_completion_dispatch", "json_path_extract",
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
