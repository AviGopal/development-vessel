import { describe, it, expect } from "bun:test";
import { DRAFT_SPEC_FROM_GAP_TEMPLATE } from "../../src/seed/draft-spec-from-gap.js";

describe("DRAFT_SPEC_FROM_GAP_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(DRAFT_SPEC_FROM_GAP_TEMPLATE.id).toContain("draft-spec-from-gap");
    expect(typeof DRAFT_SPEC_FROM_GAP_TEMPLATE.name).toBe("string");
    expect(typeof DRAFT_SPEC_FROM_GAP_TEMPLATE.description).toBe("string");
  });

  it("declares input + output shapes", () => {
    expect(DRAFT_SPEC_FROM_GAP_TEMPLATE.inputShapes).toContain("substrateGapBatch");
    expect(DRAFT_SPEC_FROM_GAP_TEMPLATE.outputShapes).toContain("specProposal");
  });

  it("has exactly 10 tasks in the correct order", () => {
    const tasks = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks;
    expect(tasks).toHaveLength(10);
    expect(tasks.map((t) => t.id)).toEqual([
      "read_gaps",
      "read_priors",
      "read_exemplar_proposal",
      "read_exemplar_tasks",
      "draft_via_llm",
      "extract_slug",
      "extract_proposal_md",
      "extract_tasks_md",
      "write_proposal",
      "write_tasks",
    ]);
  });

  it("read_gaps targets concept-db /concepts/search with substrate_gap source_type", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "read_gaps")!;
    expect(task.resolver).toBe("http_fetch");
    const config = JSON.stringify(task.config);
    expect(config).toContain("source_type=substrate_gap");
    expect(config).toContain("{{gap_class}}");
  });

  it("read_exemplar_proposal reads the failure-mode-autonomous-loop proposal.md", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "read_exemplar_proposal")!;
    expect(task.resolver).toBe("fs_read");
    expect(JSON.stringify(task.config)).toContain("2026-05-22-failure-mode-autonomous-loop/proposal.md");
  });

  it("draft_via_llm prompt demands a JSON bundle with slug + proposal_md + tasks_md", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "draft_via_llm")!;
    expect(task.resolver).toBe("llm_completion_dispatch");
    const config = task.config as { prompt: string };
    expect(config.prompt).toContain("slug");
    expect(config.prompt).toContain("proposal_md");
    expect(config.prompt).toContain("tasks_md");
  });

  it("extract_slug / extract_proposal_md / extract_tasks_md use json_path_extract on the drafted JSON", () => {
    for (const id of ["extract_slug", "extract_proposal_md", "extract_tasks_md"]) {
      const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === id)!;
      expect(task.resolver).toBe("json_path_extract");
      const config = JSON.stringify(task.config);
      expect(config).toContain("{{draft_via_llm_text}}");
    }
  });

  it("write_proposal writes under openspec/changes/<date>-substrate-authored-<slug>/", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "write_proposal")!;
    expect(task.resolver).toBe("fs_write");
    const config = JSON.stringify(task.config);
    expect(config).toContain("openspec/changes/");
    expect(config).toContain("{{date}}");
    expect(config).toContain("substrate-authored-{{extract_slug_value}}");
    expect(config).toContain("proposal.md");
  });

  it("write_tasks writes the paired tasks.md", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "write_tasks")!;
    expect(task.resolver).toBe("fs_write");
    const config = JSON.stringify(task.config);
    expect(config).toContain("tasks.md");
    expect(config).toContain("substrate-authored-{{extract_slug_value}}");
  });

  it("all resolvers are known dev-vessel shapes", () => {
    const knownResolvers = new Set([
      "fs_read",
      "fs_write",
      "http_fetch",
      "llm_completion_dispatch",
      "json_path_extract",
    ]);
    for (const task of DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks) {
      expect(knownResolvers.has(task.resolver)).toBe(true);
    }
  });

  it("has the substrate.authored.openspec tag", () => {
    const tags = DRAFT_SPEC_FROM_GAP_TEMPLATE.tags ?? [];
    expect(tags.some((t) => t.includes("substrate.authored.openspec"))).toBe(true);
  });
});
