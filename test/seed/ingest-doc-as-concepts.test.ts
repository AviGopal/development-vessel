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

  it("task graph splits BEFORE the LLM call: read → split → parse → iter → write", () => {
    const ids = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.map((t) => t.id);
    expect(ids).toEqual([
      "read_doc",
      "split_sections",
      "parse_sections",
      "iter_extract",
      "write_sections",
    ]);
  });

  it("read_doc uses fs_read with {{doc_path}}", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "read_doc",
    )!;
    expect(t.resolver).toBe("fs_read");
    expect(JSON.stringify(t.config)).toContain("{{doc_path}}");
  });

  it("split_sections uses markdown_split_sections (deterministic, no LLM) with a section-char cap", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "split_sections",
    )!;
    expect(t.resolver).toBe("markdown_split_sections");
    const config = t.config as {
      type: string;
      content: string;
      doc_path: string;
      maxSectionChars: number;
    };
    expect(config.type).toBe("markdown_split_sections");
    expect(config.content).toBe("{{read_doc_content}}");
    expect(config.doc_path).toBe("{{doc_path}}");
    // Per-section payload cap: ≤3000 chars keeps the LLM call well under
    // any token budget (the whole point of this rewrite).
    expect(config.maxSectionChars).toBeLessThanOrEqual(3000);
  });

  it("parse_sections plucks the sections array via json_path_extract", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "parse_sections",
    )!;
    expect(t.resolver).toBe("json_path_extract");
    const config = t.config as { path: string };
    expect(config.path).toBe("sections");
  });

  it("iter_extract iterates per section and dispatches LLM ONCE PER SECTION (not over the whole doc)", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "iter_extract",
    )!;
    expect(t.resolver).toBe("iteration");
    const config = t.config as {
      over: string;
      elementVar: string;
      stopOnError: boolean;
      aggregateAs: string;
      body: { resolver: string; config: { prompt: string; model: string; max_tokens: number } };
    };
    expect(config.over).toBe("{{parse_sections_valueJson}}");
    expect(config.elementVar).toBe("candidate");
    expect(config.stopOnError).toBe(false);
    expect(config.aggregateAs).toBe("list");
    expect(config.body.resolver).toBe("llm_completion_dispatch");
    expect(config.body.config.model).toContain("haiku");
    // The per-section prompt must reference the candidate fields, NOT the
    // whole-doc placeholder that overflowed the prompt cap.
    expect(config.body.config.prompt).toContain("{{candidate.heading}}");
    expect(config.body.config.prompt).toContain("{{candidate.body_excerpt}}");
    expect(config.body.config.prompt).toContain("{{candidate.heading_slug}}");
    // Hard cap: per-section payloads stay tractable.
    expect(config.body.config.max_tokens).toBeLessThanOrEqual(2000);
    // The prompt MUST NOT pass the full doc.
    expect(config.body.config.prompt).not.toContain("{{read_doc_content}}");
  });

  it("per-section prompt enforces content discipline: atomic ideas, summary/body caps, mandatory pointer, banned shapes", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "iter_extract",
    )!;
    const prompt = (
      t.config as { body: { config: { prompt: string } } }
    ).body.config.prompt;
    // Atomic granularity
    expect(prompt).toMatch(/ONE ATOMIC IDEA|atomic/i);
    // Summary cap
    expect(prompt).toContain("80");
    // Body cap
    expect(prompt).toMatch(/200 words/i);
    // Mandatory pointer at top level
    expect(prompt).toContain("MANDATORY POINTER");
    expect(prompt).toMatch(/pointer.*type.*memo/i);
    expect(prompt).toMatch(/pointer.*path/i);
    // Banned shape names
    for (const banned of [
      "overview",
      "related",
      "key_files",
      "mcp_tools",
      "environment_variables",
      "before_push",
      "references",
    ]) {
      expect(prompt).toContain(banned);
    }
    // Good + bad examples present
    expect(prompt).toMatch(/GOOD EXAMPLE/);
    expect(prompt).toMatch(/BAD EXAMPLE/);
    // Signature stamping preserved for idempotency.
    expect(prompt).toContain("signature");
    expect(prompt).toContain("ingest_source");
  });

  it("write_sections writes the iter_extract aggregate to the out_path variable", () => {
    const t = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "write_sections",
    )!;
    expect(t.resolver).toBe("fs_write");
    const config = t.config as { path: string; content: string };
    expect(config.path).toBe("{{out_path}}");
    // Must consume the iteration's aggregate, NOT the legacy single-LLM
    // text placeholder.
    expect(config.content).toBe("{{iter_extract_valueJson}}");
  });

  it("all resolvers are in the autonomous palette (incl. the new markdown splitter)", () => {
    const palette = new Set([
      "fs_read",
      "fs_write",
      "http_fetch",
      "llm_completion_dispatch",
      "json_path_extract",
      "iteration",
      "markdown_split_sections",
    ]);
    for (const t of INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks) {
      expect(palette.has(t.resolver)).toBe(true);
    }
    // The iteration body resolver also must be palette-safe.
    const iter = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tasks.find(
      (x) => x.id === "iter_extract",
    )!;
    const innerResolver = (iter.config as { body: { resolver: string } }).body
      .resolver;
    expect(palette.has(innerResolver)).toBe(true);
  });

  it("carries the substrate.knowledge.accumulation tag family", () => {
    const tags = INGEST_DOC_AS_CONCEPTS_TEMPLATE.tags ?? [];
    expect(tags).toContain("concept.ingest");
    expect(tags).toContain("doc.ingest");
  });
});
