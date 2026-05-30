import { describe, it, expect } from "bun:test";
import { INGEST_DOC_AS_CONCEPTS_TEMPLATE } from "../../src/seed/ingest-doc-as-concepts.js";

describe("INGEST_DOC_AS_CONCEPTS_TEMPLATE", () => {
  it("has required top-level fields", () => {
    expect(INGEST_DOC_AS_CONCEPTS_TEMPLATE.id).toBe(
      "development-vessel:ingest-doc-as-concepts",
    );
    expect(INGEST_DOC_AS_CONCEPTS_TEMPLATE.name).toBe("ingest-doc-as-concepts");
    expect(typeof INGEST_DOC_AS_CONCEPTS_TEMPLATE.description).toBe("string");
  });

  it("declares empty input shapes (doc_path is a variable) and section-array output", () => {
    expect(INGEST_DOC_AS_CONCEPTS_TEMPLATE.inputShapes).toEqual([]);
    expect(INGEST_DOC_AS_CONCEPTS_TEMPLATE.outputShapes).toContain(
      "draftedSectionArray",
    );
  });

  it("declares the doc_path and out_path variables", () => {
    const names = (INGEST_DOC_AS_CONCEPTS_TEMPLATE.variables ?? []).map(
      (v) => v.name,
    );
    expect(names).toContain("doc_path");
    expect(names).toContain("out_path");
  });

  it("task graph has read_doc → extract_sections → write_sections", () => {
    const ids = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual(["read_doc", "extract_sections", "write_sections"]);
  });

  it("read_doc uses fs_read with {{doc_path}}", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "read_doc",
    )!;
    expect(t.resolver).toBe("fs_read");
    expect(JSON.stringify(t.config)).toContain("{{doc_path}}");
  });

  it("extract_sections is an LLM dispatch with haiku model and signature-stamping prompt", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "extract_sections",
    )!;
    expect(t.resolver).toBe("llm_completion_dispatch");
    const config = t.config as { model: string; prompt: string };
    expect(config.model).toContain("haiku");
    expect(config.prompt).toContain("{{read_doc_content}}");
    expect(config.prompt).toContain("JSON array");
    expect(config.prompt).toContain("signature");
    expect(config.prompt).toContain("heading_slug");
    expect(config.prompt).toContain("ingest_source");
    expect(config.prompt).toContain("30");
  });

  it("write_sections writes the LLM output text to the out_path variable", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "write_sections",
    )!;
    expect(t.resolver).toBe("fs_write");
    const config = t.config as { path: string; content: string };
    expect(config.path).toBe("{{out_path}}");
    expect(config.content).toBe("{{extract_sections_text}}");
  });

  it("all resolvers are in the autonomous palette", () => {
    const palette = new Set([
      "fs_read",
      "fs_write",
      "http_fetch",
      "llm_completion_dispatch",
      "json_path_extract",
    ]);
    for (const t of INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks) {
      expect(palette.has(t.resolver)).toBe(true);
    }
  });

  it("carries the substrate.knowledge.accumulation tag family", () => {
    const tags = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tags ?? [];
    expect(tags).toContain("concept.ingest");
    expect(tags).toContain("doc.ingest");
  });
});
