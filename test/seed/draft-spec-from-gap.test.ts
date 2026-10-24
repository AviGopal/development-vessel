import { describe, it, expect } from "bun:test";
import { DRAFT_SPEC_FROM_GAP_TEMPLATE, EXEMPLAR_CHANGE_DIR, EXEMPLAR_PROPOSAL_HEADINGS } from "../../src/seed/draft-spec-from-gap.js";

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

  it("keeps the 10 spec-drafting tasks, in order, as its opening sequence", () => {
    const tasks = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks;
    // Was `toHaveLength(10)` plus an exact id list. The template has since been EXTENDED with
    // five appended tasks (draft_substrate_learning -> mint_substrate_learning_concept) that
    // mint a learning concept after the spec is written; the original ten are untouched and
    // still first. Pinning the total made a purely additive extension read as a break, which
    // taxes exactly the kind of change this template is supposed to accumulate.
    // Assert the CORE SEQUENCE as a prefix — that is the contract — and allow growth after it.
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(tasks.slice(0, 10).map((t) => t.id)).toEqual([
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

  it("read_exemplar_proposal / read_exemplar_tasks read the in-place-image-convergence change", () => {
    const proposal = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "read_exemplar_proposal")!;
    const tasks = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "read_exemplar_tasks")!;
    expect(proposal.resolver).toBe("fs_read");
    expect(tasks.resolver).toBe("fs_read");
    expect(EXEMPLAR_CHANGE_DIR).toBe("/workspace/git/super-repo/openspec/changes/in-place-image-convergence");
    expect((proposal.config as { path: string }).path).toBe(`${EXEMPLAR_CHANGE_DIR}/proposal.md`);
    expect((tasks.config as { path: string }).path).toBe(`${EXEMPLAR_CHANGE_DIR}/tasks.md`);
  });

  it("the described proposal skeleton is the exemplar's headings, and the old one is gone", () => {
    // The exemplar proposal.md's headings, in order (openspec/changes/in-place-image-convergence/proposal.md).
    expect([...EXEMPLAR_PROPOSAL_HEADINGS]).toEqual(["Why", "What Changes", "What This Does Not Change", "Impact"]);
    const read = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "read_exemplar_proposal")!;
    expect(read.description).toContain("Why / What Changes / What This Does Not Change / Impact");
    const prompt = (DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "draft_via_llm")!.config as { prompt: string }).prompt;
    const proposalReq = prompt.slice(prompt.indexOf('3. The "proposal_md"'), prompt.indexOf('4. The "tasks_md"'));
    const required = [...proposalReq.matchAll(/^ {3}## (.+)$/gm)].map((m) => m[1]);
    expect(required).toEqual([...EXEMPLAR_PROPOSAL_HEADINGS]);
    const described = JSON.stringify(DRAFT_SPEC_FROM_GAP_TEMPLATE);
    for (const old of ["Motivation", "Out of Scope", "Success Criteria", "References", "failure-mode-autonomous-loop"]) {
      expect(described).not.toContain(old);
    }
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
    expect(config).toContain("substrate-authored-{{extract_slug_text}}");
    expect(config).toContain("proposal.md");
  });

  it("write_tasks writes the paired tasks.md", () => {
    const task = DRAFT_SPEC_FROM_GAP_TEMPLATE.tasks.find((t) => t.id === "write_tasks")!;
    expect(task.resolver).toBe("fs_write");
    const config = JSON.stringify(task.config);
    expect(config).toContain("tasks.md");
    expect(config).toContain("substrate-authored-{{extract_slug_text}}");
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
